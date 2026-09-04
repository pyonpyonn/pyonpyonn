// SETUP: mkdir -p "lib" && code "lib/subscriptions.ts"
//
// Shared subscription logic — used by the Stripe webhook and the sync route.

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { seedAndStartOfferRotation } from "@/lib/offerRotation";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/** Work out who gets what from one monthly payment. */
export async function buildSplit(opts: {
  grossPence: number;
  cleans: number;
  cleanHours: number;
  massages: number;
}) {
  const { data: cfg } = await admin
    .from("split_config")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  const hourly = Number(cfg?.cleaner_hourly_rate ?? 15);
  const flat = Number(cfg?.therapist_flat_fee ?? 45);
  const marginPct = Number(cfg?.platform_margin_pct ?? 20);
  const membership = Number(cfg?.membership_fee_monthly ?? 30);

  const cleanerGross = opts.cleans * opts.cleanHours * hourly;
  const therapist = opts.massages * flat;
  const cleanerNet = Math.max(0, cleanerGross - membership);
  const gross = opts.grossPence / 100;
  const margin = Math.max(0, gross - cleanerNet - therapist - membership);

  return {
    gross,
    cleaner_gross: Number(cleanerGross.toFixed(2)),
    membership_fee: Number(membership.toFixed(2)),
    cleaner_net: Number(cleanerNet.toFixed(2)),
    therapist_fee: Number(therapist.toFixed(2)),
    platform_margin: Number(margin.toFixed(2)),
    platform_margin_pct_target: marginPct,
    rates: { cleaner_hourly: hourly, therapist_flat: flat },
  };
}

/** Create this cycle's visits and queue matching providers one at a time. */
export async function generateBookings(subId: string, cycleStart: Date) {
  const { data: sub } = await admin
    .from("subscriptions")
    .select(
      "id, customer_id, package_id, postcode, preferred_weekday, preferred_hour, paused_until, packages(name, visits_per_month, duration_minutes, service_type)"
    )
    .eq("id", subId)
    .maybeSingle();

  if (!sub) return { created: 0 };

  const pkg = Array.isArray(sub.packages) ? sub.packages[0] : sub.packages;
  const visits = pkg?.visits_per_month ?? 2;
  const gapDays = visits >= 4 ? 7 : 14;
  const hour = sub.preferred_hour ?? 10;

  // What each visit pays the provider, from the split spec.
  const { data: cfg } = await admin
    .from("split_config")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  const hourly = Number(cfg?.cleaner_hourly_rate ?? 15);
  const flat = Number(cfg?.therapist_flat_fee ?? 45);
  const membership = Number(cfg?.membership_fee_monthly ?? 30);

  const isMassage = (pkg?.service_type ?? "").includes("massage");
  const hours = (pkg?.duration_minutes ?? 120) / 60;
  const perVisit = isMassage ? flat : Number((hours * hourly).toFixed(2));

  const start = new Date(cycleStart);
  if (sub.preferred_weekday !== null && sub.preferred_weekday !== undefined) {
    let guard = 0;
    while (start.getDay() !== sub.preferred_weekday && guard < 8) {
      start.setDate(start.getDate() + 1);
      guard++;
    }
  }
  start.setHours(hour, 0, 0, 0);

  // Coverage lookup once
  const district = (sub.postcode ?? "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/\d[A-Z]{2}$/, "");

  const { data: areas } = await admin
    .from("service_areas")
    .select("id, postcode_prefixes")
    .eq("active", true);
  const areaIds = (areas ?? [])
    .filter((a) => (a.postcode_prefixes ?? []).includes(district))
    .map((a) => a.id);

  let provs: { id: string; profile_id: string }[] = [];
  if (areaIds.length) {
    const { data: links } = await admin
      .from("provider_service_areas")
      .select("provider_id")
      .in("service_area_id", areaIds);
    const ids = [...new Set((links ?? []).map((l) => l.provider_id))];
    if (ids.length) {
      const svcType = (pkg?.service_type ?? "cleaning").includes("massage")
        ? "cleaning"
        : "cleaning";
      const { data } = await admin
        .from("providers")
        .select("id, profile_id")
        .in("id", ids)
        .eq("vetting_status", "approved")
        .eq("joining_fee_paid", true)
        .contains("services", [svcType]);
      provs = data ?? [];
    }
  }

  let created = 0;
  let feeTaken = false;
  for (let i = 0; i < visits; i++) {
    const at = new Date(start);
    at.setDate(start.getDate() + i * gapDays);
    if (sub.paused_until && at <= new Date(sub.paused_until)) continue;

    // The monthly membership fee comes out of the first visit of the cycle.
    const deduct = feeTaken ? 0 : Math.min(membership, perVisit);
    const payout = Number((perVisit - deduct).toFixed(2));
    if (deduct > 0) feeTaken = true;

    const { data: booking } = await admin
      .from("bookings")
      .insert({
        customer_id: sub.customer_id,
        provider_id: null,
        package_id: sub.package_id,
        subscription_id: sub.id,
        scheduled_at: at.toISOString(),
        status: "offered",
        address: sub.postcode,
        provider_payout: payout,
        membership_fee_deducted: deduct,
        offer_expires_at: new Date(
          at.getTime() - 2 * 60 * 60 * 1000
        ).toISOString(),
      })
      .select("id")
      .single();

    if (!booking) continue;
    created++;

    await seedAndStartOfferRotation(
      admin,
      booking.id,
      provs.map((provider) => provider.id),
    );
  }

  return { created };
}

/**
 * Turn a Stripe subscription into our record, and optionally log the payment
 * and generate the cycle's visits. Safe to call repeatedly.
 */
export async function upsertSubscription(
  stripeSub: Stripe.Subscription,
  payment?: {
    amountPence: number;
    ref: string;
    periodStart?: string | null;
    periodEnd?: string | null;
  }
) {
  const m = stripeSub.metadata ?? {};
  const periodEnd = (stripeSub as { current_period_end?: number })
    .current_period_end;
  const nextBill = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;

  const { data: existing } = await admin
    .from("subscriptions")
    .select("id, cycles_billed")
    .eq("stripe_subscription_id", stripeSub.id)
    .maybeSingle();

  let ourId = existing?.id ?? null;

  if (!ourId) {
    const { data: created, error } = await admin
      .from("subscriptions")
      .insert({
        customer_id: m.customer_id || null,
        package_id: m.package_id || null,
        status: stripeSub.status === "active" ? "active" : "past_due",
        start_date: new Date().toISOString().slice(0, 10),
        contract_length_months: Number(m.contract_months ?? 3),
        stripe_subscription_id: stripeSub.id,
        stripe_customer_id: String(stripeSub.customer ?? ""),
        postcode: m.postcode || null,
        preferred_weekday: m.weekday ? Number(m.weekday) : null,
        preferred_hour: m.hour ? Number(m.hour) : null,
        cycles_billed: payment ? 1 : 0,
        current_period_end: nextBill,
      })
      .select("id")
      .single();

    if (error) console.error("Subscription insert failed:", error.message);
    ourId = created?.id ?? null;
  } else {
    await admin
      .from("subscriptions")
      .update({
        status: stripeSub.status === "active" ? "active" : "past_due",
        current_period_end: nextBill,
        ...(payment
          ? { cycles_billed: (existing?.cycles_billed ?? 0) + 1 }
          : {}),
      })
      .eq("id", ourId);
  }

  if (!ourId) return { id: null, created: 0, recorded: false };

  if (!payment) return { id: ourId, created: 0, recorded: false };

  // Already logged this payment?
  const { data: already } = await admin
    .from("payments")
    .select("id")
    .eq("stripe_payment_ref", payment.ref)
    .maybeSingle();

  if (already) return { id: ourId, created: 0, recorded: false };

  const { data: pkg } = await admin
    .from("packages")
    .select("name, visits_per_month, duration_minutes, includes_massage")
    .eq("id", m.package_id ?? "")
    .maybeSingle();

  const visits = pkg?.visits_per_month ?? 2;
  const hours = (pkg?.duration_minutes ?? 120) / 60;
  const massages = pkg?.includes_massage ? Math.max(1, visits / 2) : 0;

  const split = await buildSplit({
    grossPence: payment.amountPence,
    cleans: visits,
    cleanHours: hours,
    massages,
  });

  await admin.from("payments").insert({
    subscription_id: ourId,
    kind: "subscription",
    gross_amount: payment.amountPence / 100,
    split_breakdown: split,
    stripe_payment_ref: payment.ref,
    status: "succeeded",
    period_start: payment.periodStart ?? null,
    period_end: payment.periodEnd ?? null,
  });

  const gen = await generateBookings(ourId, new Date());

  if (m.customer_id) {
    await admin.from("notifications").insert({
      user_id: m.customer_id,
      title: "Your membership is active",
      body: `${pkg?.name ?? "Your plan"} — ${gen.created} visit${
        gen.created === 1 ? "" : "s"
      } scheduled. We're matching providers now.`,
      href: "/account/membership",
    });
  }

  return { id: ourId, created: gen.created, recorded: true };
}

export function invoicePeriod(invoice: Stripe.Invoice) {
  const period = invoice.lines?.data?.[0]?.period;
  return {
    periodStart: period?.start
      ? new Date(period.start * 1000).toISOString()
      : null,
    periodEnd: period?.end ? new Date(period.end * 1000).toISOString() : null,
  };
}

/** Pull the subscription id out of an invoice, whichever shape Stripe sends. */
export function subscriptionIdFromInvoice(invoice: unknown): string | null {
  const inv = invoice as {
    subscription?: string | { id: string };
    parent?: {
      subscription_details?: { subscription?: string | { id: string } };
    };
    lines?: {
      data?: Array<{
        parent?: {
          subscription_item_details?: { subscription?: string | { id: string } };
        };
        subscription?: string | { id: string };
      }>;
    };
  };

  const pick = (v: unknown) =>
    typeof v === "string" ? v : (v as { id?: string })?.id ?? null;

  return (
    pick(inv.subscription) ??
    pick(inv.parent?.subscription_details?.subscription) ??
    pick(inv.lines?.data?.[0]?.parent?.subscription_item_details?.subscription) ??
    pick(inv.lines?.data?.[0]?.subscription) ??
    null
  );
}

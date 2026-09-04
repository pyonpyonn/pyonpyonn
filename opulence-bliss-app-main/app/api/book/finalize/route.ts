import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { seedAndStartOfferRotation } from "@/lib/offerRotation";
import {
  APPOINTMENT_WINDOW_MESSAGE,
  appointmentFitsWindow,
} from "@/lib/appointmentWindow";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("session_id");
  const target = new URL("/book/success", req.nextUrl.origin);
  if (!sessionId) {
    target.searchParams.set("error", "missing_session");
    return NextResponse.redirect(target);
  }

  try {
    const ssr = await createServerClient();
    const { data: { user } } = await ssr.auth.getUser();
    if (!user) {
      const login = new URL("/login", req.nextUrl.origin);
      login.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search);
      return NextResponse.redirect(login);
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent"],
    });
    const pi = session.payment_intent as Stripe.PaymentIntent;
    const ok = pi.status === "requires_capture" || pi.status === "succeeded";
    if (!ok) {
      target.searchParams.set("session_id", sessionId);
      target.searchParams.set("error", "payment_not_authorised");
      return NextResponse.redirect(target);
    }

    const checkoutEmail = session.customer_details?.email?.toLowerCase();
    if (checkoutEmail && checkoutEmail !== user.email?.toLowerCase()) {
      return NextResponse.json({ error: "Checkout does not belong to this account" }, { status: 403 });
    }

    const { data: existing } = await admin
      .from("payments")
      .select("id")
      .eq("stripe_payment_ref", pi.id)
      .maybeSingle();
    if (!existing) {
      const m = pi.metadata ?? {};
      const packageId = m.package_id || null;
      const postcode = m.postcode || null;
      const request = m.request || null;
      const slot = m.slot || null;

      const { data: pkgRow } = await admin
        .from("packages")
        .select("service_type, duration_minutes")
        .eq("id", packageId ?? "")
        .maybeSingle();
      const serviceType = pkgRow?.service_type ?? null;
      if (!slot || !appointmentFitsWindow(slot, pkgRow?.duration_minutes ?? 120)) {
        throw new Error(APPOINTMENT_WINDOW_MESSAGE);
      }
      const compact = (postcode ?? "").toUpperCase().replace(/\s+/g, "");
      const district = compact.length > 4 ? compact.slice(0, compact.length - 3) : compact;

      const { data: allAreas } = await admin
        .from("service_areas")
        .select("id, postcode_prefixes")
        .eq("active", true);
      const areaIds = (allAreas ?? [])
        .filter((a) => (a.postcode_prefixes ?? []).includes(district))
        .map((a) => a.id);

      let candidateIds: string[] = [];
      if (areaIds.length) {
        const { data: links } = await admin
          .from("provider_service_areas")
          .select("provider_id")
          .in("service_area_id", areaIds);
        candidateIds = [...new Set((links ?? []).map((link) => link.provider_id))];
      }

      let matched: { id: string; profile_id: string }[] = [];
      if (candidateIds.length) {
        let query = admin
          .from("providers")
          .select("id, profile_id")
          .in("id", candidateIds)
          .eq("vetting_status", "approved")
          .eq("joining_fee_paid", true);
        if (serviceType) query = query.contains("services", [serviceType]);
        const { data } = await query;
        matched = data ?? [];
      }

      const slotTime = slot ? new Date(slot) : new Date();
      const expires = new Date(slotTime.getTime() - 2 * 60 * 60 * 1000);
      const { data: booking, error: bookingError } = await admin
        .from("bookings")
        .insert({
          customer_id: user.id,
          provider_id: null,
          package_id: packageId,
          scheduled_at: slot ?? new Date().toISOString(),
          status: "offered",
          address: postcode,
          customer_email: user.email ?? checkoutEmail ?? null,
          household_notes: request,
          offer_expires_at: expires.toISOString(),
        })
        .select("id")
        .single();
      if (bookingError || !booking) throw bookingError ?? new Error("Booking insert failed");

      await seedAndStartOfferRotation(
        admin,
        booking.id,
        matched.map((provider) => provider.id),
      );

      const total = pi.amount;
      const platform = pi.application_fee_amount ?? 0;
      const { error: paymentError } = await admin.from("payments").insert({
        booking_id: booking.id,
        gross_amount: total / 100,
        split_breakdown: {
          provider: (total - platform) / 100,
          platform_margin: platform / 100,
        },
        stripe_payment_ref: pi.id,
        status: pi.status === "succeeded" ? "succeeded" : "authorised",
      });
      if (paymentError) throw paymentError;

      await admin.from("notifications").insert({
        user_id: user.id,
        title: matched.length ? "Booking received" : "Looking for a provider",
        body: matched.length
          ? `${m.package || "Service"} — we're asking matching providers one at a time and will confirm as soon as one accepts.`
          : `${m.package || "Service"} — we'll keep looking and cancel free of charge if we can't fill it.`,
        href: "/account",
      });
    }

    target.searchParams.set("session_id", sessionId);
    target.searchParams.set("saved", "1");
    return NextResponse.redirect(target);
  } catch (error) {
    console.error("Booking finalisation failed:", error);
    target.searchParams.set("session_id", sessionId);
    target.searchParams.set("error", "finalize_failed");
    return NextResponse.redirect(target);
  }
}

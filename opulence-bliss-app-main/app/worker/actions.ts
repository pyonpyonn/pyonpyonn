"use server";

// Worker job actions. Save at: app/worker/actions.ts
// (If your server client lives under utils/, change the import.)

import { createClient } from "@/lib/supabase/server";
import { createClient as createAdmin } from "@supabase/supabase-js";
import Stripe from "stripe";
import { revalidatePath } from "next/cache";
import { sendEmail } from "@/lib/email";
import { rotateBookingOffer } from "@/lib/offerRotation";
import {
  claimMoneyOperation,
  maybeReleasePayout,
  systemFinaliseMoneyOperation,
  systemTransitionBooking,
  systemTransitionPayment,
  systemTransitionPayout,
  transitionBooking,
} from "@/lib/bookingState";

// How close a provider must be to count as "on site".
const GEOFENCE_METRES = 500;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// Service role — needed because providers can't read the payments table.
const admin = createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Write a notification for someone (service role — bypasses RLS).
async function notify(
  userId: string | null | undefined,
  title: string,
  body: string,
  href: string,
) {
  if (!userId) return;
  await admin.from("notifications").insert({
    user_id: userId,
    title,
    body,
    href,
  });
}

// Who's the customer on this booking, and what service?
async function bookingContext(id: string) {
  const { data } = await admin
    .from("bookings")
    .select(
      "customer_id, customer_email, address, scheduled_at, packages(name)",
    )
    .eq("id", id)
    .maybeSingle();
  const p = data?.packages as { name: string } | { name: string }[] | null;
  const name = (Array.isArray(p) ? p[0]?.name : p?.name) ?? "your booking";
  return {
    customerId: data?.customer_id ?? null,
    email: data?.customer_email ?? null,
    address: data?.address ?? null,
    scheduledAt: data?.scheduled_at ?? null,
    service: name,
  };
}

// Pull a UK postcode out of whatever's stored in the address.
function extractPostcode(s: string | null) {
  if (!s) return null;
  const up = s.toUpperCase().replace(/\s+/g, " ").trim();
  const full = up.match(/[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/);
  if (full) return full[0];
  const out = up.match(/^[A-Z]{1,2}\d[A-Z\d]?$/);
  return out ? out[0] : up;
}

// Turn a UK postcode into coordinates (postcodes.io, free, no key).
// Tries the full postcode, then falls back to the district (outcode).
async function geocode(raw: string | null) {
  const pc = extractPostcode(raw);
  if (!pc) return null;

  try {
    const res = await fetch(
      `https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`,
      { cache: "no-store" },
    );
    if (res.ok) {
      const j = await res.json();
      if (typeof j?.result?.latitude === "number") {
        return { lat: j.result.latitude, lng: j.result.longitude as number };
      }
    }
  } catch {
    /* fall through to outcode */
  }

  // District only, e.g. "SW3"
  const outcode = pc.split(" ")[0];
  try {
    const res = await fetch(
      `https://api.postcodes.io/outcodes/${encodeURIComponent(outcode)}`,
      { cache: "no-store" },
    );
    if (res.ok) {
      const j = await res.json();
      if (typeof j?.result?.latitude === "number") {
        return { lat: j.result.latitude, lng: j.result.longitude as number };
      }
    }
  } catch {
    /* give up */
  }

  return null;
}

// Straight-line distance in metres.
function metresBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

export async function acceptJob(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { data: me } = await supabase
    .from("providers")
    .select("id")
    .eq("profile_id", user.id)
    .maybeSingle();
  if (!me) return { error: "Not a provider" };

  try {
    await transitionBooking(supabase, id, "scheduled");
  } catch {
    revalidatePath("/worker");
    return { taken: true };
  }

  const { customerId, service, email, scheduledAt } = await bookingContext(id);
  await notify(
    customerId,
    "Your provider is confirmed",
    `${service} — a vetted provider has accepted your booking.`,
    "/account",
  );
  await sendEmail({
    to: email,
    subject: "Your booking is confirmed",
    title: "Your provider is confirmed",
    body: `<p>Good news — a vetted provider has accepted your <strong>${service}</strong> booking${
      scheduledAt
        ? ` for ${new Date(scheduledAt).toLocaleString("en-GB", {
            weekday: "long",
            day: "numeric",
            month: "long",
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          })}`
        : ""
    }.</p><p>You'll only be charged once the visit is complete.</p>`,
    cta: { text: "View your booking", url: "/account" },
  });

  revalidatePath("/worker");
  revalidatePath("/account");
  return { ok: true };
}

// Decline just removes THIS provider — the job stays open for the others.
export async function declineJob(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const { data: me } = await supabase
    .from("providers")
    .select("id")
    .eq("profile_id", user.id)
    .maybeSingle();
  if (!me) return;

  await supabase
    .from("booking_offers")
    .update({ status: "declined" })
    .eq("booking_id", id)
    .eq("provider_id", me.id);

  await rotateBookingOffer(admin, id).catch((error) => {
    console.error("Could not advance declined offer:", error);
  });

  revalidatePath("/worker");
}

// Arrived at the customer's home — work starts.
// Optionally verified against the booking's postcode by GPS.
export async function checkInJob(
  id: string,
  lat?: number | null,
  lng?: number | null,
  force = false,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      blocked: true,
      pass: null,
      distance: null,
      reason: "Please sign in again before checking in.",
      canForce: false,
    };
  }
  const ctx = await bookingContext(id);

  // You can only check in on the day of the visit, from 30 minutes before.
  //
  // Development shortcuts require Stripe test mode. Skipping the time window
  // additionally needs ALLOW_EARLY_CHECKIN=true; a failed geofence can be
  // forced only while no real money is enabled.
  const testPayments = (process.env.STRIPE_SECRET_KEY ?? "").startsWith(
    "sk_test_",
  );
  const allowEarly = process.env.ALLOW_EARLY_CHECKIN === "true" && testPayments;

  if (ctx.scheduledAt && !allowEarly && !(force && testPayments)) {
    const start = new Date(ctx.scheduledAt);
    const openFrom = new Date(start.getTime() - 30 * 60 * 1000);
    const endOfDay = new Date(start);
    endOfDay.setHours(23, 59, 59, 999);
    const now = new Date();

    if (now < openFrom) {
      const when = start.toLocaleString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
      return {
        blocked: true,
        pass: null,
        distance: null,
        reason: `Too early — this visit is ${when}. You can check in from 30 minutes before it starts.`,
        canForce: testPayments,
      };
    }
    if (now > endOfDay) {
      return {
        blocked: true,
        pass: null,
        distance: null,
        reason:
          "This visit's day has passed. Contact the team so we can sort it out.",
        canForce: testPayments,
      };
    }
  }

  // Geofence check: is the provider actually near the address?
  let pass: boolean | null = null;
  let distance: number | null = null;
  let reason = "";
  const pc = extractPostcode(ctx.address);

  if (typeof lat !== "number" || typeof lng !== "number") {
    reason =
      "Location not shared, so we can't confirm you're at the address. Allow location access in your browser and try again.";
  } else {
    const target = await geocode(ctx.address);
    if (!target) {
      reason = `Couldn't look up the booking address (${
        pc ?? "none saved"
      }), so your location can't be confirmed.`;
    } else {
      distance = metresBetween({ lat, lng }, target);
      pass = distance <= GEOFENCE_METRES;
      reason = pass
        ? `Location confirmed — you're ${distance}m from ${pc}.`
        : `You're about ${distance}m from ${pc} — too far to check in (limit ${GEOFENCE_METRES}m).`;
    }
  }

  // Only check in if we could positively confirm the location. Development
  // may force the path so checkout/payment can be exercised from a desk, but
  // the server—not the button—decides whether that bypass exists.
  if (pass !== true) {
    if (!force) {
      return { blocked: true, pass, distance, reason, canForce: testPayments };
    }
    if (!testPayments) {
      return {
        blocked: true,
        pass,
        distance,
        reason:
          "Location could not be confirmed. Development bypass is disabled.",
        canForce: false,
      };
    }
  }

  // Development may bypass the clock/geofence so the flow can be exercised
  // from a desk, but it must never bypass the customer's OTP. Otherwise the
  // exact path that needs testing is skipped.
  if (force && testPayments) {
    reason = "Development location bypass accepted.";
  }

  const { data: challengeData, error: challengeError } = await admin.rpc(
    "request_checkin_challenge",
    {
      p_booking_id: id,
      p_provider_profile_id: user.id,
      p_gps_lat: lat,
      p_gps_lng: lng,
      p_distance_metres: distance,
    },
  );

  if (challengeError) {
    return {
      blocked: true,
      pass,
      distance,
      reason: challengeError.message,
      canForce: testPayments,
    };
  }

  const challenge = challengeData as {
    challenge_id: string;
    expires_at: string;
    newly_created: boolean;
    locked?: boolean;
  };

  if (challenge.locked) {
    return {
      blocked: true,
      pass,
      distance,
      reason:
        "Too many incorrect codes. Wait for this code to expire, then request a new one.",
      canForce: testPayments,
    };
  }

  if (challenge.newly_created) {
    const { data: deliveryData, error: deliveryError } = await admin.rpc(
      "system_get_checkin_code",
      { p_challenge_id: challenge.challenge_id },
    );

    if (deliveryError) {
      return {
        blocked: true,
        pass,
        distance,
        reason: `Location passed, but the code could not be delivered: ${deliveryError.message}`,
        canForce: testPayments,
      };
    }

    const delivery = deliveryData as {
      code: string;
      customer_id: string | null;
      customer_email: string | null;
      service: string;
    };

    await Promise.allSettled([
      notify(
        delivery.customer_id,
        `Check-in code: ${delivery.code}`,
        `Share this six-digit code with your provider at the door. It expires in 10 minutes.`,
        `/account/visit/${id}`,
      ),
      sendEmail({
        to: delivery.customer_email,
        subject: `Your check-in code is ${delivery.code}`,
        title: "Your provider is at the door",
        body: `<p>Share this code with your provider to start <strong>${delivery.service}</strong>:</p><p style="font-size:32px;font-weight:800;letter-spacing:8px">${delivery.code}</p><p>It expires in 10 minutes. Only share it when your provider is with you.</p>`,
        cta: { text: "View your visit", url: `/account/visit/${id}` },
      }),
    ]);
  }

  return {
    blocked: false,
    pass,
    distance,
    reason: challenge.newly_created
      ? `${reason} A six-digit code was sent to the client.`
      : `${reason} The client's existing code is still active.`,
    canForce: false,
    otpRequired: true,
    expiresAt: challenge.expires_at,
  };
}

export async function verifyCheckInOtp(id: string, code: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("verify_checkin_challenge", {
    p_booking_id: id,
    p_code: code.replace(/\D/g, "").slice(0, 6),
  });

  if (error) return { ok: false, reason: error.message };
  const result = data as { ok: boolean; reason: string };
  if (!result.ok) return result;

  const ctx = await bookingContext(id);
  await Promise.allSettled([
    notify(
      ctx.customerId,
      "Check-in confirmed",
      `${ctx.service} has started.`,
      `/account/visit/${id}`,
    ),
    sendEmail({
      to: ctx.email,
      subject: "Your visit has started",
      title: "Check-in confirmed",
      body: `<p>Your code was confirmed and <strong>${ctx.service}</strong> is now in progress.</p>`,
      cta: { text: "View your visit", url: `/account/visit/${id}` },
    }),
  ]);

  revalidatePath("/worker");
  revalidatePath("/worker/current");
  revalidatePath(`/worker/job/${id}`);
  revalidatePath("/account");
  revalidatePath(`/account/visit/${id}`);
  return result;
}

// Job finished — complete it AND settle the money.
export async function checkOutJob(id: string) {
  const supabase = await createClient();
  await transitionBooking(supabase, id, "completed");

  await supabase
    .from("check_ins")
    .update({ left_at: new Date().toISOString() })
    .eq("booking_id", id)
    .is("left_at", null);

  // Is this a one-off visit or part of a membership?
  const { data: bk } = await admin
    .from("bookings")
    .select(
      "subscription_id, provider_id, provider_payout, membership_fee_deducted",
    )
    .eq("id", id)
    .maybeSingle();

  let earned = 0;
  let paymentSettled = Boolean(bk?.subscription_id);

  if (bk?.subscription_id) {
    // Membership visit: create the durable payout in not_ready, then let the
    // database release it only when both work and covering funds are present.
    const payout = Number(bk.provider_payout ?? 0);
    earned = payout;

    const { data: existing } = await admin
      .from("payouts")
      .select("id, status")
      .eq("booking_id", id)
      .maybeSingle();

    let payoutId = existing?.id ?? null;
    if (!payoutId && payout > 0 && bk.provider_id) {
      const { data: created } = await admin
        .from("payouts")
        .insert({
          provider_id: bk.provider_id,
          booking_id: id,
          amount: payout,
          status: "not_ready",
          note:
            Number(bk.membership_fee_deducted ?? 0) > 0
              ? `Membership fee of £${Number(
                  bk.membership_fee_deducted,
                ).toFixed(2)} deducted`
              : null,
        })
        .select("id")
        .single();
      payoutId = created?.id ?? null;
    }

    if (payoutId && payout > 0 && bk.provider_id) {
      await maybeReleasePayout(admin, id);
      const { data: ready } = await admin
        .from("payouts")
        .select("status")
        .eq("id", payoutId)
        .maybeSingle();

      if (ready?.status === "pending") {
        const operationKey = `transfer:booking:${id}:provider:${bk.provider_id}`;
        const op = await claimMoneyOperation(admin, {
          operationKey,
          operationType: "transfer",
          bookingId: id,
          amount: payout,
        });

        if (op.should_run) {
          const { data: prov } = await admin
            .from("providers")
            .select("stripe_account_id")
            .eq("id", bk.provider_id)
            .maybeSingle();
          const destination =
            prov?.stripe_account_id ?? process.env.PROVIDER_TEST_ACCOUNT;

          if (!destination) {
            await systemTransitionPayout(admin, payoutId, "held", {
              reason: "Provider payout account is not configured",
            });
          } else {
            await systemTransitionPayout(admin, payoutId, "processing");
            let transfer: Stripe.Transfer | null = null;
            try {
              transfer = await stripe.transfers.create(
                {
                  amount: Math.round(payout * 100),
                  currency: "gbp",
                  destination,
                  metadata: {
                    booking_id: id,
                    kind: "membership_visit",
                    operation_key: operationKey,
                  },
                },
                { idempotencyKey: operationKey },
              );
            } catch (e) {
              const reason =
                e instanceof Error ? e.message : "Stripe transfer failed";
              const definite =
                e instanceof Stripe.errors.StripeInvalidRequestError;
              await systemFinaliseMoneyOperation(
                admin,
                op.id,
                definite ? "failed" : "ambiguous",
                { error: reason },
              );
              if (definite) {
                await systemTransitionPayout(admin, payoutId, "failed", {
                  reason,
                });
              }
            }

            if (transfer) {
              // Stripe's result is the durable fact. Record it before updating
              // local payout details so a later local failure cannot downgrade it.
              await systemFinaliseMoneyOperation(admin, op.id, "succeeded", {
                stripeObjectId: transfer.id,
              });
              const { error: referenceError } = await admin
                .from("payouts")
                .update({ stripe_transfer_ref: transfer.id })
                .eq("id", payoutId);
              if (referenceError) throw new Error(referenceError.message);
              await systemTransitionPayout(admin, payoutId, "paid");
            }
          }
        } else if (op.status === "succeeded") {
          await systemTransitionPayout(admin, payoutId, "processing");
          await systemTransitionPayout(admin, payoutId, "paid");
        }
      }
    }
  } else {
    // ---- One-off visit: capture the held payment; Stripe splits it.
    const { data: pays } = await admin
      .from("payments")
      .select("id, stripe_payment_ref, status, split_breakdown, gross_amount")
      .eq("booking_id", id)
      .limit(1);

    const pay = pays?.[0];
    if (
      pay?.stripe_payment_ref &&
      ["authorised", "capture_failed"].includes(pay.status)
    ) {
      earned = Number(
        (pay.split_breakdown as { provider?: number } | null)?.provider ?? 0,
      );
      const operationKey = `capture:booking:${id}`;
      await systemTransitionPayment(admin, pay.id, "capturing");
      const op = await claimMoneyOperation(admin, {
        operationKey,
        operationType: "capture",
        bookingId: id,
        amount: Number(pay.gross_amount ?? 0),
      });
      if (op.should_run) {
        let intent: Stripe.PaymentIntent | null = null;
        try {
          intent = await stripe.paymentIntents.capture(
            pay.stripe_payment_ref,
            {},
            { idempotencyKey: operationKey },
          );
        } catch (e) {
          const reason = e instanceof Error ? e.message : "Capture failed";
          const definite =
            e instanceof Stripe.errors.StripeCardError ||
            e instanceof Stripe.errors.StripeInvalidRequestError;
          await systemFinaliseMoneyOperation(
            admin,
            op.id,
            definite ? "failed" : "ambiguous",
            { error: reason },
          );
          if (definite) {
            await systemTransitionPayment(admin, pay.id, "capture_failed", {
              reason,
            });
          }
          await systemTransitionBooking(
            admin,
            id,
            "needs_review",
            "Payment capture failed after completion",
            { payment_id: pay.id, operation_id: op.id },
          );
          await admin.rpc("open_review_case", {
            p_booking_id: id,
            p_category: "payment_failure",
            p_priority: "urgent",
            p_blocks_payment: true,
            p_blocks_payout: true,
            p_notes: reason,
            p_created_by: null,
          });
        }

        if (intent) {
          await systemFinaliseMoneyOperation(admin, op.id, "succeeded", {
            stripeObjectId: intent.id,
          });
          await systemTransitionPayment(admin, pay.id, "succeeded");
          paymentSettled = true;
        }
      } else if (op.status === "ambiguous") {
        await systemTransitionBooking(
          admin,
          id,
          "needs_review",
          "Payment capture outcome is ambiguous",
          { payment_id: pay.id, operation_id: op.id },
        );
        await admin.rpc("open_review_case", {
          p_booking_id: id,
          p_category: "payment_failure",
          p_priority: "urgent",
          p_blocks_payment: true,
          p_blocks_payout: true,
          p_notes: "Capture outcome is ambiguous; reconciliation required",
          p_created_by: null,
        });
      } else if (op.status === "succeeded") {
        await systemTransitionPayment(admin, pay.id, "succeeded");
        paymentSettled = true;
      }
    } else if (pay?.status === "succeeded") {
      paymentSettled = true;
      earned = Number(
        (pay.split_breakdown as { provider?: number } | null)?.provider ?? 0,
      );
    }
  }

  const { customerId, service, email } = await bookingContext(id);
  await notify(
    customerId,
    paymentSettled
      ? "Visit completed"
      : "Visit completed — payment under review",
    bk?.subscription_id
      ? `${service} — all done. This visit is covered by your membership.`
      : paymentSettled
        ? `${service} — all done. Your card has now been charged.`
        : `${service} — all done. We are checking the payment and you do not need to retry anything.`,
    "/account",
  );
  await sendEmail({
    to: email,
    subject: paymentSettled
      ? "Your visit is complete"
      : "Your visit is complete — payment under review",
    title: "All done",
    body: bk?.subscription_id
      ? `<p>Your <strong>${service}</strong> is complete and covered by your membership.</p>
         <p>If you have a moment, we'd love a quick rating for your provider.</p>`
      : paymentSettled
        ? `<p>Your <strong>${service}</strong> is complete and your card has now been charged.</p>
           <p>If you have a moment, we'd love a quick rating for your provider.</p>`
        : `<p>Your <strong>${service}</strong> is complete, but its payment needs a manual check.</p>
           <p>You do not need to pay or retry anything. The team will review it.</p>`,
    cta: { text: "Rate your visit", url: "/account" },
  });

  revalidatePath("/worker");
  revalidatePath("/account");
  return { earned };
}
export async function markAllRead() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  await supabase
    .from("notifications")
    .update({ read: true })
    .eq("user_id", user.id)
    .eq("read", false);
  revalidatePath("/notifications");
}

// Provider rates the client after a completed visit.
export async function rateClient(id: string, rating: number, comment: string) {
  const supabase = await createClient();
  const clean = Math.min(5, Math.max(1, Math.round(rating)));

  const { error } = await supabase.from("reviews").insert({
    booking_id: id,
    reviewer: "provider",
    rating: clean,
    comment: comment?.trim() ? comment.trim() : null,
  });

  if (!error) {
    const ctx = await bookingContext(id);
    await notify(
      ctx.customerId,
      `Your provider rated you ${clean} stars`,
      comment?.trim()
        ? comment.trim().slice(0, 120)
        : "Thanks for having them.",
      "/account",
    );
  }

  revalidatePath("/worker");
  return { error: error?.message ?? null };
}

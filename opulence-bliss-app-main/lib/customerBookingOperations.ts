import "server-only";

import { revalidatePath } from "next/cache";
import { createClient as createAdmin } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import {
  claimMoneyOperation,
  modifyCustomerBookingState,
  systemFinaliseMoneyOperation,
  systemTransitionPayment,
  transitionBooking,
} from "@/lib/bookingState";
import {
  APPOINTMENT_WINDOW_MESSAGE,
  appointmentFitsWindow,
} from "@/lib/appointmentWindow";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const admin = createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function notifyBookingProvider(
  bookingId: string,
  title: string,
  body: string,
) {
  const { data: booking } = await admin
    .from("bookings")
    .select("provider_id")
    .eq("id", bookingId)
    .maybeSingle();

  let providerId = booking?.provider_id ?? null;
  if (!providerId) {
    const { data: offer } = await admin
      .from("booking_offers")
      .select("provider_id")
      .eq("booking_id", bookingId)
      .in("status", ["accepted", "open"])
      .limit(1)
      .maybeSingle();
    providerId = offer?.provider_id ?? null;
  }
  if (!providerId) return;

  const { data: provider } = await admin
    .from("providers")
    .select("profile_id")
    .eq("id", providerId)
    .maybeSingle();
  if (!provider?.profile_id) return;

  await admin.from("notifications").insert({
    user_id: provider.profile_id,
    title,
    body,
    href: "/worker",
  });
}

async function notifyBookingChangeAudience(
  bookingId: string,
  title: string,
  body: string,
) {
  const { data: booking } = await admin
    .from("bookings")
    .select("customer_id, provider_id")
    .eq("id", bookingId)
    .maybeSingle();

  const recipients = new Map<string, string>();
  if (booking?.customer_id) {
    recipients.set(booking.customer_id, `/account/visit/${bookingId}`);
  }

  if (booking?.provider_id) {
    const { data: provider } = await admin
      .from("providers")
      .select("profile_id")
      .eq("id", booking.provider_id)
      .maybeSingle();
    if (provider?.profile_id) {
      recipients.set(provider.profile_id, `/worker/job/${bookingId}`);
    }
  }

  const { data: admins } = await admin
    .from("profiles")
    .select("id")
    .eq("role", "admin");
  for (const profile of admins ?? []) {
    recipients.set(profile.id, "/admin/bookings");
  }

  if (!recipients.size) return;
  await admin.from("notifications").insert(
    [...recipients].map(([userId, href]) => ({
      user_id: userId,
      title,
      body,
      href,
    })),
  );
}

/**
 * Cancel through the same booking/payment state machines regardless of which
 * interface initiated it. The supplied client must carry the customer's JWT;
 * transition_booking derives the actor and enforces ownership in PostgreSQL.
 */
export async function cancelCustomerBooking(
  supabase: SupabaseClient,
  id: string,
  reason?: string,
  source: "account" | "assistant" = "account",
) {
  const cleanReason = reason?.trim().slice(0, 240) || null;
  await transitionBooking(supabase, id, "cancelled", {
    reason: cleanReason
      ? `Customer cancelled: ${cleanReason}`
      : "Customer cancelled the booking",
    meta: {
      source,
      ...(cleanReason ? { cancellation_reason: cleanReason } : {}),
    },
  });

  const { data: payments } = await admin
    .from("payments")
    .select("id, stripe_payment_ref, status, gross_amount")
    .eq("booking_id", id)
    .limit(1);

  const payment = payments?.[0];
  if (payment?.stripe_payment_ref) {
    const refunding = payment.status === "succeeded";
    const operationKey = refunding
      ? `refund:booking:${id}:full`
      : `release:booking:${id}`;

    try {
      if (refunding) {
        await systemTransitionPayment(admin, payment.id, "refund_pending", {
          reason: "Customer cancelled the booking",
        });
      } else {
        await systemTransitionPayment(admin, payment.id, "cancelling");
      }

      const operation = await claimMoneyOperation(admin, {
        operationKey,
        operationType: refunding ? "refund" : "release",
        bookingId: id,
        amount: Number(payment.gross_amount ?? 0),
      });

      if (operation.should_run) {
        const stripeObject = refunding
          ? await stripe.refunds.create(
              {
                payment_intent: payment.stripe_payment_ref,
                metadata: { operation_key: operationKey, booking_id: id },
              },
              { idempotencyKey: operationKey },
            )
          : await stripe.paymentIntents.cancel(
              payment.stripe_payment_ref,
              {},
              { idempotencyKey: operationKey },
            );

        await systemFinaliseMoneyOperation(admin, operation.id, "succeeded", {
          stripeObjectId: stripeObject.id,
        });
        await systemTransitionPayment(
          admin,
          payment.id,
          refunding ? "refunded" : "cancelled",
        );
      } else if (operation.status === "succeeded") {
        await systemTransitionPayment(
          admin,
          payment.id,
          refunding ? "refunded" : "cancelled",
        );
      } else if (operation.status === "ambiguous") {
        throw new Error("Stripe outcome is ambiguous; reconciliation required");
      }
    } catch (error) {
      const failure =
        error instanceof Error ? error.message : "Stripe cancellation failed";
      const fallback = refunding ? "succeeded" : "authorised";
      await systemTransitionPayment(admin, payment.id, fallback, {
        reason: failure,
      }).catch(() => undefined);
      await admin.rpc("open_review_case", {
        p_booking_id: id,
        p_category: "payment_failure",
        p_priority: "high",
        p_blocks_payment: true,
        p_blocks_payout: true,
        p_notes: failure,
        p_created_by: null,
      });
    }
  }

  await notifyBookingProvider(
    id,
    "Booking cancelled",
    "The customer cancelled this visit. It's been removed from your schedule.",
  );

  revalidatePath("/account");
  revalidatePath(`/account/visit/${id}`);
  revalidatePath("/worker");

  return {
    ok: true as const,
    message:
      payment?.status === "succeeded"
        ? "Booking cancelled. Your refund has been started."
        : "Booking cancelled. Your card hold is being released.",
  };
}

export async function rescheduleCustomerBooking(
  supabase: SupabaseClient,
  id: string,
  newSlot: string,
  reason?: string,
  note?: string,
  source: "account" | "assistant" = "account",
) {
  if (!newSlot) return { ok: false as const, message: "Choose a new time." };

  const { data: bookingForDuration } = await admin
    .from("bookings")
    .select("packages(duration_minutes)")
    .eq("id", id)
    .maybeSingle();
  const packageRow = Array.isArray(bookingForDuration?.packages)
    ? bookingForDuration.packages[0]
    : bookingForDuration?.packages;
  if (!appointmentFitsWindow(newSlot, packageRow?.duration_minutes ?? 120)) {
    return { ok: false as const, message: APPOINTMENT_WINDOW_MESSAGE };
  }

  const cleanReason = reason?.trim().slice(0, 120) || "Schedule changed";
  const cleanNote = note?.trim().slice(0, 250) || null;

  let result;
  try {
    result = await modifyCustomerBookingState(supabase, {
      bookingId: id,
      newSlot,
      reason: `Customer rescheduled: ${cleanReason}`,
      meta: {
        source,
        reschedule_reason: cleanReason,
        ...(cleanNote ? { customer_message: cleanNote } : {}),
      },
    });
  } catch (error) {
    return {
      ok: false as const,
      message:
        error instanceof Error
          ? error.message
          : "This visit could not be moved.",
    };
  }

  const when = new Date(newSlot).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  await notifyBookingChangeAudience(
    id,
    "Booking time changed",
    `The customer moved this visit to ${when}.${
      cleanNote ? ` Their message: ${cleanNote}` : ""
    }`,
  );

  revalidatePath("/account");
  revalidatePath(`/account/visit/${id}`);
  revalidatePath("/worker");

  return {
    ok: true as const,
    message: result.changed ? `Visit moved to ${when}.` : "No changes were needed.",
  };
}

export async function modifyCustomerBooking(
  supabase: SupabaseClient,
  input: {
    id: string;
    newSlot: string;
    packageId: string;
    householdNotes: string;
    reason?: string;
    message?: string;
  },
) {
  const cleanReason = input.reason?.trim().slice(0, 120) || "Booking updated";
  const cleanMessage = input.message?.trim().slice(0, 250) || null;
  const cleanNotes = input.householdNotes.trim().slice(0, 1000);

  const { data: selectedPackage } = await admin
    .from("packages")
    .select("name, duration_minutes")
    .eq("id", input.packageId)
    .maybeSingle();
  if (!selectedPackage) {
    return { ok: false as const, message: "Choose an available service." };
  }
  if (
    !appointmentFitsWindow(
      input.newSlot,
      selectedPackage.duration_minutes ?? 120,
    )
  ) {
    return { ok: false as const, message: APPOINTMENT_WINDOW_MESSAGE };
  }

  let result;
  try {
    result = await modifyCustomerBookingState(supabase, {
      bookingId: input.id,
      newSlot: input.newSlot,
      packageId: input.packageId,
      householdNotes: cleanNotes,
      updateNotes: true,
      reason: `Customer modified booking: ${cleanReason}`,
      meta: {
        source: "account",
        modification_reason: cleanReason,
        ...(cleanMessage ? { customer_message: cleanMessage } : {}),
      },
    });
  } catch (error) {
    return {
      ok: false as const,
      message:
        error instanceof Error
          ? error.message
          : "This booking could not be updated.",
    };
  }

  if (!result.changed) {
    return { ok: true as const, message: "No changes were needed." };
  }

  const when = new Date(result.scheduled_at).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  const changes = [
    result.time_changed ? `new time: ${when}` : null,
    result.service_changed ? `service: ${selectedPackage.name}` : null,
    result.visit_notes_changed ? "visit instructions updated" : null,
  ].filter(Boolean);

  await notifyBookingChangeAudience(
    input.id,
    "Booking updated",
    `The customer changed this booking (${changes.join(", ")}).${
      cleanMessage ? ` Message: ${cleanMessage}` : ""
    }`,
  );

  revalidatePath("/account");
  revalidatePath(`/account/visit/${input.id}`);
  revalidatePath("/worker");
  revalidatePath(`/worker/job/${input.id}`);
  revalidatePath("/admin");
  revalidatePath("/admin/bookings");

  return { ok: true as const, message: "Booking updated successfully." };
}

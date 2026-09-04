import type { SupabaseClient } from "@supabase/supabase-js";

export type OfferRotationResult = {
  action:
    | "activated"
    | "waiting"
    | "exhausted"
    | "hard_deadline"
    | "closed"
    | "no_queue"
    | "missing_booking";
  provider_id?: string;
  profile_id?: string | null;
  customer_id?: string | null;
  respond_by?: string;
  cadence_minutes?: number;
  service?: string;
  address?: string | null;
  queued?: number;
  newly_exhausted?: boolean;
};

async function notifyRotationResult(
  admin: SupabaseClient,
  bookingId: string,
  result: OfferRotationResult,
) {
  if (result.action === "activated" && result.profile_id) {
    const minutes = result.cadence_minutes ?? 15;
    const { error } = await admin.from("notifications").insert({
      user_id: result.profile_id,
      title: "New job offer",
      body: `${result.service ?? "Service"} in ${
        result.address ?? "your area"
      } — reserved for you for ${minutes} minutes.`,
      href: "/worker",
    });
    if (error) throw new Error(error.message);
  }

  if (
    result.action === "exhausted" &&
    result.newly_exhausted &&
    (result.queued ?? 0) > 0 &&
    result.customer_id
  ) {
    const { error } = await admin.from("notifications").insert({
      user_id: result.customer_id,
      title: "No provider has accepted yet",
      body:
        "We asked every matching provider one at a time. You can reschedule, or keep this time and we'll cancel automatically if it remains unfilled.",
      href: `/account/visit/${bookingId}`,
    });
    if (error) throw new Error(error.message);
  }
}

export async function rotateBookingOffer(
  admin: SupabaseClient,
  bookingId: string,
) {
  const { data, error } = await admin.rpc("system_rotate_booking_offer", {
    p_booking_id: bookingId,
  });
  if (error) throw new Error(error.message);

  const result = data as OfferRotationResult;
  await notifyRotationResult(admin, bookingId, result);
  return result;
}

export async function seedAndStartOfferRotation(
  admin: SupabaseClient,
  bookingId: string,
  providerIds: string[],
) {
  const { data, error } = await admin.rpc("system_seed_booking_offer_queue", {
    p_booking_id: bookingId,
    p_provider_ids: providerIds,
  });
  if (error) throw new Error(error.message);

  const started = await rotateBookingOffer(admin, bookingId);
  return { seed: data, started };
}

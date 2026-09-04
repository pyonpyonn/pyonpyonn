"use server";

import { revalidatePath } from "next/cache";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { rescheduleBookingState } from "@/lib/bookingState";

async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (profile?.role !== "admin") throw new Error("Administrators only");

  return { supabase, user };
}

export async function adminRescheduleBooking(
  bookingId: string,
  newSlot: string,
  reason: string,
) {
  const { supabase, user } = await requireAdmin();
  const cleanReason = reason.trim();
  if (!newSlot) return { ok: false as const, message: "Choose a new date and time." };
  if (!cleanReason) {
    return { ok: false as const, message: "Record why the schedule is changing." };
  }

  const date = new Date(newSlot);
  if (Number.isNaN(date.getTime())) {
    return { ok: false as const, message: "The new date or time is invalid." };
  }

  try {
    await rescheduleBookingState(supabase, bookingId, date.toISOString(), {
      reason: `Admin rescheduled: ${cleanReason.slice(0, 220)}`,
      meta: { source: "admin_schedule", admin_id: user.id },
    });
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : "The booking could not be moved.",
    };
  }

  const service = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data: booking } = await service
    .from("bookings")
    .select("customer_id, provider_id")
    .eq("id", bookingId)
    .maybeSingle();
  const recipients = new Set<string>();
  if (booking?.customer_id) recipients.add(booking.customer_id);
  if (booking?.provider_id) {
    const { data: provider } = await service
      .from("providers")
      .select("profile_id")
      .eq("id", booking.provider_id)
      .maybeSingle();
    if (provider?.profile_id) recipients.add(provider.profile_id);
  }

  const when = date.toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  if (recipients.size) {
    await service.from("notifications").insert(
      [...recipients].map((userId) => ({
        user_id: userId,
        title: "Booking schedule updated",
        body: `An administrator moved this booking to ${when}. Reason: ${cleanReason.slice(0, 120)}`,
        href:
          userId === booking?.customer_id
            ? `/account/visit/${bookingId}`
            : `/worker/job/${bookingId}`,
      })),
    );
  }

  revalidatePath("/admin");
  revalidatePath("/admin/bookings");
  revalidatePath("/account");
  revalidatePath(`/account/visit/${bookingId}`);
  revalidatePath("/worker");
  revalidatePath(`/worker/job/${bookingId}`);

  return { ok: true as const, message: `Booking moved to ${when}.` };
}

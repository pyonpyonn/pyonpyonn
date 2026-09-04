"use server";

// Client booking actions: cancel, reschedule, rate.
// Save at: app/account/actions.ts

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { getRescheduleWindow } from "@/lib/bookingState";
import {
  cancelCustomerBooking,
  modifyCustomerBooking,
  notifyBookingProvider,
  rescheduleCustomerBooking,
} from "@/lib/customerBookingOperations";

// Cancel — releases the held payment (nothing was charged yet).
export async function cancelBooking(id: string, reason?: string) {
  const supabase = await createClient();
  return cancelCustomerBooking(supabase, id, reason, "account");
}

export async function loadRescheduleWindow(id: string) {
  const supabase = await createClient();
  try {
    return {
      ok: true as const,
      window: await getRescheduleWindow(supabase, id),
    };
  } catch (error) {
    return {
      ok: false as const,
      message:
        error instanceof Error
          ? error.message
          : "The reschedule window could not be checked.",
    };
  }
}

// Reschedule — move the visit to a new slot.
export async function rescheduleBooking(
  id: string,
  newSlot: string,
  reason?: string,
  note?: string,
) {
  const supabase = await createClient();
  return rescheduleCustomerBooking(
    supabase,
    id,
    newSlot,
    reason,
    note,
    "account",
  );
}

export async function modifyBooking(
  id: string,
  newSlot: string,
  packageId: string,
  householdNotes: string,
  reason?: string,
  message?: string,
) {
  const supabase = await createClient();
  return modifyCustomerBooking(supabase, {
    id,
    newSlot,
    packageId,
    householdNotes,
    reason,
    message,
  });
}

// Rate a completed visit.
export async function rateBooking(id: string, rating: number, comment: string) {
  const supabase = await createClient();
  const clean = Math.min(5, Math.max(1, Math.round(rating)));

  await supabase.from("reviews").insert({
    booking_id: id,
    rating: clean,
    comment: comment?.trim() ? comment.trim() : null,
  });

  await notifyBookingProvider(
    id,
    `You received a ${clean}-star review`,
    comment?.trim() ? comment.trim().slice(0, 120) : "Thanks for your work.",
  );

  revalidatePath("/account");
}

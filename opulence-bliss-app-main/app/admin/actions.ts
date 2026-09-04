"use server";

// Admin data tools. Save at: app/admin/actions.ts
// Every action checks the caller is an admin first.

import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { rescheduleBookingState } from "@/lib/bookingState";

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data: p } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (p?.role !== "admin") throw new Error("Admins only");
  return supabase;
}

const ALL = "00000000-0000-0000-0000-000000000000"; // sentinel for "match everything"

/**
 * Destructive tools are for demo data only.
 *
 * Deleting local financial records while Stripe keeps the charges and
 * transfers permanently destroys our ability to reconcile real money.
 */
function assertTestMode(tool: string) {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (key.startsWith("sk_live_")) {
    throw new Error(
      `"${tool}" is disabled in live mode. Deleting financial records while ` +
        `Stripe retains the charges would make reconciliation impossible. ` +
        `Correct data through the resolution desk instead.`,
    );
  }
}

export async function approveProvider(id: string) {
  const s = await requireAdmin();
  await s.from("providers").update({ vetting_status: "approved" }).eq("id", id);

  // Let them know
  const { data: p } = await s
    .from("providers")
    .select("profile_id")
    .eq("id", id)
    .maybeSingle();
  if (p?.profile_id) {
    await s.from("notifications").insert({
      user_id: p.profile_id,
      title: "You're approved",
      body: "Your provider account has been approved. Jobs will start coming through.",
      href: "/worker",
    });
  }
  revalidatePath("/admin");
  revalidatePath("/worker");
}

export async function rejectProvider(id: string) {
  const s = await requireAdmin();
  await s.from("providers").update({ vetting_status: "rejected" }).eq("id", id);
  revalidatePath("/admin");
  revalidatePath("/worker");
}

export async function deleteReview(id: string) {
  const s = await requireAdmin();
  await s.from("reviews").delete().eq("id", id);
  await recalcRatings(s);
  revalidatePath("/admin");
}

export async function wipeReviews() {
  const s = await requireAdmin();
  assertTestMode("Clear all reviews");
  await s.from("reviews").delete().neq("id", ALL);
  await recalcRatings(s);
  revalidatePath("/admin");
}

// Reset cached rating figures after deletions.
async function recalcRatings(s: Awaited<ReturnType<typeof requireAdmin>>) {
  await s
    .from("providers")
    .update({ rating_avg: null, rating_count: 0 })
    .neq("id", ALL);
  await s
    .from("profiles")
    .update({ client_rating_avg: null, client_rating_count: 0 })
    .neq("id", ALL);
}

export async function bringBookingToNow() {
  const s = await requireAdmin();
  assertTestMode("Move next booking to now");
  const { data: next } = await s
    .from("bookings")
    .select("id, status, scheduled_at")
    .in("status", ["offered", "declined", "scheduled"])
    .gte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(1);
  const booking = next?.[0];
  if (!booking) {
    revalidatePath("/admin");
    return { moved: false, message: "No upcoming bookings to move." };
  }
  const when = new Date(Date.now() + 2 * 60 * 1000);
  const expires = new Date(Date.now() + 60 * 60 * 1000);
  await rescheduleBookingState(s, booking.id, when.toISOString(), {
    reason: "Admin test tool moved the next booking to now",
    meta: {
      source: "admin_test_tool",
      offer_expires_at: expires.toISOString(),
    },
  });
  revalidatePath("/admin");
  revalidatePath("/worker");
  revalidatePath("/account");
  return {
    moved: true,
    message: `Moved a booking to ${when.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    })} today.`,
  };
}

export async function wipeAvailability() {
  const s = await requireAdmin();
  assertTestMode("Clear all availability");
  await s.from("provider_availability").delete().neq("id", ALL);
  revalidatePath("/admin");
}

export async function resetJoiningFees() {
  const s = await requireAdmin();
  assertTestMode("Reset joining fees");
  await s
    .from("providers")
    .update({
      joining_fee_paid: false,
      joining_fee_ref: null,
      joining_fee_at: null,
    })
    .neq("id", ALL);
  revalidatePath("/admin");
}

export async function resetPrototypeData() {
  const s = await requireAdmin();
  assertTestMode("Reset all prototype activity");
  const {
    data: { user },
  } = await s.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data, error } = await admin.rpc("admin_reset_prototype_data", {
    p_actor_id: user.id,
    p_confirmation: "RESET PROTOTYPE DATA",
  });
  if (error) throw new Error(error.message);

  revalidatePath("/admin");
  revalidatePath("/admin/review");
  revalidatePath("/account");
  revalidatePath("/worker");
  revalidatePath("/notifications");

  const removed = (data as { removed?: { bookings?: number } } | null)?.removed;
  return {
    message: `Prototype activity cleared${removed?.bookings !== undefined ? ` — ${removed.bookings} booking${removed.bookings === 1 ? "" : "s"} removed` : ""}.`,
  };
}

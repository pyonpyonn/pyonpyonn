"use server";

// Customer exception actions. Reporting records evidence and opens a blocking
// review case; it never decides the eventual charge or provider compensation.

import { revalidatePath } from "next/cache";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email";

const admin = createServiceClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const GRACE_MINUTES = 15;
const MAX_REASON_LENGTH = 1000;

type Result = { ok: boolean; message: string };

function one<T>(value: T | T[] | null | undefined): T | null {
  return !value ? null : Array.isArray(value) ? (value[0] ?? null) : value;
}

export async function reportProviderNoShow(
  bookingId: string,
  reason: string,
): Promise<Result> {
  const explanation = reason?.trim().slice(0, MAX_REASON_LENGTH);
  if (!explanation) {
    return { ok: false, message: "Tell us briefly what happened." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Please log in." };

  const { data: booking, error: bookingError } = await supabase
    .from("bookings")
    .select(
      "id, status, scheduled_at, customer_id, customer_email, provider_id, packages(name), providers(display_name, profile_id)",
    )
    .eq("id", bookingId)
    .maybeSingle();

  if (bookingError || !booking) {
    return { ok: false, message: "Booking not found." };
  }
  if (booking.customer_id !== user.id) {
    return { ok: false, message: "That isn't your booking." };
  }
  if (booking.status !== "scheduled") {
    return {
      ok: false,
      message: "This visit can no longer be reported as a no-show.",
    };
  }

  const reportFrom =
    new Date(booking.scheduled_at).getTime() + GRACE_MINUTES * 60_000;
  if (Date.now() < reportFrom) {
    const time = new Date(reportFrom).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
    return {
      ok: false,
      message: `Give them a few more minutes — you can report this from ${time}.`,
    };
  }

  const { count: arrivals, error: arrivalsError } = await admin
    .from("check_ins")
    .select("*", { count: "exact", head: true })
    .eq("booking_id", bookingId)
    .not("arrived_at", "is", null);
  if (arrivalsError) return { ok: false, message: arrivalsError.message };
  if ((arrivals ?? 0) > 0) {
    return {
      ok: false,
      message:
        "The provider has already checked in. Contact support if something else is wrong.",
    };
  }

  const { error } = await supabase.rpc("report_booking_exception", {
    p_booking_id: bookingId,
    p_category: "worker_no_show",
    p_reason: `Customer reports the provider did not arrive: ${explanation}`,
    p_notes: `Customer reported a no-show. Their words: ${explanation}`,
    p_meta: { reported_at: new Date().toISOString() },
  });
  if (error) return { ok: false, message: error.message };

  const pkg = one(booking.packages as never) as { name: string } | null;
  const provider = one(booking.providers as never) as {
    display_name: string | null;
    profile_id: string | null;
  } | null;

  await Promise.allSettled([
    provider?.profile_id
      ? admin.from("notifications").insert({
          user_id: provider.profile_id,
          title: "A client says you didn't arrive",
          body: `Your ${pkg?.name ?? "visit"} has been flagged. Our team will ask for your account of what happened.`,
          href: "/worker/updates",
        })
      : Promise.resolve(),
    sendEmail({
      to: booking.customer_email,
      subject: "We're looking into your visit",
      title: "Thanks for telling us",
      body: `<p>You've reported that nobody arrived for your <strong>${
        pkg?.name ?? "visit"
      }</strong>.</p><p>Payment is paused while our team reviews what happened and decides the next step.</p>`,
      cta: { text: "See your visit", url: `/account/visit/${bookingId}` },
    }),
  ]);

  revalidatePath("/account");
  revalidatePath(`/account/visit/${bookingId}`);
  revalidatePath("/worker");

  return {
    ok: true,
    message:
      "Reported. Payment is paused while our team reviews what happened.",
  };
}

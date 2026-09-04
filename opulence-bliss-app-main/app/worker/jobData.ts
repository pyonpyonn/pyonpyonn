import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { providerPaymentLabel } from "@/lib/providerPaymentStatus";

export type WorkerJobWorkspaceData = {
  id: string;
  status: string;
  service: string;
  durationMinutes: number | null;
  scheduledAt: string;
  createdAt: string | null;
  confirmedAt: string | null;
  delayMinutes: number | null;
  delayReportedAt: string | null;
  address: string | null;
  notes: string | null;
  isMembership: boolean;
  client: {
    name: string;
    email: string | null;
    rating: number | null;
    ratingCount: number;
    completedWithYou: number;
  };
  money: {
    earns: number | null;
    gross: number | null;
    platformFee: number | null;
    tips: number;
    label: string;
    explanation: string;
  };
  checkIn: {
    arrivedAt: string | null;
    leftAt: string | null;
    geofencePass: boolean | null;
    gpsLat: number | null;
    gpsLng: number | null;
  };
  existingClientRating: {
    rating: number;
    comment: string | null;
  } | null;
};

type BookingPackage = {
  name: string;
  duration_minutes: number | null;
};

type CheckIn = {
  arrived_at: string | null;
  left_at: string | null;
  geofence_pass: boolean | null;
  gps_lat: number | null;
  gps_lng: number | null;
};

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function payoutExplanation({
  bookingStatus,
  paymentStatus,
  payoutStatus,
  membership,
}: {
  bookingStatus: string;
  paymentStatus: string | null;
  payoutStatus: string | null;
  membership: boolean;
}) {
  switch (payoutStatus) {
    case "paid":
      return "Sent to your connected Stripe account.";
    case "processing":
      return "Stripe is processing your payout.";
    case "pending":
      return "Ready for the next payout run.";
    case "held":
      return "Held while the resolution team reviews this visit.";
    case "failed":
      return "The payout needs attention from the resolution team.";
    case "reversed":
      return "The payout was reversed and is under review.";
    case "not_ready":
      return membership
        ? "Released only after the covering membership invoice is paid and the visit is complete."
        : "Released only after the customer payment is captured and the visit is complete.";
  }

  if (bookingStatus === "completed") {
    return "The visit is complete and the payout status will update here.";
  }
  if (paymentStatus === "authorised") {
    return "The customer payment is secured. Your payout becomes ready after check-out.";
  }
  return membership
    ? "This visit is covered by the client's membership."
    : "Your quoted earnings are secured for this booking.";
}

export async function loadWorkerJob(
  supabase: SupabaseClient,
  bookingId: string,
): Promise<WorkerJobWorkspaceData | null> {
  const { data: row } = await supabase
    .from("bookings")
    .select(
      "id, created_at, scheduled_at, status, address, household_notes, customer_id, customer_email, provider_id, provider_payout, subscription_id, provider_delay_minutes, provider_delay_reported_at, packages(name, duration_minutes), check_ins(arrived_at, left_at, geofence_pass, gps_lat, gps_lng)",
    )
    .eq("id", bookingId)
    .maybeSingle();

  if (!row) return null;

  const [
    customerResult,
    paymentResult,
    payoutResult,
    eventResult,
    ratingResult,
  ] = await Promise.all([
    supabase.rpc("booking_customer_summary", { p_booking_id: row.id }),
    supabase
      .from("payments")
      .select("gross_amount, split_breakdown, status, kind, created_at")
      .eq("booking_id", row.id),
    supabase
      .from("payouts")
      .select("status")
      .eq("booking_id", row.id)
      .maybeSingle(),
    supabase
      .from("booking_events")
      .select("to_status, created_at")
      .eq("booking_id", row.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("reviews")
      .select("rating, comment")
      .eq("booking_id", row.id)
      .eq("reviewer", "provider")
      .maybeSingle(),
  ]);

  const customer = one(customerResult.data as never) as {
    full_name: string | null;
    client_rating_avg: number | null;
    client_rating_count: number | null;
  } | null;
  const payments = paymentResult.data ?? [];
  const jobPayment = payments.find((payment) => payment.kind !== "tip");
  const tips = payments
    .filter((payment) => payment.kind === "tip")
    .reduce((total, payment) => total + Number(payment.gross_amount ?? 0), 0);
  const payoutStatus = payoutResult.data?.status ?? null;
  const packageRow = one(row.packages as never) as BookingPackage | null;
  const checkIn = one(row.check_ins as never) as CheckIn | null;
  const split = jobPayment?.split_breakdown as {
    provider?: number;
    platform_margin?: number;
  } | null;
  const gross =
    jobPayment?.gross_amount === null || jobPayment?.gross_amount === undefined
      ? null
      : Number(jobPayment.gross_amount);
  const earnsValue = row.provider_payout ?? split?.provider;
  const earns =
    earnsValue === null || earnsValue === undefined ? null : Number(earnsValue);
  const explicitFee = split?.platform_margin;
  const platformFee =
    explicitFee !== null && explicitFee !== undefined
      ? Number(explicitFee)
      : !row.subscription_id && gross !== null && earns !== null
        ? Math.max(0, gross - earns)
        : null;

  let completedWithYou = 0;
  if (row.customer_id && row.provider_id) {
    const { count } = await supabase
      .from("bookings")
      .select("*", { count: "exact", head: true })
      .eq("customer_id", row.customer_id)
      .eq("provider_id", row.provider_id)
      .eq("status", "completed");
    completedWithYou = count ?? 0;
  }

  const paymentStatus = jobPayment?.status ?? null;
  const isMembership = Boolean(row.subscription_id);
  const events = eventResult.data ?? [];

  return {
    id: row.id,
    status: row.status,
    service: packageRow?.name ?? "Service",
    durationMinutes: packageRow?.duration_minutes ?? null,
    scheduledAt: row.scheduled_at,
    createdAt:
      row.created_at ?? jobPayment?.created_at ?? events[0]?.created_at ?? null,
    confirmedAt:
      events.find((event) => event.to_status === "scheduled")?.created_at ??
      null,
    delayMinutes: row.provider_delay_minutes ?? null,
    delayReportedAt: row.provider_delay_reported_at ?? null,
    address: row.address,
    notes: row.household_notes,
    isMembership,
    client: {
      name: customer?.full_name ?? row.customer_email ?? "Client",
      email: row.customer_email,
      rating:
        customer?.client_rating_avg === null ||
        customer?.client_rating_avg === undefined
          ? null
          : Number(customer.client_rating_avg),
      ratingCount: customer?.client_rating_count ?? 0,
      completedWithYou,
    },
    money: {
      earns,
      gross,
      platformFee,
      tips,
      label: providerPaymentLabel({
        bookingStatus: row.status,
        paymentStatus,
        payoutStatus,
        amount: earns,
      }),
      explanation: payoutExplanation({
        bookingStatus: row.status,
        paymentStatus,
        payoutStatus,
        membership: isMembership,
      }),
    },
    checkIn: {
      arrivedAt: checkIn?.arrived_at ?? null,
      leftAt: checkIn?.left_at ?? null,
      geofencePass: checkIn?.geofence_pass ?? null,
      gpsLat: checkIn?.gps_lat ?? null,
      gpsLng: checkIn?.gps_lng ?? null,
    },
    existingClientRating: ratingResult.data
      ? {
          rating: Number(ratingResult.data.rating),
          comment: ratingResult.data.comment,
        }
      : null,
  };
}

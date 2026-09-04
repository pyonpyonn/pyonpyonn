// One visit, in full — the client booking workspace.

import { createClient } from "@/lib/supabase/server";
import { getVisitStatus } from "@/lib/visitStatus";
import BookingWorkspace, {
  type ClientBookingWorkspaceData,
} from "../../BookingWorkspace";
import {
  BookingTools,
  RateBooking,
  TipBooking,
  type BookingServiceOption,
} from "../../BookingTools";
import ReportNoShow from "../../ReportNoShow";
import { SignedOut } from "../../page";

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function professionFor(service: string, services: string[]) {
  const value = `${service} ${services.join(" ")}`.toLowerCase();
  if (value.includes("massage")) return "Professional therapist";
  if (value.includes("clean")) return "Professional cleaner";
  if (value.includes("beauty") || value.includes("facial")) {
    return "Beauty professional";
  }
  return "Opulence Bliss professional";
}

export default async function VisitPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return <SignedOut area="client" />;

  const { data: row } = await supabase
    .from("bookings")
    .select(
      "id, scheduled_at, status, address, household_notes, package_id, provider_id, offer_expires_at, provider_delay_minutes, provider_delay_reported_at, packages(name, duration_minutes, price), providers(display_name, rating_avg, rating_count, bio, photo_url, years_experience, services, vetting_status), check_ins(arrived_at, left_at)",
    )
    .eq("id", id)
    .maybeSingle();

  if (!row) {
    return (
      <main style={wrap}>
        <div style={{ maxWidth: 620, margin: "0 auto", paddingTop: 60 }}>
          <h1 style={missingTitle}>Visit not found</h1>
          <p style={{ color: "var(--ob-muted)" }}>
            This booking may have been cancelled.
          </p>
          <p style={{ marginTop: 20 }}>
            <a href="/account" style={backLink}>
              ← My bookings
            </a>
          </p>
        </div>
      </main>
    );
  }

  const [status, reviewResult, paymentResult, eventResult, packagesResult] =
    await Promise.all([
    getVisitStatus(supabase, row.id),
    supabase
      .from("reviews")
      .select("rating, comment")
      .eq("booking_id", id)
      .eq("reviewer", "client")
      .maybeSingle(),
    supabase
      .from("payments")
      .select("gross_amount, status, kind, created_at")
      .eq("booking_id", id),
    supabase
      .from("booking_events")
      .select("to_status, created_at")
      .eq("booking_id", id)
      .order("created_at", { ascending: true }),
    supabase
      .from("packages")
      .select("id, name, price, duration_minutes, service_type")
      .eq("active", true)
      .eq("billing_type", "per_visit")
      .order("price"),
  ]);

  const pays = paymentResult.data ?? [];
  const events = eventResult.data ?? [];
  const review = reviewResult.data;
  const jobPay = pays.find((payment) => payment.kind !== "tip");
  const serviceOptions: BookingServiceOption[] = (
    packagesResult.data ?? []
  ).map((item) => ({
    id: item.id,
    name: item.name,
    price: Number(item.price),
    durationMinutes: item.duration_minutes,
    serviceType: item.service_type,
  }));

  const pkg = one(row.packages as never) as {
    name: string;
    duration_minutes: number | null;
    price: number;
  } | null;
  const provider = one(row.providers as never) as {
    display_name: string | null;
    rating_avg: number | null;
    rating_count: number | null;
    bio: string | null;
    photo_url: string | null;
    years_experience: number | null;
    services: string[] | null;
    vetting_status: string | null;
  } | null;
  const checkIn = one(row.check_ins as never) as {
    arrived_at: string | null;
    left_at: string | null;
  } | null;

  let latestProviderReview: ClientBookingWorkspaceData["latestReview"] = null;
  if (row.provider_id) {
    const { data } = await supabase
      .from("reviews")
      .select("rating, comment, bookings!inner(provider_id)")
      .eq("reviewer", "client")
      .eq("bookings.provider_id", row.provider_id)
      .not("comment", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      latestProviderReview = {
        rating: Number(data.rating),
        comment: data.comment,
      };
    }
  }

  const service = pkg?.name ?? "Service";
  const paymentAmount = Number(jobPay?.gross_amount ?? pkg?.price ?? 0);
  const booking: ClientBookingWorkspaceData = {
    id: row.id,
    status: row.status,
    service,
    durationMinutes: pkg?.duration_minutes ?? null,
    scheduledAt: row.scheduled_at,
    address: row.address,
    bookedAt: jobPay?.created_at ?? events[0]?.created_at ?? null,
    confirmedAt:
      events.find((event) => event.to_status === "scheduled")?.created_at ??
      null,
    delayMinutes: row.provider_delay_minutes ?? null,
    delayReportedAt: row.provider_delay_reported_at ?? null,
    arrivedAt: checkIn?.arrived_at ?? null,
    finishedAt: checkIn?.left_at ?? null,
    paymentAmount: paymentAmount > 0 ? paymentAmount : null,
    paymentLabel:
      status?.money.label ??
      (paymentAmount > 0 ? "Payment recorded" : "Included"),
    paymentExplanation:
      status?.money.explanation ??
      "Payment follows the booking status shown here.",
    provider: {
      assigned: Boolean(row.provider_id),
      name: provider?.display_name ?? null,
      photoUrl: provider?.photo_url ?? null,
      rating:
        provider?.rating_avg === null || provider?.rating_avg === undefined
          ? null
          : Number(provider.rating_avg),
      ratingCount: provider?.rating_count ?? 0,
      bio: provider?.bio ?? null,
      yearsExperience: provider?.years_experience ?? null,
      profession: professionFor(service, provider?.services ?? []),
      backgroundChecked: provider?.vetting_status === "approved",
    },
    latestReview: latestProviderReview,
  };

  const canCancel =
    status?.actions.some((action) => action.kind === "cancel") ?? false;
  const canReschedule =
    status?.actions.some((action) => action.kind === "reschedule") ?? false;
  const canRate =
    status?.actions.some((action) => action.kind === "rate") ?? false;
  const canTip =
    status?.actions.some((action) => action.kind === "tip") ?? false;
  const chatClosed =
    row.status === "cancelled" ||
    new Date(row.scheduled_at).getTime() < Date.now() - 7 * 24 * 60 * 60 * 1000;

  return (
    <main style={wrap}>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <p style={{ margin: "0 0 16px" }}>
          <a href="/account" style={backLink}>
            ← My bookings
          </a>
        </p>

        <BookingWorkspace
          booking={booking}
          visitStatus={status}
          canCancel={canCancel}
          canModify={canReschedule}
          chatClosed={chatClosed}
          modifyControl={
            canReschedule ? (
              <BookingTools
                id={row.id}
                postcode={row.address}
                showCancel={false}
                service={booking.service}
                durationMinutes={booking.durationMinutes}
                scheduledAt={booking.scheduledAt}
                providerName={booking.provider.name}
                address={booking.address}
                paymentAmount={booking.paymentAmount}
                packageId={row.package_id}
                bookingNotes={row.household_notes}
                serviceOptions={serviceOptions}
                triggerVariant="header"
              />
            ) : null
          }
        >
          <ReportNoShow
            bookingId={row.id}
            scheduledAt={row.scheduled_at}
            status={row.status}
            hasArrived={Boolean(checkIn?.arrived_at)}
          />

          {(canRate || canTip || review) && (
            <div id="review" style={actionBlock}>
              <strong style={actionTitle}>Your review</strong>
              {(canRate || review) && (
                <RateBooking id={row.id} existing={review ?? null} />
              )}
              {canTip && <TipBooking id={row.id} />}
              <p style={{ margin: "12px 0 0" }}>
                <a
                  href={`/book?service=${row.package_id ?? ""}&pc=${
                    row.address ?? ""
                  }`}
                  style={bookAgainLink}
                >
                  Book this again →
                </a>
              </p>
            </div>
          )}
        </BookingWorkspace>
      </div>
    </main>
  );
}

const wrap: React.CSSProperties = {
  minHeight: "100vh",
  color: "var(--ob-text)",
  fontFamily: "'Nunito', system-ui, sans-serif",
  padding: "4px 0 48px",
};

const missingTitle: React.CSSProperties = {
  margin: "0 0 8px",
  color: "var(--ob-text)",
  fontSize: 32,
  fontWeight: 900,
};

const backLink: React.CSSProperties = {
  color: "var(--ob-purple)",
  fontSize: 14,
  fontWeight: 800,
  textDecoration: "none",
};

const actionBlock: React.CSSProperties = {
  padding: "13px 0",
  borderBottom: "1px solid var(--ob-border)",
};

const actionTitle: React.CSSProperties = {
  display: "block",
  color: "var(--ob-text)",
  fontSize: 15,
  fontWeight: 900,
};

const actionCopy: React.CSSProperties = {
  margin: "4px 0 0",
  color: "var(--ob-muted)",
  fontSize: 13,
  fontWeight: 650,
};

const bookAgainLink: React.CSSProperties = {
  color: "var(--ob-purple)",
  fontWeight: 800,
  fontSize: 13.5,
};

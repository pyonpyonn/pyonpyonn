// Provider dashboard — active job first, then offers, schedule, history.
// Save at: app/worker/page.tsx

import { createClient } from "@/lib/supabase/server";
import { SignedOut } from "@/app/account/page";
import VisitHistoryCard from "@/components/VisitHistoryCard";
import { providerPaymentLabel } from "@/lib/providerPaymentStatus";
import ActiveJob, { type ActiveJobData } from "./ActiveJob";
import JobActions from "./JobActions";

type Row = {
  id: string;
  customer_id: string | null;
  scheduled_at: string;
  status: string;
  address: string | null;
  household_notes: string | null;
  customer_email: string | null;
  offer_expires_at?: string | null;
  provider_payout?: number | null;
  provider_delay_minutes?: number | null;
  provider_delay_reported_at?: string | null;
  packages:
    | { name: string; duration_minutes: number | null }
    | { name: string; duration_minutes: number | null }[]
    | null;
  check_ins:
    | {
        arrived_at: string | null;
        left_at: string | null;
        geofence_pass: boolean | null;
      }
    | {
        arrived_at: string | null;
        left_at: string | null;
        geofence_pass: boolean | null;
      }[]
    | null;
};

function one<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function when(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function clock(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function elapsed(
  start: string | null | undefined,
  end: string | null | undefined,
) {
  if (!start || !end) return null;
  const minutes = Math.max(
    0,
    Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000),
  );
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}h ${rest}m` : `${rest}m`;
}

export default async function WorkerPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return <SignedOut area="provider" />;

  const { data: prov } = await supabase
    .from("providers")
    .select(
      "id, display_name, joining_fee_paid, vetting_status, rating_avg, rating_count",
    )
    .eq("profile_id", user.id)
    .maybeSingle();

  const active = prov?.joining_fee_paid === true;

  const { data: rowsData } = await supabase
    .from("bookings")
    .select(
      "id, customer_id, scheduled_at, status, address, household_notes, customer_email, provider_payout, provider_delay_minutes, provider_delay_reported_at, packages(name, duration_minutes), check_ins(arrived_at, left_at, geofence_pass)",
    )
    .order("scheduled_at", { ascending: true });

  const rows = (rowsData ?? []) as unknown as Row[];

  // Only the currently active offer is visible to this provider.
  let offers: Row[] = [];
  if (prov?.id) {
    const { data: offerRows } = await supabase
      .from("booking_offers")
      .select(
        "booking_id, bookings(id, customer_id, scheduled_at, status, address, household_notes, customer_email, offer_expires_at, provider_payout, provider_delay_minutes, provider_delay_reported_at, packages(name, duration_minutes), check_ins(arrived_at, left_at, geofence_pass))",
      )
      .eq("provider_id", prov.id)
      .eq("status", "open");

    offers = (offerRows ?? [])
      .map((o) => one(o.bookings as never) as unknown as Row | null)
      .filter((b): b is Row => !!b && b.status === "offered")
      .sort(
        (a, b) =>
          new Date(a.scheduled_at).getTime() -
          new Date(b.scheduled_at).getTime(),
      );
  }

  // Earnings per booking, so the card can show what each job pays
  const { data: paysData } = await supabase
    .from("payments")
    .select("booking_id, split_breakdown, kind, status");
  const earnMap = new Map<string, number>();
  const paymentStatusMap = new Map<string, string>();
  for (const p of paysData ?? []) {
    if (p.kind === "tip" || !p.booking_id) continue;
    const share = Number(
      (p.split_breakdown as { provider?: number } | null)?.provider ?? 0,
    );
    earnMap.set(p.booking_id as string, share);
    paymentStatusMap.set(p.booking_id as string, p.status as string);
  }

  const { data: payoutData } = await supabase
    .from("payouts")
    .select("booking_id, status");
  const payoutStatusMap = new Map(
    (payoutData ?? [])
      .filter((p) => p.booking_id)
      .map((p) => [p.booking_id as string, p.status as string]),
  );
  // Membership visits carry their payout on the booking itself.
  for (const r of [...rows, ...offers]) {
    const own = (r as unknown as { provider_payout?: number | null })
      .provider_payout;
    if (own !== null && own !== undefined) {
      earnMap.set(r.id, Number(own));
    }
  }

  const running = rows.find((r) => r.status === "in_progress");
  const upcoming = rows.filter((r) => r.status === "scheduled");
  const past = rows
    .filter((r) => ["completed", "cancelled", "declined"].includes(r.status))
    .reverse();

  const assigned = [...(running ? [running] : []), ...upcoming];
  const customerSummaryMap = new Map<
    string,
    {
      full_name: string | null;
      client_rating_avg: number | null;
      client_rating_count: number | null;
      completedWithProvider: number;
    }
  >();
  await Promise.all(
    assigned.map(async (booking) => {
      const [{ data }, completedResult] = await Promise.all([
        supabase.rpc("booking_customer_summary", {
          p_booking_id: booking.id,
        }),
        booking.customer_id && prov?.id
          ? supabase
              .from("bookings")
              .select("*", { count: "exact", head: true })
              .eq("customer_id", booking.customer_id)
              .eq("provider_id", prov.id)
              .eq("status", "completed")
          : Promise.resolve({ count: 0 }),
      ]);
      const summary = one(data as never) as {
        full_name: string | null;
        client_rating_avg: number | null;
        client_rating_count: number | null;
      } | null;
      if (summary) {
        customerSummaryMap.set(booking.id, {
          ...summary,
          completedWithProvider: completedResult.count ?? 0,
        });
      }
    }),
  );

  const toActiveJob = (booking: Row): ActiveJobData => {
    const pkg = one(booking.packages);
    const checkIn = one(booking.check_ins);
    const customer = customerSummaryMap.get(booking.id);
    return {
      id: booking.id,
      status: booking.status,
      scheduled_at: booking.scheduled_at,
      address: booking.address,
      notes: booking.household_notes,
      client: customer?.full_name ?? booking.customer_email ?? "Customer",
      clientEmail: booking.customer_email,
      clientRating:
        customer?.client_rating_avg === null ||
        customer?.client_rating_avg === undefined
          ? null
          : Number(customer.client_rating_avg),
      clientRatingCount: customer?.client_rating_count ?? 0,
      clientCompletedBookings: customer?.completedWithProvider ?? 0,
      service: pkg?.name ?? "Service",
      durationMinutes: pkg?.duration_minutes ?? null,
      earns: earnMap.get(booking.id) ?? null,
      paymentLabel: providerPaymentLabel({
        bookingStatus: booking.status,
        paymentStatus: paymentStatusMap.get(booking.id),
        payoutStatus: payoutStatusMap.get(booking.id),
        amount: earnMap.get(booking.id),
      }),
      arrivedAt: checkIn?.arrived_at ?? null,
      leftAt: checkIn?.left_at ?? null,
      geofencePass: checkIn?.geofence_pass ?? null,
      offerExpiresAt: booking.offer_expires_at ?? null,
      delayMinutes: booking.provider_delay_minutes ?? null,
      delayReportedAt: booking.provider_delay_reported_at ?? null,
    };
  };

  // What clients said about finished work
  const pastIds = rows.filter((r) => r.status === "completed").map((r) => r.id);
  const clientReviewMap = new Map<
    string,
    { rating: number; comment: string | null }
  >();
  const providerReviewMap = new Map<
    string,
    { rating: number; comment: string | null }
  >();
  if (pastIds.length) {
    const { data: revs } = await supabase
      .from("reviews")
      .select("booking_id, reviewer, rating, comment")
      .in("booking_id", pastIds);
    for (const r of revs ?? []) {
      const target =
        r.reviewer === "provider" ? providerReviewMap : clientReviewMap;
      target.set(r.booking_id as string, {
        rating: r.rating as number,
        comment: (r.comment as string | null) ?? null,
      });
    }
  }

  return (
    <main style={wrap}>
      <link rel="stylesheet" href={FONTS} />
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <h1 style={h1}>Jobs</h1>

        {/* ---- In progress: short view only ---- */}
        {running && active && (
          <div style={{ marginBottom: 28 }}>
            <h2 style={sectionTitle}>Current job</h2>
            <ActiveJob job={toActiveJob(running)} compact />
          </div>
        )}

        {/* ---- 2. New offers ---- */}
        <h2 style={sectionTitle}>
          New offers{offers.length > 0 ? ` (${offers.length})` : ""}
        </h2>
        {offers.length === 0 ? (
          <p style={{ color: "var(--ob-muted)", margin: "0 0 34px" }}>
            Nothing waiting right now.
          </p>
        ) : (
          <div style={{ display: "grid", gap: 16, marginBottom: 34 }}>
            {offers.map((booking) => (
              <ActiveJob
                key={booking.id}
                job={toActiveJob(booking)}
                canAct={active}
                compact
              />
            ))}
          </div>
        )}

        {/* ---- 3. Coming up ---- */}
        <h2 style={sectionTitle}>Coming up</h2>
        {upcoming.length === 0 ? (
          <EmptyNextJob />
        ) : (
          <div style={{ display: "grid", gap: 14, marginBottom: 34 }}>
            {upcoming.map((booking) => (
              <ActiveJob key={booking.id} job={toActiveJob(booking)} compact />
            ))}
          </div>
        )}

        {/* ---- 4. History ---- */}
        <h2 id="past-work" style={sectionTitle}>
          Past work
        </h2>
        {past.length === 0 ? (
          <p style={{ color: "#7A828C" }}>Nothing yet.</p>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {past.slice(0, 12).map((r) => {
              const pkg = one(r.packages);
              const ci = one(r.check_ins);
              const clientReview = clientReviewMap.get(r.id);
              const providerReview = providerReviewMap.get(r.id);
              const actualDuration = elapsed(ci?.arrived_at, ci?.left_at);
              const completed = r.status === "completed";
              return (
                <VisitHistoryCard
                  key={r.id}
                  title={pkg?.name ?? "Service"}
                  when={when(r.scheduled_at)}
                  status={
                    completed
                      ? "Completed"
                      : r.status === "cancelled"
                        ? "Cancelled"
                        : "Declined"
                  }
                  statusTone={completed ? "good" : "neutral"}
                  rating={
                    completed
                      ? {
                          label: "Client's rating of your work",
                          rating: clientReview?.rating ?? null,
                          comment: clientReview?.comment ?? null,
                          pending: "Waiting for the client’s rating",
                        }
                      : null
                  }
                  secondaryRating={
                    completed
                      ? {
                          label: "Your rating of the client",
                          rating: providerReview?.rating ?? null,
                          comment: providerReview?.comment ?? null,
                          pending: "You still need to rate this client",
                        }
                      : null
                  }
                  facts={[
                    { label: "Client", value: r.customer_email ?? "—" },
                    { label: "Address", value: r.address ?? "—" },
                    {
                      label: "Duration",
                      value:
                        actualDuration ??
                        (pkg?.duration_minutes
                          ? `${pkg.duration_minutes} minutes planned`
                          : "—"),
                    },
                    {
                      label: "Check-in / checkout",
                      value: ci?.arrived_at
                        ? `${clock(ci.arrived_at)} – ${clock(ci.left_at)}`
                        : "No check-in recorded",
                    },
                    {
                      label: "You earned",
                      value: earnMap.has(r.id)
                        ? `£${(earnMap.get(r.id) ?? 0).toFixed(2)}`
                        : "—",
                    },
                    {
                      label: "Location",
                      value:
                        ci?.geofence_pass === true
                          ? "Verified at check-in"
                          : ci?.geofence_pass === false
                            ? "Check-in was flagged"
                            : "Not recorded",
                    },
                  ]}
                >
                  {r.household_notes && (
                    <p
                      style={{
                        color: "#4B5563",
                        fontSize: 13.5,
                        margin: "0 0 12px",
                      }}
                    >
                      <strong>Client notes:</strong> {r.household_notes}
                    </p>
                  )}
                  {completed && !providerReview && (
                    <JobActions
                      id={r.id}
                      status={r.status}
                      scheduledAt={r.scheduled_at}
                      existingRating={null}
                    />
                  )}
                  <p style={{ margin: "12px 0 0" }}>
                    <a
                      href={`/worker/job/${r.id}`}
                      style={{
                        color: "#6D28D9",
                        fontSize: 13.5,
                        fontWeight: 800,
                      }}
                    >
                      Open full job details →
                    </a>
                  </p>
                </VisitHistoryCard>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

/* ---------- small pieces ---------- */

function EmptyNextJob() {
  return (
    <section style={emptyJob}>
      <div style={emptyIcon} aria-hidden="true">
        ◫
      </div>
      <div>
        <h3 style={emptyTitle}>You don&apos;t have any upcoming jobs yet</h3>
        <p style={emptyCopy}>
          New bookings will appear here once clients request your services.
        </p>
        <a href="/worker/availability" style={emptyAction}>
          View schedule
        </a>
      </div>
    </section>
  );
}

/* ---------- styles ---------- */

const FONTS =
  "https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap";
const wrap: React.CSSProperties = {
  background: "transparent",
  color: "#16202A",
  fontFamily: "'Nunito', system-ui, sans-serif",
  padding: 0,
};
const h1: React.CSSProperties = {
  fontFamily: "'Nunito', system-ui, sans-serif",
  fontWeight: 900,
  fontSize: 38,
  color: "#16202A",
  margin: "0 0 6px",
};
const sectionTitle: React.CSSProperties = {
  fontFamily: "'Nunito', system-ui, sans-serif",
  fontWeight: 900,
  fontSize: 22,
  color: "var(--ob-text)",
  margin: "0 0 14px",
};
const emptyJob: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 28,
  minHeight: 150,
  boxSizing: "border-box",
  marginBottom: 34,
  padding: "24px",
  border: "1px solid var(--ob-border)",
  borderRadius: 18,
  background: "var(--ob-surface)",
};
const emptyIcon: React.CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 86,
  height: 86,
  flex: "0 0 86px",
  borderRadius: "50%",
  background: "var(--ob-purple-soft)",
  color: "var(--ob-purple)",
  fontSize: 44,
  fontWeight: 900,
};
const emptyTitle: React.CSSProperties = {
  margin: "0 0 4px",
  color: "var(--ob-text)",
  fontSize: 18,
  fontWeight: 900,
};
const emptyCopy: React.CSSProperties = {
  maxWidth: 430,
  margin: "0 0 13px",
  color: "var(--ob-muted)",
  fontSize: 13.5,
  fontWeight: 650,
};
const emptyAction: React.CSSProperties = {
  display: "inline-block",
  border: "1px solid var(--ob-purple)",
  borderRadius: 9,
  padding: "8px 15px",
  color: "var(--ob-purple)",
  fontSize: 12.5,
  fontWeight: 900,
  textDecoration: "none",
};

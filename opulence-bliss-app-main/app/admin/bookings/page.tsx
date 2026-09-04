import AdminNav from "../AdminNav";
import BookingScheduleControl from "./BookingScheduleControl";
import { requireAdminPage } from "@/lib/adminSession";

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function when(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

const STATUS: Record<string, { bg: string; color: string }> = {
  offered: { bg: "#fff3d6", color: "#8a5a00" },
  declined: { bg: "#fff3d6", color: "#8a5a00" },
  scheduled: { bg: "#dff5e8", color: "#137b4e" },
  in_progress: { bg: "#e3f0fb", color: "#1b5e9e" },
  completed: { bg: "#eef0f2", color: "#4b5563" },
  cancelled: { bg: "#ffe6ea", color: "#b0384f" },
  needs_review: { bg: "#f4ecfe", color: "#6d28d9" },
};

export default async function AdminBookingsPage() {
  const { supabase, user } = await requireAdminPage();
  const { data, error } = await supabase
    .from("bookings")
    .select(
      "id, status, scheduled_at, created_at, customer_email, address, provider_delay_minutes, packages(name, duration_minutes), providers(display_name)",
    )
    .order("scheduled_at", { ascending: false })
    .limit(150);

  const bookings = data ?? [];
  const upcoming = bookings.filter(
    (booking) =>
      ["offered", "declined", "scheduled", "in_progress"].includes(
        booking.status,
      ) && new Date(booking.scheduled_at).getTime() >= Date.now() - 86400000,
  );
  const needsReview = bookings.filter(
    (booking) => booking.status === "needs_review",
  ).length;

  return (
    <main style={page}>
      <AdminNav email={user.email ?? "Admin"} />
      <div style={inner}>
        <p style={eyebrow}>Operations</p>
        <h1 style={title}>Bookings &amp; schedule</h1>
        <p style={lede}>
          View every booking and make audited schedule changes. Cancellations
          involving payment are handled through the Resolution desk.
        </p>

        <div style={stats}>
          <Stat label="All bookings" value={bookings.length} />
          <Stat label="Upcoming/live" value={upcoming.length} />
          <Stat label="Needs review" value={needsReview} />
        </div>

        {error ? (
          <div style={errorBox}>Could not load bookings: {error.message}</div>
        ) : bookings.length === 0 ? (
          <div style={empty}>No bookings have been created yet.</div>
        ) : (
          <div style={{ display: "grid", gap: 11 }}>
            {bookings.map((booking) => {
              const pkg = one(booking.packages as never) as {
                name: string;
                duration_minutes: number | null;
              } | null;
              const provider = one(booking.providers as never) as {
                display_name: string | null;
              } | null;
              const tone = STATUS[booking.status] ?? STATUS.completed;
              const canMove = ["offered", "declined", "scheduled"].includes(
                booking.status,
              );

              return (
                <article key={booking.id} style={card}>
                  <div style={{ minWidth: 0 }}>
                    <div style={cardTop}>
                      <strong style={service}>
                        {pkg?.name ?? "Service"}
                        {pkg?.duration_minutes
                          ? ` · ${pkg.duration_minutes} min`
                          : ""}
                      </strong>
                      <span
                        style={{
                          ...badge,
                          background: tone.bg,
                          color: tone.color,
                        }}
                      >
                        {booking.status.replaceAll("_", " ")}
                      </span>
                    </div>
                    <p style={dateText}>{when(booking.scheduled_at)}</p>
                    <p style={meta}>
                      Client: {booking.customer_email ?? "Unknown"} · Cleaner:{" "}
                      {provider?.display_name ?? "Not assigned"}
                    </p>
                    <p style={meta}>{booking.address ?? "No address saved"}</p>
                    {booking.provider_delay_minutes && (
                      <p style={delay}>
                        Cleaner reported {booking.provider_delay_minutes} minutes
                        late
                      </p>
                    )}
                    <small style={reference}>
                      #{booking.id.slice(0, 8).toUpperCase()}
                    </small>
                  </div>
                  {canMove ? (
                    <BookingScheduleControl
                      bookingId={booking.id}
                      scheduledAt={booking.scheduled_at}
                      postcode={booking.address}
                      durationMinutes={pkg?.duration_minutes ?? null}
                    />
                  ) : booking.status === "needs_review" ? (
                    <a href="/admin/review" style={actionLink}>
                      Open report
                    </a>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={statCard}>
      <strong style={{ fontSize: 25 }}>{value}</strong>
      <span style={{ color: "#7a828c", fontSize: 12.5 }}>{label}</span>
    </div>
  );
}

const page: React.CSSProperties = { minHeight: "100vh", background: "#f7f8fa", color: "#16202a", fontFamily: "'Nunito', system-ui, sans-serif", paddingBottom: 80 };
const inner: React.CSSProperties = { maxWidth: 1050, margin: "0 auto", padding: "0 20px" };
const eyebrow: React.CSSProperties = { margin: "0 0 5px", color: "#6d28d9", fontSize: 11, fontWeight: 900, letterSpacing: "0.13em", textTransform: "uppercase" };
const title: React.CSSProperties = { margin: "0 0 6px", fontSize: 34, fontWeight: 900, letterSpacing: "-0.025em" };
const lede: React.CSSProperties = { maxWidth: 720, margin: "0 0 24px", color: "#68717d", fontSize: 14.5, lineHeight: 1.55 };
const stats: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 24 };
const statCard: React.CSSProperties = { display: "grid", gap: 2, border: "1px solid #e5e7eb", borderRadius: 13, padding: "15px 17px", background: "#fff" };
const card: React.CSSProperties = { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 18, alignItems: "center", border: "1px solid #e5e7eb", borderRadius: 15, padding: "16px 18px", background: "#fff" };
const cardTop: React.CSSProperties = { display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" };
const service: React.CSSProperties = { fontSize: 15.5, fontWeight: 900 };
const badge: React.CSSProperties = { borderRadius: 999, padding: "4px 9px", fontSize: 10.5, fontWeight: 900, textTransform: "capitalize" };
const dateText: React.CSSProperties = { margin: "5px 0 3px", color: "#293440", fontSize: 13.5, fontWeight: 850 };
const meta: React.CSSProperties = { margin: "2px 0", color: "#68717d", fontSize: 12.5, overflowWrap: "anywhere" };
const delay: React.CSSProperties = { display: "inline-block", margin: "7px 0 0", borderRadius: 999, padding: "4px 9px", background: "#fff0c9", color: "#845500", fontSize: 11, fontWeight: 850 };
const reference: React.CSSProperties = { display: "block", marginTop: 6, color: "#9aa1aa", fontSize: 10.5 };
const actionLink: React.CSSProperties = { border: "1px solid #d8c8f5", borderRadius: 9, padding: "8px 11px", color: "#6d28d9", fontSize: 12, fontWeight: 850, textDecoration: "none" };
const empty: React.CSSProperties = { border: "1px dashed #d8dde3", borderRadius: 15, padding: 30, background: "#fff", color: "#7a828c", textAlign: "center" };
const errorBox: React.CSSProperties = { ...empty, borderColor: "#f0c5cf", background: "#fff7f8", color: "#a52e47" };

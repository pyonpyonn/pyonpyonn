import Link from "next/link";
import AdminNav from "../../AdminNav";
import { requireAdminPage } from "@/lib/adminSession";

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function money(value: number | null | undefined) {
  return `£${Number(value ?? 0).toFixed(2)}`;
}

function when(value: string) {
  return new Date(value).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

export default async function CustomerRecordPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { supabase, user } = await requireAdminPage();
  const [profileResult, bookingsResult] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, email, full_name, phone, address, postcode, client_rating_avg, client_rating_count, created_at")
      .eq("id", id)
      .eq("role", "customer")
      .maybeSingle(),
    supabase
      .from("bookings")
      .select("id, status, scheduled_at, created_at, address, packages(name, duration_minutes), providers(display_name)")
      .eq("customer_id", id)
      .order("scheduled_at", { ascending: false }),
  ]);

  const profile = profileResult.data;
  const bookings = bookingsResult.data ?? [];
  const bookingIds = bookings.map((booking) => booking.id);
  const [paymentsResult, eventsResult] = await Promise.all([
    bookingIds.length
      ? supabase
          .from("payments")
          .select("booking_id, gross_amount, status, kind, created_at")
          .in("booking_id", bookingIds)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] }),
    bookingIds.length
      ? supabase
          .from("booking_events")
          .select("booking_id, to_status, created_at")
          .in("booking_id", bookingIds)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] }),
  ]);

  if (!profile) {
    return <RecordMissing email={user.email ?? "Admin"} label="Customer" />;
  }

  const payments = paymentsResult.data ?? [];
  const events = eventsResult.data ?? [];
  const completed = bookings.filter((booking) => booking.status === "completed").length;
  const paid = payments
    .filter((payment) => payment.status === "succeeded" && payment.kind !== "tip")
    .reduce((sum, payment) => sum + Number(payment.gross_amount ?? 0), 0);

  return (
    <main style={page}>
      <AdminNav email={user.email ?? "Admin"} />
      <div style={inner}>
        <Link href="/admin/customers" style={back}>← Customers</Link>
        <section style={hero}>
          <div style={avatar}>{(profile.full_name ?? profile.email ?? "C").charAt(0).toUpperCase()}</div>
          <div>
            <p style={eyebrow}>Customer record</p>
            <h1 style={title}>{profile.full_name ?? "Unnamed customer"}</h1>
            <p style={muted}>{profile.email ?? "No email"} · {profile.phone ?? "No phone"}</p>
            <p style={muted}>{profile.address ?? "No saved address"} · {profile.postcode ?? "No postcode"}</p>
          </div>
        </section>

        <div style={stats}>
          <Stat label="Bookings" value={String(bookings.length)} />
          <Stat label="Completed" value={String(completed)} />
          <Stat label="Successful charges" value={money(paid)} />
          <Stat label="Client rating" value={profile.client_rating_avg ? `${Number(profile.client_rating_avg).toFixed(1)} ★ (${profile.client_rating_count ?? 0})` : "Not rated"} />
        </div>

        <h2 style={sectionTitle}>Booking and payment history</h2>
        {bookings.length === 0 ? <div style={empty}>No bookings for this customer.</div> : (
          <div style={list}>
            {bookings.map((booking) => {
              const pkg = one(booking.packages as never) as { name: string; duration_minutes: number | null } | null;
              const provider = one(booking.providers as never) as { display_name: string | null } | null;
              const bookingPayments = payments.filter((payment) => payment.booking_id === booking.id);
              const flow = events.filter((event) => event.booking_id === booking.id);
              return (
                <article key={booking.id} style={recordCard}>
                  <div style={recordTop}>
                    <div>
                      <strong>{pkg?.name ?? "Service"}{pkg?.duration_minutes ? ` · ${pkg.duration_minutes} min` : ""}</strong>
                      <p style={muted}>{when(booking.scheduled_at)} · {provider?.display_name ?? "No professional assigned"}</p>
                      <p style={muted}>{booking.address ?? "No address"}</p>
                    </div>
                    <span style={status}>{booking.status.replaceAll("_", " ")}</span>
                  </div>
                  <div style={flowRow}>
                    <b>Booking flow</b>
                    <span>{flow.length ? flow.map((event) => event.to_status.replaceAll("_", " ")).join(" → ") : booking.status.replaceAll("_", " ")}</span>
                  </div>
                  <div style={flowRow}>
                    <b>Payment flow</b>
                    <span>{bookingPayments.length ? bookingPayments.map((payment) => `${payment.kind ?? "visit"}: ${payment.status} · ${money(payment.gross_amount)}`).join(" | ") : "No payment record"}</span>
                  </div>
                  <small style={reference}>Booking #{booking.id.slice(0, 8).toUpperCase()} · created {when(booking.created_at)}</small>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div style={stat}><strong>{value}</strong><span>{label}</span></div>;
}

function RecordMissing({ email, label }: { email: string; label: string }) {
  return <main style={page}><AdminNav email={email} /><div style={inner}><Link href="/admin/customers" style={back}>← Customers</Link><div style={empty}>{label} record not found.</div></div></main>;
}

const page: React.CSSProperties = { minHeight: "100vh", paddingBottom: 80, background: "#f7f8fa", color: "#16202a", fontFamily: "'Nunito', system-ui, sans-serif" };
const inner: React.CSSProperties = { maxWidth: 1050, margin: "0 auto", padding: "0 20px" };
const back: React.CSSProperties = { display: "inline-block", marginBottom: 15, color: "#6d28d9", fontSize: 13, fontWeight: 900, textDecoration: "none" };
const hero: React.CSSProperties = { display: "flex", alignItems: "center", gap: 16, padding: 22, border: "1px solid #e5e7eb", borderRadius: 18, background: "#fff" };
const avatar: React.CSSProperties = { flex: "0 0 auto", display: "grid", placeItems: "center", width: 62, height: 62, borderRadius: "50%", background: "linear-gradient(135deg,#f5c542,#c86fc9 55%,#7b2ff7)", color: "#fff", fontSize: 22, fontWeight: 900 };
const eyebrow: React.CSSProperties = { margin: "0 0 3px", color: "#6d28d9", fontSize: 10.5, fontWeight: 900, letterSpacing: "0.12em", textTransform: "uppercase" };
const title: React.CSSProperties = { margin: "0 0 4px", fontSize: 28, fontWeight: 900 };
const muted: React.CSSProperties = { margin: "3px 0", color: "#68717d", fontSize: 12.5, overflowWrap: "anywhere" };
const stats: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(155px,1fr))", gap: 10, margin: "18px 0 28px" };
const stat: React.CSSProperties = { display: "grid", gap: 3, padding: "15px 17px", border: "1px solid #e5e7eb", borderRadius: 13, background: "#fff" };
const sectionTitle: React.CSSProperties = { margin: "0 0 13px", fontSize: 20, fontWeight: 900 };
const list: React.CSSProperties = { display: "grid", gap: 11 };
const recordCard: React.CSSProperties = { padding: "17px 18px", border: "1px solid #e5e7eb", borderRadius: 15, background: "#fff" };
const recordTop: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 14, flexWrap: "wrap" };
const status: React.CSSProperties = { height: "fit-content", borderRadius: 999, padding: "5px 10px", background: "#f4ecfe", color: "#6d28d9", fontSize: 10.5, fontWeight: 900, textTransform: "capitalize" };
const flowRow: React.CSSProperties = { display: "grid", gridTemplateColumns: "110px minmax(0,1fr)", gap: 9, marginTop: 11, paddingTop: 10, borderTop: "1px solid #eef0f2", color: "#5f6874", fontSize: 12, overflowWrap: "anywhere" };
const reference: React.CSSProperties = { display: "block", marginTop: 10, color: "#9aa1aa", fontSize: 10.5 };
const empty: React.CSSProperties = { padding: 28, border: "1px dashed #d8dde3", borderRadius: 15, background: "#fff", color: "#7a828c", textAlign: "center" };

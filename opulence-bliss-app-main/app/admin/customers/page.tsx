import AdminNav from "../AdminNav";
import Link from "next/link";
import { requireAdminPage } from "@/lib/adminSession";

export default async function AdminCustomersPage() {
  const { supabase, user } = await requireAdminPage();
  const [profilesResult, bookingsResult] = await Promise.all([
    supabase
      .from("profiles")
      .select(
        "id, email, full_name, phone, address, postcode, client_rating_avg, client_rating_count",
      )
      .eq("role", "customer")
      .order("full_name", { ascending: true }),
    supabase.from("bookings").select("customer_id, status, scheduled_at"),
  ]);

  const profiles = profilesResult.data ?? [];
  const bookingMap = new Map<string, { total: number; completed: number; next: string | null }>();
  for (const booking of bookingsResult.data ?? []) {
    if (!booking.customer_id) continue;
    const current = bookingMap.get(booking.customer_id) ?? {
      total: 0,
      completed: 0,
      next: null,
    };
    current.total += 1;
    if (booking.status === "completed") current.completed += 1;
    if (
      ["offered", "declined", "scheduled"].includes(booking.status) &&
      new Date(booking.scheduled_at).getTime() > Date.now() &&
      (!current.next || booking.scheduled_at < current.next)
    ) {
      current.next = booking.scheduled_at;
    }
    bookingMap.set(booking.customer_id, current);
  }

  return (
    <main style={page}>
      <AdminNav email={user.email ?? "Admin"} />
      <div style={inner}>
        <p style={eyebrow}>People</p>
        <h1 style={title}>Customers</h1>
        <p style={lede}>
          Contact details, booking history and the next scheduled visit for each
          customer.
        </p>

        {profilesResult.error ? (
          <div style={errorBox}>{profilesResult.error.message}</div>
        ) : profiles.length === 0 ? (
          <div style={empty}>No customer accounts yet.</div>
        ) : (
          <div style={grid}>
            {profiles.map((profile) => {
              const summary = bookingMap.get(profile.id) ?? {
                total: 0,
                completed: 0,
                next: null,
              };
              return (
                <article key={profile.id} style={card}>
                  <div style={avatar}>
                    {(profile.full_name ?? profile.email ?? "C")
                      .charAt(0)
                      .toUpperCase()}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <h2 style={name}>{profile.full_name ?? "Unnamed customer"}</h2>
                    <p style={email}>{profile.email ?? "No email"}</p>
                    <p style={details}>
                      {profile.phone ?? "No phone"} · {profile.postcode ?? "No postcode"}
                    </p>
                    <p style={details}>{profile.address ?? "No saved address"}</p>
                    <div style={facts}>
                      <span>{summary.total} bookings</span>
                      <span>{summary.completed} completed</span>
                      <span>
                        {profile.client_rating_avg
                          ? `${Number(profile.client_rating_avg).toFixed(1)} ★ (${profile.client_rating_count ?? 0})`
                          : "Not rated"}
                      </span>
                    </div>
                    {summary.next && (
                      <p style={nextVisit}>
                        Next: {new Date(summary.next).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: true })}
                      </p>
                    )}
                    <Link href={`/admin/customers/${profile.id}`} style={viewLink}>
                      View full customer record →
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

const page: React.CSSProperties = { minHeight: "100vh", background: "#f7f8fa", color: "#16202a", fontFamily: "'Nunito', system-ui, sans-serif", paddingBottom: 80 };
const inner: React.CSSProperties = { maxWidth: 1050, margin: "0 auto", padding: "0 20px" };
const eyebrow: React.CSSProperties = { margin: "0 0 5px", color: "#6d28d9", fontSize: 11, fontWeight: 900, letterSpacing: "0.13em", textTransform: "uppercase" };
const title: React.CSSProperties = { margin: "0 0 6px", fontSize: 34, fontWeight: 900 };
const lede: React.CSSProperties = { margin: "0 0 24px", color: "#68717d", fontSize: 14.5 };
const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 430px), 1fr))", gap: 12 };
const card: React.CSSProperties = { display: "grid", gridTemplateColumns: "48px minmax(0, 1fr)", gap: 14, border: "1px solid #e5e7eb", borderRadius: 15, padding: 17, background: "#fff" };
const avatar: React.CSSProperties = { display: "grid", placeItems: "center", width: 48, height: 48, borderRadius: "50%", background: "linear-gradient(135deg,#f5c542,#c86fc9 55%,#7b2ff7)", color: "#fff", fontSize: 18, fontWeight: 900 };
const name: React.CSSProperties = { margin: "0 0 2px", fontSize: 16, fontWeight: 900 };
const email: React.CSSProperties = { margin: "0 0 6px", color: "#4b5563", fontSize: 12.5, overflowWrap: "anywhere" };
const details: React.CSSProperties = { margin: "2px 0", color: "#7a828c", fontSize: 12, overflowWrap: "anywhere" };
const facts: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 };
const nextVisit: React.CSSProperties = { margin: "9px 0 0", color: "#6d28d9", fontSize: 12, fontWeight: 850 };
const viewLink: React.CSSProperties = { display: "inline-block", marginTop: 11, color: "#6d28d9", fontSize: 12, fontWeight: 900, textDecoration: "none" };
const empty: React.CSSProperties = { border: "1px dashed #d8dde3", borderRadius: 15, padding: 30, background: "#fff", color: "#7a828c", textAlign: "center" };
const errorBox: React.CSSProperties = { ...empty, borderColor: "#f0c5cf", background: "#fff7f8", color: "#a52e47" };

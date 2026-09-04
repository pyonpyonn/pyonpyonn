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
  return new Date(value).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
}

export default async function ProfessionalRecordPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user } = await requireAdminPage();
  const [providerResult, bookingsResult, hoursResult] = await Promise.all([
    supabase
      .from("providers")
      .select("id, profile_id, display_name, services, vetting_status, joining_fee_paid, rating_avg, rating_count, years_experience, created_at, profiles(email, full_name, phone, address, postcode)")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("bookings")
      .select("id, status, scheduled_at, created_at, customer_email, address, provider_payout, packages(name, duration_minutes)")
      .eq("provider_id", id)
      .order("scheduled_at", { ascending: false }),
    supabase
      .from("provider_availability")
      .select("weekday, start_time, end_time")
      .eq("provider_id", id)
      .order("weekday"),
  ]);

  const provider = providerResult.data;
  if (!provider) {
    return <main style={page}><AdminNav email={user.email ?? "Admin"} /><div style={inner}><Link href="/admin/cleaners" style={back}>← Professionals</Link><div style={empty}>Professional record not found.</div></div></main>;
  }

  const profile = one(provider.profiles as never) as { email: string | null; full_name: string | null; phone: string | null; address: string | null; postcode: string | null } | null;
  const bookings = bookingsResult.data ?? [];
  const bookingIds = bookings.map((booking) => booking.id);
  const [paymentsResult, payoutsResult, eventsResult] = await Promise.all([
    bookingIds.length ? supabase.from("payments").select("booking_id, split_breakdown, status, kind, created_at").in("booking_id", bookingIds).order("created_at") : Promise.resolve({ data: [] }),
    bookingIds.length ? supabase.from("payouts").select("booking_id, amount, status, note, created_at").in("booking_id", bookingIds).order("created_at") : Promise.resolve({ data: [] }),
    bookingIds.length ? supabase.from("booking_events").select("booking_id, to_status, created_at").in("booking_id", bookingIds).order("created_at") : Promise.resolve({ data: [] }),
  ]);
  const payments = paymentsResult.data ?? [];
  const payouts = payoutsResult.data ?? [];
  const events = eventsResult.data ?? [];
  const completed = bookings.filter((booking) => booking.status === "completed").length;
  const released = payouts.filter((payout) => payout.status === "paid").reduce((sum, payout) => sum + Number(payout.amount ?? 0), 0);

  return (
    <main style={page}>
      <AdminNav email={user.email ?? "Admin"} />
      <div style={inner}>
        <Link href="/admin/cleaners" style={back}>← Professionals</Link>
        <section style={hero}>
          <div style={avatar}>{(provider.display_name ?? profile?.email ?? "P").charAt(0).toUpperCase()}</div>
          <div>
            <p style={eyebrow}>Professional record</p>
            <h1 style={title}>{provider.display_name ?? profile?.full_name ?? "Unnamed professional"}</h1>
            <p style={muted}>{profile?.email ?? "No email"} · {profile?.phone ?? "No phone"}</p>
            <p style={muted}>{(provider.services ?? []).join(", ") || "No services"} · {provider.years_experience ?? 0}+ years · {provider.vetting_status}</p>
          </div>
        </section>

        <div style={stats}>
          <Stat label="Jobs" value={String(bookings.length)} />
          <Stat label="Completed" value={String(completed)} />
          <Stat label="Released payouts" value={money(released)} />
          <Stat label="Professional rating" value={provider.rating_avg ? `${Number(provider.rating_avg).toFixed(1)} ★ (${provider.rating_count ?? 0})` : "Not rated"} />
        </div>

        <section style={availability}>
          <strong>Availability</strong>
          <span>{hoursResult.data?.length ? hoursResult.data.map((row) => `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][row.weekday] ?? row.weekday} ${String(row.start_time).slice(0, 5)}–${String(row.end_time).slice(0, 5)}`).join(" · ") : "No working hours saved"}</span>
        </section>

        <h2 style={sectionTitle}>Work, booking and payout history</h2>
        {bookings.length === 0 ? <div style={empty}>No jobs for this professional.</div> : (
          <div style={list}>
            {bookings.map((booking) => {
              const pkg = one(booking.packages as never) as { name: string; duration_minutes: number | null } | null;
              const bookingPayments = payments.filter((payment) => payment.booking_id === booking.id);
              const bookingPayouts = payouts.filter((payout) => payout.booking_id === booking.id);
              const flow = events.filter((event) => event.booking_id === booking.id);
              const providerShare = bookingPayments.reduce((sum, payment) => sum + Number((payment.split_breakdown as { provider?: number } | null)?.provider ?? 0), 0);
              return (
                <article key={booking.id} style={recordCard}>
                  <div style={recordTop}>
                    <div>
                      <strong>{pkg?.name ?? "Service"}{pkg?.duration_minutes ? ` · ${pkg.duration_minutes} min` : ""}</strong>
                      <p style={muted}>{when(booking.scheduled_at)} · {booking.customer_email ?? "Unknown customer"}</p>
                      <p style={muted}>{booking.address ?? "No address"}</p>
                    </div>
                    <span style={status}>{booking.status.replaceAll("_", " ")}</span>
                  </div>
                  <div style={flowRow}><b>Work flow</b><span>{flow.length ? flow.map((event) => event.to_status.replaceAll("_", " ")).join(" → ") : booking.status.replaceAll("_", " ")}</span></div>
                  <div style={flowRow}><b>Payment</b><span>{bookingPayments.length ? bookingPayments.map((payment) => `${payment.kind ?? "visit"}: ${payment.status}`).join(" | ") + ` · provider share ${money(providerShare)}` : "No visit payment record"}</span></div>
                  <div style={flowRow}><b>Payout</b><span>{bookingPayouts.length ? bookingPayouts.map((payout) => `${payout.status} · ${money(payout.amount)}`).join(" | ") : booking.provider_payout ? `Expected ${money(booking.provider_payout)}` : "No payout record"}</span></div>
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

function Stat({ label, value }: { label: string; value: string }) { return <div style={stat}><strong>{value}</strong><span>{label}</span></div>; }

const page: React.CSSProperties = { minHeight: "100vh", paddingBottom: 80, background: "#f7f8fa", color: "#16202a", fontFamily: "'Nunito', system-ui, sans-serif" };
const inner: React.CSSProperties = { maxWidth: 1050, margin: "0 auto", padding: "0 20px" };
const back: React.CSSProperties = { display: "inline-block", marginBottom: 15, color: "#6d28d9", fontSize: 13, fontWeight: 900, textDecoration: "none" };
const hero: React.CSSProperties = { display: "flex", alignItems: "center", gap: 16, padding: 22, border: "1px solid #e5e7eb", borderRadius: 18, background: "#fff" };
const avatar: React.CSSProperties = { flex: "0 0 auto", display: "grid", placeItems: "center", width: 62, height: 62, borderRadius: "50%", background: "#f4ecfe", color: "#6d28d9", fontSize: 22, fontWeight: 900 };
const eyebrow: React.CSSProperties = { margin: "0 0 3px", color: "#6d28d9", fontSize: 10.5, fontWeight: 900, letterSpacing: "0.12em", textTransform: "uppercase" };
const title: React.CSSProperties = { margin: "0 0 4px", fontSize: 28, fontWeight: 900 };
const muted: React.CSSProperties = { margin: "3px 0", color: "#68717d", fontSize: 12.5, overflowWrap: "anywhere" };
const stats: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(155px,1fr))", gap: 10, margin: "18px 0" };
const stat: React.CSSProperties = { display: "grid", gap: 3, padding: "15px 17px", border: "1px solid #e5e7eb", borderRadius: 13, background: "#fff" };
const availability: React.CSSProperties = { display: "grid", gap: 5, marginBottom: 28, padding: "15px 17px", border: "1px solid #e4d8f7", borderRadius: 13, background: "#faf7ff", color: "#5f6874", fontSize: 12.5 };
const sectionTitle: React.CSSProperties = { margin: "0 0 13px", fontSize: 20, fontWeight: 900 };
const list: React.CSSProperties = { display: "grid", gap: 11 };
const recordCard: React.CSSProperties = { padding: "17px 18px", border: "1px solid #e5e7eb", borderRadius: 15, background: "#fff" };
const recordTop: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 14, flexWrap: "wrap" };
const status: React.CSSProperties = { height: "fit-content", borderRadius: 999, padding: "5px 10px", background: "#f4ecfe", color: "#6d28d9", fontSize: 10.5, fontWeight: 900, textTransform: "capitalize" };
const flowRow: React.CSSProperties = { display: "grid", gridTemplateColumns: "95px minmax(0,1fr)", gap: 9, marginTop: 11, paddingTop: 10, borderTop: "1px solid #eef0f2", color: "#5f6874", fontSize: 12, overflowWrap: "anywhere" };
const reference: React.CSSProperties = { display: "block", marginTop: 10, color: "#9aa1aa", fontSize: 10.5 };
const empty: React.CSSProperties = { padding: 28, border: "1px dashed #d8dde3", borderRadius: 15, background: "#fff", color: "#7a828c", textAlign: "center" };

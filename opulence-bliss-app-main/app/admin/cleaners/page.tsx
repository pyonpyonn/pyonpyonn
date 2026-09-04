import AdminNav from "../AdminNav";
import Link from "next/link";
import VettingButtons from "../VettingButtons";
import { requireAdminPage } from "@/lib/adminSession";

function profileOf(value: unknown) {
  if (Array.isArray(value)) return value[0] as { email?: string } | undefined;
  return value as { email?: string } | null;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function AdminCleanersPage() {
  const { supabase, user } = await requireAdminPage();
  const [providersResult, availabilityResult, jobsResult] = await Promise.all([
    supabase
      .from("providers")
      .select(
        "id, display_name, services, vetting_status, joining_fee_paid, rating_avg, rating_count, years_experience, profiles(email)",
      )
      .order("display_name", { ascending: true }),
    supabase
      .from("provider_availability")
      .select("provider_id, weekday, start_time, end_time")
      .order("weekday", { ascending: true }),
    supabase.from("bookings").select("provider_id, status"),
  ]);

  const providers = providersResult.data ?? [];
  const hoursByProvider = new Map<string, string[]>();
  for (const row of availabilityResult.data ?? []) {
    const rows = hoursByProvider.get(row.provider_id) ?? [];
    rows.push(
      `${DAYS[row.weekday] ?? row.weekday} ${String(row.start_time).slice(0, 5)}–${String(row.end_time).slice(0, 5)}`,
    );
    hoursByProvider.set(row.provider_id, rows);
  }
  const jobsByProvider = new Map<string, { completed: number; upcoming: number }>();
  for (const job of jobsResult.data ?? []) {
    if (!job.provider_id) continue;
    const summary = jobsByProvider.get(job.provider_id) ?? {
      completed: 0,
      upcoming: 0,
    };
    if (job.status === "completed") summary.completed += 1;
    if (["scheduled", "in_progress"].includes(job.status)) summary.upcoming += 1;
    jobsByProvider.set(job.provider_id, summary);
  }

  return (
    <main style={page}>
      <AdminNav email={user.email ?? "Admin"} />
      <div style={inner}>
        <p style={eyebrow}>Workforce</p>
        <h1 style={title}>Cleaners &amp; professionals</h1>
        <p style={lede}>
          Review applications, approval status, skills, availability and current
          workload.
        </p>

        {providersResult.error ? (
          <div style={errorBox}>{providersResult.error.message}</div>
        ) : providers.length === 0 ? (
          <div style={empty}>No cleaner accounts yet.</div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {providers.map((provider) => {
              const profile = profileOf(provider.profiles);
              const hours = hoursByProvider.get(provider.id) ?? [];
              const jobs = jobsByProvider.get(provider.id) ?? {
                completed: 0,
                upcoming: 0,
              };
              const pending = provider.vetting_status === "pending";

              return (
                <article key={provider.id} style={card}>
                  <div style={avatar}>
                    {(provider.display_name ?? profile?.email ?? "P")
                      .charAt(0)
                      .toUpperCase()}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={topline}>
                      <h2 style={name}>
                        {provider.display_name ?? "Unnamed professional"}
                      </h2>
                      <span
                        style={{
                          ...status,
                          background:
                            provider.vetting_status === "approved"
                              ? "#dff5e8"
                              : pending
                                ? "#fff3d6"
                                : "#ffe6ea",
                          color:
                            provider.vetting_status === "approved"
                              ? "#137b4e"
                              : pending
                                ? "#8a5a00"
                                : "#b0384f",
                        }}
                      >
                        {provider.vetting_status}
                      </span>
                    </div>
                    <p style={email}>{profile?.email ?? "No email"}</p>
                    <p style={meta}>
                      {(provider.services ?? []).join(", ") || "No services set"}
                      {provider.years_experience
                        ? ` · ${provider.years_experience}+ years experience`
                        : ""}
                    </p>
                    <p style={meta}>
                      {provider.rating_avg
                        ? `${Number(provider.rating_avg).toFixed(1)} ★ (${provider.rating_count ?? 0})`
                        : "Not rated"}
                      {` · ${jobs.completed} completed · ${jobs.upcoming} upcoming`}
                    </p>
                    <p style={hoursText}>
                      <strong>Hours:</strong>{" "}
                      {hours.length ? hours.join(" · ") : "Not available"}
                    </p>
                    <span style={fee}>
                      {provider.joining_fee_paid ? "Joining fee paid" : "Joining fee unpaid"}
                    </span>
                    <div>
                      <Link href={`/admin/cleaners/${provider.id}`} style={viewLink}>
                        View full professional record →
                      </Link>
                    </div>
                  </div>
                  <div>
                    <VettingButtons id={provider.id} />
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
const card: React.CSSProperties = { display: "grid", gridTemplateColumns: "52px minmax(0, 1fr) auto", alignItems: "start", gap: 14, border: "1px solid #e5e7eb", borderRadius: 15, padding: 17, background: "#fff" };
const avatar: React.CSSProperties = { display: "grid", placeItems: "center", width: 52, height: 52, borderRadius: "50%", background: "#f4ecfe", color: "#6d28d9", fontSize: 19, fontWeight: 900 };
const topline: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };
const name: React.CSSProperties = { margin: 0, fontSize: 16.5, fontWeight: 900 };
const status: React.CSSProperties = { borderRadius: 999, padding: "4px 9px", fontSize: 10.5, fontWeight: 900, textTransform: "capitalize" };
const email: React.CSSProperties = { margin: "3px 0 7px", color: "#4b5563", fontSize: 12.5, overflowWrap: "anywhere" };
const meta: React.CSSProperties = { margin: "3px 0", color: "#68717d", fontSize: 12.5 };
const hoursText: React.CSSProperties = { margin: "8px 0", color: "#4b5563", fontSize: 11.5, lineHeight: 1.5 };
const fee: React.CSSProperties = { display: "inline-block", borderRadius: 999, padding: "4px 8px", background: "#f1f2f4", color: "#59616d", fontSize: 10.5, fontWeight: 800 };
const viewLink: React.CSSProperties = { display: "inline-block", marginTop: 10, color: "#6d28d9", fontSize: 12, fontWeight: 900, textDecoration: "none" };
const empty: React.CSSProperties = { border: "1px dashed #d8dde3", borderRadius: 15, padding: 30, background: "#fff", color: "#7a828c", textAlign: "center" };
const errorBox: React.CSSProperties = { ...empty, borderColor: "#f0c5cf", background: "#fff7f8", color: "#a52e47" };

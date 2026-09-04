// Provider earnings — what you've made and what's coming.
// Save at: app/worker/earnings/page.tsx

import { createClient } from "@/lib/supabase/server";
import { SignedOut } from "@/app/account/page";

const gbp = (n: number) =>
  "£" + Number(n || 0).toLocaleString("en-GB", { minimumFractionDigits: 2 });

type Bk = {
  scheduled_at: string;
  status: string;
  packages: { name: string } | { name: string }[] | null;
};

type Pay = {
  id: string;
  gross_amount: number;
  split_breakdown: { provider?: number } | null;
  status: string;
  kind: string | null;
  created_at: string;
  bookings: Bk | Bk[] | null;
};

function one<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function svc(p: Pay) {
  const b = one<Bk>(p.bookings);
  const pk = one<{ name: string }>(b?.packages ?? null);
  return pk?.name ?? "Service";
}

export default async function EarningsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return <SignedOut area="provider" />;

  const { data: prov } = await supabase
    .from("providers")
    .select("id, rating_avg, rating_count, joining_fee_paid")
    .eq("profile_id", user.id)
    .maybeSingle();

  const { data: paysData } = await supabase
    .from("payments")
    .select(
      "id, gross_amount, split_breakdown, status, kind, created_at, bookings(scheduled_at, status, packages(name))",
    )
    .order("created_at", { ascending: false });

  // Membership visits are paid by transfer, recorded in payouts.
  const { data: payoutData } = await supabase
    .from("payouts")
    .select(
      "id, amount, status, note, created_at, bookings(scheduled_at, status, packages(name))",
    )
    .order("created_at", { ascending: false });

  const pays = (paysData ?? []) as unknown as Pay[];
  const share = (p: Pay) => Number(p.split_breakdown?.provider ?? 0);

  const jobs = pays.filter((p) => p.kind !== "tip");
  const tips = pays.filter((p) => p.kind === "tip" && p.status === "succeeded");

  const paid = jobs.filter((p) => p.status === "succeeded");
  const held = jobs.filter((p) => p.status === "pending");

  // Membership visits, paid by transfer
  type Payout = {
    id: string;
    amount: number;
    status: string;
    note: string | null;
    created_at: string;
    bookings: Bk | Bk[] | null;
  };
  const payouts = (payoutData ?? []) as unknown as Payout[];
  const payoutsPaid = payouts.filter((p) => p.status === "paid");

  const earned =
    paid.reduce((s, p) => s + share(p), 0) +
    payoutsPaid.reduce((s, p) => s + Number(p.amount ?? 0), 0);
  const pendingTotal =
    held.reduce((s, p) => s + share(p), 0) +
    payouts
      .filter((p) => p.status === "pending")
      .reduce((s, p) => s + Number(p.amount ?? 0), 0);
  const tipTotal = tips.reduce((s, p) => s + share(p), 0);
  const visitCount = paid.length + payoutsPaid.length;

  // One combined list, newest first
  const rows: {
    key: string;
    service: string;
    when: string | null;
    label: string;
    amount: number;
    state: string;
    note?: string | null;
    gross?: number;
  }[] = [
    ...pays.map((p) => ({
      key: `pay-${p.id}`,
      service: p.kind === "tip" ? `Tip · ${svc(p)}` : svc(p),
      when: one<Bk>(p.bookings)?.scheduled_at ?? null,
      label: `customer paid ${gbp(p.gross_amount)}`,
      amount: share(p),
      state:
        p.status === "succeeded"
          ? "Paid"
          : p.status === "refunded"
            ? "Cancelled"
            : "Pending",
      gross: p.gross_amount,
    })),
    ...payouts.map((p) => ({
      key: `out-${p.id}`,
      service: `Membership visit · ${
        one<{ name: string }>(one<Bk>(p.bookings)?.packages ?? null)?.name ??
        "Service"
      }`,
      when: one<Bk>(p.bookings)?.scheduled_at ?? null,
      label: "paid from membership",
      amount: Number(p.amount ?? 0),
      state: p.status === "paid" ? "Paid" : "Pending",
      note: p.note,
    })),
  ].sort((a, b) => {
    const x = a.when ? new Date(a.when).getTime() : 0;
    const y = b.when ? new Date(b.when).getTime() : 0;
    return y - x;
  });

  return (
    <main style={wrap}>
      <link rel="stylesheet" href={FONTS} />
      <div style={{ maxWidth: 760 }}>
        <h1 style={h1}>My status</h1>
        <p style={{ color: "#7A828C", margin: "0 0 26px", fontWeight: 600 }}>
          Where you stand — earnings, ratings and what&apos;s still to come.
        </p>

        <div style={statGrid}>
          <Stat label="Paid to you" value={gbp(earned + tipTotal)} big />
          <Stat label="Awaiting completion" value={gbp(pendingTotal)} />
          <Stat label="Tips received" value={gbp(tipTotal)} />
          <Stat label="Visits completed" value={String(visitCount)} />
          <Stat
            label="Your rating"
            value={
              prov?.rating_avg
                ? `${Number(prov.rating_avg).toFixed(1)} ★ (${prov.rating_count})`
                : "No ratings yet"
            }
          />
        </div>

        <h2 style={sectionTitle}>Every payment</h2>
        {rows.length === 0 ? (
          <div style={empty}>
            No earnings yet. Once you complete a visit it&apos;ll appear here.
          </div>
        ) : (
          <div style={{ ...card, padding: "6px 22px" }}>
            {rows.map((r) => (
              <div key={r.key} style={row}>
                <div>
                  <strong style={{ fontSize: 15, color: "#16202A" }}>
                    {r.service}
                  </strong>
                  <div style={{ color: "#7A828C", fontSize: 13 }}>
                    {r.when
                      ? new Date(r.when).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })
                      : "—"}{" "}
                    · {r.label}
                  </div>
                  {r.note && (
                    <div style={{ color: "#B0384F", fontSize: 12.5 }}>
                      {r.note}
                    </div>
                  )}
                </div>
                <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <strong style={{ fontSize: 16 }}>{gbp(r.amount)}</strong>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: r.state === "Paid" ? "#16202A" : "#B0384F",
                    }}
                  >
                    {r.state}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <p style={{ marginTop: 28, display: "flex", gap: 18 }}>
          <a href="/worker" style={link}>
            ← My jobs
          </a>
          <a href="/worker/profile" style={link}>
            My profile
          </a>
          <a href="/worker/availability" style={link}>
            My availability
          </a>
        </p>
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  big,
}: {
  label: string;
  value: string;
  big?: boolean;
}) {
  return (
    <div style={{ ...card, padding: "20px 22px" }}>
      <p
        style={{
          fontFamily: "'Nunito', system-ui, sans-serif",
          fontSize: big ? 30 : 22,
          color: "#16202A",
          margin: "0 0 3px",
        }}
      >
        {value}
      </p>
      <span style={{ color: "#7A828C", fontSize: 13.5 }}>{label}</span>
    </div>
  );
}

const FONTS =
  "https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap";
const wrap: React.CSSProperties = {
  background: "transparent",
  color: "#16202A",
  fontFamily: "'Nunito', system-ui, sans-serif",
  padding: 0,
};
const card: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #EDEFF1",
  borderRadius: 16,
};
const statGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
  gap: 12,
  marginBottom: 34,
};
const row: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 14,
  padding: "15px 0",
  borderBottom: "1px solid #F1F2F4",
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
  color: "#16202A",
  margin: "0 0 14px",
};
const empty: React.CSSProperties = {
  background: "#fff",
  border: "1.5px dashed #E5E7EA",
  borderRadius: 14,
  padding: "28px 24px",
  textAlign: "center",
  color: "#7A828C",
};
const link: React.CSSProperties = { color: "#6D28D9", fontSize: 14 };

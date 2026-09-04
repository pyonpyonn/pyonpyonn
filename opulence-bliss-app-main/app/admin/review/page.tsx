// SETUP: mkdir -p "app/admin/review" && code "app/admin/review/page.tsx"
//
// The resolution desk. Read the evidence, then act deliberately.

import { createClient } from "@/lib/supabase/server";
import DeskControls, { PrototypeFindingsCleanup } from "./DeskControls";
import AdminNav from "../AdminNav";

function money(n: number | null | undefined) {
  return n === null || n === undefined ? "—" : "£" + Number(n).toFixed(2);
}

function when(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

const SEVERITY: Record<string, { bg: string; fg: string }> = {
  critical: { bg: "#FFE6EA", fg: "#B0384F" },
  warning: { bg: "#FFF3D6", fg: "#8A5A00" },
  info: { bg: "#E3F0FB", fg: "#1B5E9E" },
};

const PRIORITY: Record<string, { bg: string; fg: string }> = {
  urgent: { bg: "#FFE6EA", fg: "#B0384F" },
  high: { bg: "#FFF3D6", fg: "#8A5A00" },
  normal: { bg: "#F1F2F4", fg: "#4B5563" },
  low: { bg: "#F1F2F4", fg: "#7A828C" },
};

type FindingPayment = {
  id: string;
  status: string;
  gross_amount: number | null;
};

type FindingPayout = {
  id: string;
  status: string;
  amount: number | null;
};

export default async function ReviewDeskPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return <Denied text="Log in as an admin." />;

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (me?.role !== "admin") return <Denied text="Admins only." />;

  const { data: findings, error: findingsError } = await supabase
    .from("reconciliation_findings")
    .select("*")
    .in("status", ["open", "acknowledged"])
    .order("severity", { ascending: true })
    .order("detected_at", { ascending: false })
    .limit(100);

  const { data: cases, error: casesError } = await supabase
    .from("admin_review_queue")
    .select("*")
    .or("status.neq.resolved,refund_remaining.gt.0")
    .order("priority", { ascending: true })
    .order("opened_at", { ascending: true })
    .limit(100);

  if (findingsError || casesError) {
    return (
      <Denied
        text={`Could not load the desk: ${
          findingsError?.message ?? casesError?.message ?? "unknown error"
        }`}
      />
    );
  }

  const rows = cases ?? [];
  const openFindings = findings ?? [];

  const findingPaymentIds = [
    ...new Set(openFindings.map((finding) => finding.payment_id).filter(Boolean)),
  ] as string[];
  const findingPayoutIds = [
    ...new Set(openFindings.map((finding) => finding.payout_id).filter(Boolean)),
  ] as string[];

  const [findingPaymentsResult, findingPayoutsResult] = await Promise.all([
    findingPaymentIds.length
      ? supabase
          .from("payments")
          .select("id, status, gross_amount")
          .in("id", findingPaymentIds)
      : Promise.resolve({ data: [], error: null }),
    findingPayoutIds.length
      ? supabase
          .from("payouts")
          .select("id, status, amount")
          .in("id", findingPayoutIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (findingPaymentsResult.error || findingPayoutsResult.error) {
    return (
      <Denied
        text={`Could not load finding targets: ${
          findingPaymentsResult.error?.message ??
          findingPayoutsResult.error?.message ??
          "unknown error"
        }`}
      />
    );
  }

  const findingPayments = (findingPaymentsResult.data ?? []) as FindingPayment[];
  const findingPayouts = (findingPayoutsResult.data ?? []) as FindingPayout[];

  const paymentById = new Map<string, FindingPayment>(
    findingPayments.map((payment) => [payment.id, payment] as const)
  );
  const payoutById = new Map<string, FindingPayout>(
    findingPayouts.map((payout) => [payout.id, payout] as const)
  );
  const activeRows = rows.filter((reviewCase) => reviewCase.status !== "resolved");

  const critical = openFindings.filter((f) => f.severity === "critical").length;
  const overdue = activeRows.filter((c) => c.overdue).length;
  const unassigned = activeRows.filter((c) => !c.assigned_to).length;
  const blockingMoney = activeRows.filter(
    (c) => c.blocks_payment || c.blocks_payout
  ).length;
  const unmatchedTransferFindings = openFindings.filter(
    (finding) =>
      finding.finding_type === "stripe_transfer_without_local_payout",
  ).length;

  return (
    <main style={wrap}>
      <AdminNav email={user.email ?? "Admin"} />
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "28px 22px 80px" }}>
        <h1 style={h1}>Resolution desk</h1>
        <p style={lede}>
          Nothing here changes on its own. Read the evidence, then act — every
          action is recorded against your account.
        </p>

        <div style={stats}>
          <Stat label="Critical findings" value={String(critical)} alarm={critical > 0} />
          <Stat label="Overdue cases" value={String(overdue)} alarm={overdue > 0} />
          <Stat label="Unassigned" value={String(unassigned)} />
          <Stat label="Blocking money" value={String(blockingMoney)} alarm={blockingMoney > 0} />
        </div>

        {/* ================= FINDINGS ================= */}
        <h2 style={h2}>
          Reconciliation findings{openFindings.length ? ` (${openFindings.length})` : ""}
        </h2>
        <p style={note}>
          Raised by the nightly comparison against Stripe. Findings are
          observations — they never alter a record.
        </p>

        {unmatchedTransferFindings > 0 && (
          <PrototypeFindingsCleanup count={unmatchedTransferFindings} />
        )}

        {openFindings.length === 0 ? (
          <div style={empty}>Nothing outstanding. Stripe and our records agree.</div>
        ) : (
          <div style={{ display: "grid", gap: 12, marginBottom: 34 }}>
            {openFindings.map((f) => {
              const sev = SEVERITY[f.severity] ?? SEVERITY.info;
              const findingPayment = f.payment_id
                ? paymentById.get(f.payment_id)
                : null;
              const findingPayout = f.payout_id
                ? payoutById.get(f.payout_id)
                : null;
              return (
                <article key={f.id} style={card}>
                  <div style={rowTop}>
                    <div>
                      <span style={{ ...chip, background: sev.bg, color: sev.fg }}>
                        {f.severity}
                      </span>
                      <strong style={title}>
                        {String(f.finding_type).replace(/_/g, " ")}
                      </strong>
                      <p style={meta}>
                        Detected {when(f.detected_at)}
                        {f.status === "acknowledged" ? " · acknowledged" : ""}
                        {f.stripe_object_id ? ` · ${f.stripe_object_id}` : ""}
                      </p>
                    </div>
                  </div>

                  <div style={evidence}>
                    <div>
                      <span style={evLabel}>Expected</span>
                      <pre style={pre}>{JSON.stringify(f.expected, null, 1)}</pre>
                    </div>
                    <div>
                      <span style={evLabel}>Actual</span>
                      <pre style={pre}>{JSON.stringify(f.actual, null, 1)}</pre>
                    </div>
                  </div>

                  <DeskControls
                    kind="finding"
                    findingId={f.id}
                    paymentId={f.payment_id}
                    payoutId={f.payout_id}
                    paymentStatus={findingPayment?.status}
                    payoutStatus={findingPayout?.status}
                    grossAmount={findingPayment?.gross_amount}
                  />
                </article>
              );
            })}
          </div>
        )}

        {/* ================= CASES ================= */}
        <h2 style={h2}>
          Review cases and approved refunds{rows.length ? ` (${rows.length})` : ""}
        </h2>
        <p style={note}>
          Somewhere safe for a booking to sit that isn&apos;t completed or
          cancelled. A case that blocks payout holds the provider&apos;s money
          until it&apos;s resolved.
        </p>

        {rows.length === 0 ? (
          <div style={empty}>No open cases or approved refunds waiting.</div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {rows.map((c) => {
              const pri = PRIORITY[c.priority] ?? PRIORITY.normal;
              return (
                <article
                  key={c.id}
                  style={{
                    ...card,
                    borderColor: c.overdue ? "#F3CBD4" : "#EDEFF1",
                  }}
                >
                  <div style={rowTop}>
                    <div>
                      <span style={{ ...chip, background: pri.bg, color: pri.fg }}>
                        {c.priority}
                      </span>
                      {c.overdue && (
                        <span style={{ ...chip, background: "#FFE6EA", color: "#B0384F" }}>
                          overdue
                        </span>
                      )}
                      {c.blocks_payout && (
                        <span style={{ ...chip, background: "#EDE4FD", color: "#6D28D9" }}>
                          holds payout
                        </span>
                      )}
                      {c.blocks_payment && (
                        <span style={{ ...chip, background: "#EDE4FD", color: "#6D28D9" }}>
                          blocks payment
                        </span>
                      )}
                      {c.status === "resolved" && Number(c.refund_remaining) > 0 && (
                        <span style={{ ...chip, background: "#E4F6EC", color: "#137B4E" }}>
                          refund approved
                        </span>
                      )}
                      <strong style={title}>
                        {String(c.category).replace(/_/g, " ")}
                      </strong>
                      <p style={meta}>
                        {c.service ?? "Service"} · {c.customer_email ?? "client"} ·
                        visit {when(c.scheduled_at)}
                      </p>
                      <p style={meta}>
                        Opened {when(c.opened_at)} · due {when(c.resolution_due_at)}
                        {c.assigned_to ? " · assigned" : " · unassigned"}
                      </p>
                    </div>
                  </div>

                  <dl style={facts}>
                    <Fact label="Booking" value={c.booking_status ?? "—"} />
                    <Fact label="Payment" value={c.payment_status ?? "—"} />
                    <Fact label="Charged" value={money(c.gross_amount)} />
                    <Fact label="Payout" value={c.payout_status ?? "—"} />
                    <Fact label="Provider due" value={money(c.payout_amount)} />
                    <Fact
                      label="Approved refund"
                      value={
                        c.resolution_amount !== null
                          ? money(c.resolution_amount)
                          : "—"
                      }
                    />
                    <Fact label="Refunded so far" value={money(c.refunded_amount)} />
                    <Fact label="Refund remaining" value={money(c.refund_remaining)} />
                  </dl>

                  <DeskControls
                    kind="case"
                    caseId={c.id}
                    paymentId={c.payment_id}
                    payoutId={c.payout_id}
                    paymentStatus={c.payment_status}
                    payoutStatus={c.payout_status}
                    grossAmount={c.gross_amount}
                    assigned={!!c.assigned_to}
                    caseStatus={c.status}
                    resolutionAmount={c.resolution_amount}
                    refundRemaining={c.refund_remaining}
                  />
                </article>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

/* ---------- small pieces ---------- */

function Denied({ text }: { text: string }) {
  return (
    <main style={{ ...wrap, display: "grid", placeItems: "center", minHeight: "70vh" }}>
      <div style={{ ...card, textAlign: "center", maxWidth: 380 }}>
        <strong style={{ fontSize: 18, fontWeight: 900 }}>Not available</strong>
        <p style={{ color: "#7A828C", margin: "6px 0 0", fontWeight: 600 }}>{text}</p>
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  alarm,
}: {
  label: string;
  value: string;
  alarm?: boolean;
}) {
  return (
    <div
      style={{
        ...card,
        padding: "16px 18px",
        borderColor: alarm ? "#F3CBD4" : "#EDEFF1",
      }}
    >
      <p
        style={{
          fontSize: 26,
          fontWeight: 900,
          margin: "0 0 2px",
          color: alarm ? "#B0384F" : "#16202A",
        }}
      >
        {value}
      </p>
      <span style={{ color: "#7A828C", fontSize: 13, fontWeight: 700 }}>
        {label}
      </span>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt
        style={{
          color: "#A9AFB7",
          fontSize: 11,
          fontWeight: 800,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          marginBottom: 2,
        }}
      >
        {label}
      </dt>
      <dd style={{ margin: 0, fontSize: 14, fontWeight: 800 }}>{value}</dd>
    </div>
  );
}

/* ---------- styles ---------- */

const wrap: React.CSSProperties = {
  minHeight: "100vh",
  background: "#F7F8F9",
  color: "#16202A",
  fontFamily: "'Nunito', system-ui, sans-serif",
};
const h1: React.CSSProperties = {
  fontSize: 30,
  fontWeight: 900,
  letterSpacing: "-0.025em",
  margin: "0 0 4px",
};
const lede: React.CSSProperties = {
  color: "#7A828C",
  fontSize: 15.5,
  fontWeight: 600,
  margin: "0 0 22px",
  maxWidth: "62ch",
};
const h2: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 900,
  margin: "0 0 4px",
};
const note: React.CSSProperties = {
  color: "#7A828C",
  fontSize: 14,
  fontWeight: 600,
  margin: "0 0 14px",
  maxWidth: "70ch",
};
const stats: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
  gap: 10,
  marginBottom: 30,
};
const card: React.CSSProperties = {
  background: "#fff",
  border: "2px solid #EDEFF1",
  borderRadius: 18,
  padding: "18px 20px",
};
const rowTop: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 14,
  flexWrap: "wrap",
};
const chip: React.CSSProperties = {
  display: "inline-block",
  fontSize: 11,
  fontWeight: 900,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  padding: "4px 10px",
  borderRadius: 999,
  marginRight: 6,
  marginBottom: 8,
};
const title: React.CSSProperties = {
  display: "block",
  fontSize: 17,
  fontWeight: 900,
  textTransform: "capitalize",
};
const meta: React.CSSProperties = {
  margin: "3px 0 0",
  color: "#7A828C",
  fontSize: 13.5,
  fontWeight: 600,
};
const evidence: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 10,
  margin: "12px 0 4px",
};
const evLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  color: "#A9AFB7",
};
const pre: React.CSSProperties = {
  margin: "4px 0 0",
  background: "#F7F8F9",
  borderRadius: 10,
  padding: "10px 12px",
  fontSize: 12,
  lineHeight: 1.45,
  overflowX: "auto",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};
const facts: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
  gap: 12,
  margin: "12px 0 0",
  paddingTop: 12,
  borderTop: "1px solid #F1F2F4",
};
const empty: React.CSSProperties = {
  background: "#fff",
  border: "2px dashed #E5E7EA",
  borderRadius: 18,
  padding: "26px 22px",
  textAlign: "center",
  color: "#7A828C",
  fontWeight: 600,
  marginBottom: 30,
};

export const metadata = { title: "Resolution desk — Opulence Bliss" };
export const dynamic = "force-dynamic";

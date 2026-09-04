// SETUP: code "app/account/MembershipCard.tsx"

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export type Membership = {
  id: string;
  planName: string;
  price: number;
  status: string;
  startDate: string | null;
  contractMonths: number;
  cyclesBilled: number;
  nextBill: string | null;
  weekday: number | null;
  hour: number | null;
  postcode: string | null;
  visitsThisCycle: number;
  visitsPerMonth: number | null;
  pausedUntil: string | null;
};

const TONE: Record<string, { bg: string; fg: string; text: string }> = {
  active: { bg: "#DFF5E8", fg: "#137B4E", text: "Active" },
  past_due: { bg: "#E9DDFD", fg: "#C23B18", text: "Payment failed" },
  paused: { bg: "#FFF3D6", fg: "#8A5A00", text: "Paused" },
  cancelled: { bg: "#EFEFF1", fg: "#4B5563", text: "Cancelled" },
};

function dateLabel(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function daysUntil(iso: string | null) {
  if (!iso) return null;
  const d = Math.ceil(
    (new Date(iso).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );
  return d > 0 ? d : 0;
}

export default function MembershipCard({
  m,
  compact,
}: {
  m: Membership;
  compact?: boolean;
}) {
  const tone = TONE[m.status] ?? TONE.active;
  const done = Math.min(m.cyclesBilled, m.contractMonths);
  const pct = Math.min(100, (done / m.contractMonths) * 100);
  const left = daysUntil(m.nextBill);

  return (
    <section style={card}>
      {/* gradient head */}
      <div style={head}>
        <div>
          <span style={{ ...pill, background: tone.bg, color: tone.fg }}>
            {tone.text}
          </span>
          <h2 style={title}>{m.planName}</h2>
          <p style={sub}>
            £{Number(m.price).toFixed(0)} a month
            {m.visitsPerMonth ? ` · ${m.visitsPerMonth} visits` : ""}
          </p>
        </div>
        <div style={bigPrice}>
          <strong>£{Number(m.price).toFixed(0)}</strong>
          <span>/mo</span>
        </div>
      </div>

      {/* body */}
      <div style={body}>
        <div style={progHead}>
          <strong>
            Month {done} of {m.contractMonths}
          </strong>
          <span>
            {done >= m.contractMonths
              ? "Minimum term complete"
              : `${m.contractMonths - done} to go`}
          </span>
        </div>
        <div style={bar}>
          <span style={{ ...fill, width: `${pct}%` }} />
        </div>

        <div style={tiles}>
          <div style={{ ...tile, background: "#E3F0FB", color: "#1B5E9E" }}>
            <span style={tileLabel}>Next payment</span>
            <strong style={tileValue}>
              {m.status === "cancelled" ? "None" : dateLabel(m.nextBill)}
            </strong>
            {left !== null && m.status !== "cancelled" && (
              <small style={tileNote}>in {left} days</small>
            )}
          </div>
          <div style={{ ...tile, background: "#E4F6EC", color: "#137B4E" }}>
            <span style={tileLabel}>Your slot</span>
            <strong style={tileValue}>
              {m.weekday !== null && m.hour !== null
                ? `${DAYS[m.weekday]}s`
                : "TBC"}
            </strong>
            {m.hour !== null && (
              <small style={tileNote}>
                {String(m.hour).padStart(2, "0")}:00
              </small>
            )}
          </div>
          <div style={{ ...tile, background: "#FFF3D6", color: "#8A5A00" }}>
            <span style={tileLabel}>Booked</span>
            <strong style={tileValue}>{m.visitsThisCycle}</strong>
            <small style={tileNote}>this cycle</small>
          </div>
        </div>

        {m.pausedUntil && (
          <p style={note}>
            Paused until {dateLabel(m.pausedUntil)} — no visits scheduled before
            then.
          </p>
        )}
        {m.status === "past_due" && (
          <p style={{ ...note, background: "#E9DDFD", color: "#C23B18" }}>
            Your last payment didn&apos;t go through, so we&apos;ve held your
            visits. Update your card to start them again.
          </p>
        )}

        {compact && (
          <a href="/account/membership" style={link}>
            Manage membership →
          </a>
        )}
      </div>
    </section>
  );
}

const card: React.CSSProperties = {
  background: "#fff",
  border: "2px solid #f1f1f2",
  borderRadius: 24,
  overflow: "hidden",
  marginBottom: 22,
  fontFamily: "'Nunito', system-ui, sans-serif",
};
const head: React.CSSProperties = {
  background: "linear-gradient(100deg,#F5C542,#C86FC9 55%,#7B2FF7)",
  padding: "22px 26px",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 16,
  flexWrap: "wrap",
};
const pill: React.CSSProperties = {
  display: "inline-block",
  fontSize: 12,
  fontWeight: 800,
  padding: "5px 12px",
  borderRadius: 999,
  marginBottom: 9,
};
const title: React.CSSProperties = {
  fontSize: 26,
  fontWeight: 900,
  letterSpacing: "-0.02em",
  color: "#fff",
  margin: "0 0 3px",
};
const sub: React.CSSProperties = {
  color: "rgba(255,255,255,0.9)",
  fontSize: 14.5,
  fontWeight: 700,
  margin: 0,
};
const bigPrice: React.CSSProperties = {
  background: "rgba(255,255,255,0.22)",
  borderRadius: 16,
  padding: "10px 16px",
  color: "#fff",
  display: "flex",
  alignItems: "baseline",
  gap: 3,
};
const body: React.CSSProperties = { padding: "22px 26px 24px" };
const progHead: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 12,
  marginBottom: 8,
  fontSize: 14,
  color: "#6b7280",
  fontWeight: 700,
};
const bar: React.CSSProperties = {
  height: 10,
  background: "#f1f1f2",
  borderRadius: 999,
  overflow: "hidden",
  marginBottom: 20,
};
const fill: React.CSSProperties = {
  display: "block",
  height: "100%",
  background: "linear-gradient(90deg,#F5C542,#C86FC9 55%,#7B2FF7)",
  borderRadius: 999,
};
const tiles: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
  gap: 10,
};
const tile: React.CSSProperties = { borderRadius: 16, padding: "14px 16px" };
const tileLabel: React.CSSProperties = {
  display: "block",
  fontSize: 11.5,
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  opacity: 0.72,
  marginBottom: 3,
};
const tileValue: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 900,
  color: "#1f2933",
  display: "block",
};
const tileNote: React.CSSProperties = { fontSize: 12.5, fontWeight: 700 };
const note: React.CSSProperties = {
  background: "#FFF3D6",
  color: "#8A5A00",
  padding: "12px 14px",
  borderRadius: 14,
  fontSize: 14,
  fontWeight: 600,
  margin: "18px 0 0",
};
const link: React.CSSProperties = {
  display: "inline-block",
  marginTop: 18,
  color: "#6D28D9",
  fontWeight: 800,
  fontSize: 14.5,
  textDecoration: "none",
};

// SETUP: mkdir -p "components" && code "components/VisitStatusPanel.tsx"
//
// Renders a VisitStatus. Decides nothing — if this file contains an `if` about
// booking status, the logic has leaked out of the projector.

import type { VisitStatus, Tone } from "@/lib/visitStatus";

const TONE: Record<Tone, { bg: string; border: string; fg: string; dot: string }> = {
  neutral: { bg: "#F7F8F9", border: "#E5E7EA", fg: "#16202A", dot: "#7A828C" },
  good: { bg: "#F0FAF4", border: "#CDEAD9", fg: "#137B4E", dot: "#137B4E" },
  live: { bg: "#EFF6FE", border: "#BBDCF5", fg: "#1B5E9E", dot: "#1B5E9E" },
  warning: { bg: "#FFF8E8", border: "#FFE09E", fg: "#8A5A00", dot: "#C08A00" },
  alert: { bg: "#FFF0F3", border: "#F3CBD4", fg: "#B0384F", dot: "#B0384F" },
};

const GRAD = "linear-gradient(100deg,#F5C542,#C86FC9 55%,#7B2FF7)";

function when(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  if (d.toDateString() === today.toDateString()) return `today, ${time}`;
  return `${d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  })}, ${time}`;
}

export default function VisitStatusPanel({
  status,
  compact,
}: {
  status: VisitStatus;
  compact?: boolean;
}) {
  const t = TONE[status.tone];

  return (
    <section
      style={{
        background: "#fff",
        border: `2px solid ${t.border}`,
        borderRadius: 20,
        overflow: "hidden",
        fontFamily: "'Nunito', system-ui, sans-serif",
      }}
    >
      {/* ---- headline ---- */}
      <div style={{ background: t.bg, padding: "18px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: "50%",
              background: t.dot,
              flexShrink: 0,
            }}
          />
          <strong style={{ fontSize: 18, fontWeight: 900, color: t.fg }}>
            {status.headline}
          </strong>
        </div>
        <p
          style={{
            margin: "7px 0 0",
            fontSize: 15,
            fontWeight: 600,
            lineHeight: 1.55,
            color: "#3A424B",
          }}
        >
          {status.detail}
        </p>
      </div>

      <div style={{ padding: "16px 20px 18px" }}>
        {/* ---- who acts next, and the money ---- */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 12,
          }}
        >
          <div style={box}>
            <span style={label}>Waiting on</span>
            <strong style={value}>{status.nextActorLabel}</strong>
            <span style={sub}>{status.nextActorDetail}</span>
          </div>

          <div style={box}>
            <span style={label}>Your money</span>
            <strong style={value}>{status.money.label}</strong>
            <span style={sub}>{status.money.explanation}</span>
          </div>
        </div>

        {/* ---- deadline ---- */}
        {status.deadline && (
          <p style={line}>
            <span style={label}>Next update</span>
            <strong style={{ ...value, fontSize: 14.5 }}>
              {status.deadline.label}
            </strong>
            <span style={sub}>{when(status.deadline.at)}</span>
          </p>
        )}

        {/* ---- what if nobody takes it ---- */}
        {status.ifNobodyAccepts && !compact && (
          <p
            style={{
              background: "#F7F8F9",
              borderRadius: 12,
              padding: "12px 14px",
              margin: "12px 0 0",
              fontSize: 13.5,
              fontWeight: 600,
              lineHeight: 1.55,
              color: "#4B5563",
            }}
          >
            <strong style={{ fontWeight: 900 }}>If nobody accepts: </strong>
            {status.ifNobodyAccepts}
          </p>
        )}

        {/* ---- a case, in plain English ---- */}
        {status.reviewCase && !compact && (
          <p
            style={{
              background: status.reviewCase.resolved ? "#F0FAF4" : "#FFF8E8",
              border: `1.5px solid ${
                status.reviewCase.resolved ? "#CDEAD9" : "#FFE09E"
              }`,
              borderRadius: 12,
              padding: "12px 14px",
              margin: "12px 0 0",
              fontSize: 13.5,
              fontWeight: 600,
              lineHeight: 1.55,
              color: status.reviewCase.resolved ? "#137B4E" : "#8A5A00",
            }}
          >
            <strong style={{ fontWeight: 900, textTransform: "capitalize" }}>
              {status.reviewCase.category.replace(/_/g, " ")} —{" "}
              {status.reviewCase.status}.{" "}
            </strong>
            {status.reviewCase.summary}
          </p>
        )}

        {/* ---- what you can do ---- */}
        {status.actions.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              marginTop: 16,
              paddingTop: 14,
              borderTop: "1px solid #F1F2F4",
            }}
          >
            {status.actions.map((a) =>
              a.href ? (
                <a
                  key={a.kind + a.label}
                  href={a.href}
                  style={a.primary ? primaryBtn : ghostBtn}
                >
                  {a.label}
                </a>
              ) : (
                <span
                  key={a.kind + a.label}
                  style={{ ...ghostBtn, cursor: "default", opacity: 0.85 }}
                >
                  {a.label}
                </span>
              )
            )}
          </div>
        )}
      </div>
    </section>
  );
}

const box: React.CSSProperties = {
  background: "#F9FAFB",
  borderRadius: 14,
  padding: "13px 15px",
};
const label: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  color: "#A9AFB7",
  marginBottom: 3,
};
const value: React.CSSProperties = {
  display: "block",
  fontSize: 15.5,
  fontWeight: 900,
  color: "#16202A",
};
const sub: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#7A828C",
  marginTop: 3,
  lineHeight: 1.5,
};
const line: React.CSSProperties = {
  ...box,
  margin: "12px 0 0",
};
const primaryBtn: React.CSSProperties = {
  background: GRAD,
  color: "#fff",
  borderRadius: 999,
  padding: "10px 20px",
  fontSize: 14,
  fontWeight: 900,
  textDecoration: "none",
};
const ghostBtn: React.CSSProperties = {
  background: "#fff",
  border: "2px solid #EDEFF1",
  color: "#16202A",
  borderRadius: 999,
  padding: "9px 18px",
  fontSize: 14,
  fontWeight: 800,
  textDecoration: "none",
};

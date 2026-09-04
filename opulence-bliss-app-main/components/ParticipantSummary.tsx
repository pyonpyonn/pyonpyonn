export default function ParticipantSummary({
  roleLabel,
  name,
  email,
  rating,
  ratingCount,
  ratingSource,
  bio,
  description,
}: {
  roleLabel: "Your professional" | "Your customer";
  name: string | null;
  email?: string | null;
  rating: number | null;
  ratingCount: number;
  ratingSource: "customer" | "provider";
  bio?: string | null;
  description: string;
}) {
  return (
    <div style={card}>
      <p style={eyebrow}>{roleLabel}</p>
      <div style={head}>
        <div style={{ minWidth: 0 }}>
          <strong style={nameStyle}>
            {name?.trim() || "Not assigned yet"}
          </strong>
          {email && <span style={emailStyle}>{email}</span>}
        </div>
        <div style={ratingBox}>
          {rating !== null && ratingCount > 0 ? (
            <>
              <strong style={ratingValue}>{rating.toFixed(1)} ★</strong>
              <span style={ratingMeta}>
                {ratingCount} {ratingSource}{" "}
                {ratingCount === 1 ? "rating" : "ratings"}
              </span>
            </>
          ) : (
            <>
              <strong style={{ ...ratingValue, fontSize: 14 }}>
                New profile
              </strong>
              <span style={ratingMeta}>No ratings yet</span>
            </>
          )}
        </div>
      </div>
      {bio && <p style={bioStyle}>{bio}</p>}
      <p style={help}>{description}</p>
    </div>
  );
}

const card: React.CSSProperties = {
  background: "var(--ob-surface)",
  border: "1.5px solid var(--ob-border)",
  borderRadius: 16,
  padding: "16px 17px",
  marginTop: 14,
};
const eyebrow: React.CSSProperties = {
  color: "var(--ob-purple)",
  fontSize: 11,
  fontWeight: 900,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  margin: "0 0 7px",
};
const head: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 14,
  flexWrap: "wrap",
};
const nameStyle: React.CSSProperties = {
  display: "block",
  color: "var(--ob-text)",
  fontSize: 19,
  fontWeight: 900,
};
const emailStyle: React.CSSProperties = {
  display: "block",
  color: "var(--ob-muted)",
  fontSize: 13,
  fontWeight: 600,
  overflowWrap: "anywhere",
  marginTop: 2,
};
const ratingBox: React.CSSProperties = {
  display: "grid",
  justifyItems: "end",
  background: "var(--ob-butter)",
  border: "1px solid #F4E3B6",
  borderRadius: 12,
  padding: "8px 11px",
};
const ratingValue: React.CSSProperties = {
  color: "var(--ob-rating-text)",
  fontSize: 18,
  fontWeight: 900,
};
const ratingMeta: React.CSSProperties = {
  color: "var(--ob-rating-text)",
  fontSize: 11,
  fontWeight: 700,
};
const help: React.CSSProperties = {
  color: "var(--ob-muted)",
  fontSize: 13,
  fontWeight: 600,
  lineHeight: 1.5,
  margin: "11px 0 0",
};
const bioStyle: React.CSSProperties = {
  color: "var(--ob-text)",
  fontSize: 14,
  fontWeight: 700,
  lineHeight: 1.5,
  margin: "12px 0 0",
};

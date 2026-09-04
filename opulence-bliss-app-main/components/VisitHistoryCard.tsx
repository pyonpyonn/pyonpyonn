import type { ReactNode } from "react";

export type HistoryFact = {
  label: string;
  value: string;
};

export type HistoryRating = {
  label: string;
  rating?: number | null;
  comment?: string | null;
  pending?: string;
};

export default function VisitHistoryCard({
  title,
  when,
  status,
  statusTone = "neutral",
  rating,
  secondaryRating,
  facts,
  children,
}: {
  title: string;
  when: string;
  status: string;
  statusTone?: "good" | "neutral" | "bad";
  rating?: HistoryRating | null;
  secondaryRating?: HistoryRating | null;
  facts: HistoryFact[];
  children?: ReactNode;
}) {
  const badge =
    statusTone === "good"
      ? { background: "#DFF5E8", color: "#137B4E" }
      : statusTone === "bad"
        ? { background: "#FFE6EA", color: "#B0384F" }
        : { background: "#EFEFF1", color: "#4B5563" };

  return (
    <details
      style={{
        background: "#fff",
        border: "2px solid #F1F1F2",
        borderRadius: 18,
        overflow: "hidden",
      }}
    >
      <summary
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 14,
          padding: "17px 19px",
          cursor: "pointer",
          listStyle: "none",
        }}
      >
        <span style={{ minWidth: 0, flex: 1 }}>
          <strong
            style={{
              display: "block",
              color: "#16202A",
              fontSize: 16,
              fontWeight: 900,
            }}
          >
            {title}
          </strong>
          <span
            style={{
              display: "block",
              marginTop: 2,
              color: "#7A828C",
              fontSize: 13.5,
              fontWeight: 600,
            }}
          >
            {when}
          </span>
        </span>

        <span
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 9,
            flexWrap: "wrap",
          }}
        >
          {rating && (
            <span
              style={{
                color: rating.rating ? "#6D28D9" : "#8A5A00",
                background: rating.rating ? "#F4ECFE" : "#FFF3D6",
                borderRadius: 999,
                padding: "5px 10px",
                fontSize: 12.5,
                fontWeight: 900,
                whiteSpace: "nowrap",
              }}
            >
              {rating.rating ? `${rating.rating} ★` : "Rating needed"}
            </span>
          )}
          <span
            style={{
              ...badge,
              borderRadius: 999,
              padding: "5px 10px",
              fontSize: 12,
              fontWeight: 800,
              whiteSpace: "nowrap",
            }}
          >
            {status}
          </span>
          <span aria-hidden="true" style={{ color: "#A9AFB7", fontSize: 15 }}>
            ▾
          </span>
        </span>
      </summary>

      <div
        style={{
          borderTop: "1px solid #F1F2F4",
          padding: "18px 19px 20px",
        }}
      >
        {rating && <RatingLine rating={rating} prominent />}
        {secondaryRating && <RatingLine rating={secondaryRating} />}

        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: "13px 18px",
            margin: rating || secondaryRating ? "18px 0 0" : 0,
          }}
        >
          {facts.map((fact) => (
            <div key={`${fact.label}:${fact.value}`} style={{ minWidth: 0 }}>
              <dt
                style={{
                  color: "#9AA1A9",
                  fontSize: 11,
                  fontWeight: 900,
                  letterSpacing: ".08em",
                  textTransform: "uppercase",
                  marginBottom: 3,
                }}
              >
                {fact.label}
              </dt>
              <dd
                style={{
                  margin: 0,
                  color: "#33404B",
                  fontSize: 13.5,
                  fontWeight: 700,
                  overflowWrap: "anywhere",
                }}
              >
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>

        {children && (
          <div style={{ borderTop: "1px solid #F1F2F4", marginTop: 18, paddingTop: 16 }}>
            {children}
          </div>
        )}
      </div>
    </details>
  );
}

function RatingLine({
  rating,
  prominent = false,
}: {
  rating: HistoryRating;
  prominent?: boolean;
}) {
  return (
    <div
      style={{
        background: prominent ? "#FCFAFF" : "transparent",
        border: prominent ? "1px solid #E9DDFC" : "none",
        borderRadius: 12,
        padding: prominent ? "12px 14px" : "10px 0 0",
      }}
    >
      <span
        style={{
          display: "block",
          color: "#7A828C",
          fontSize: 12,
          fontWeight: 900,
          marginBottom: 3,
        }}
      >
        {rating.label}
      </span>
      {rating.rating ? (
        <>
          <strong style={{ color: "#6D28D9", fontSize: 17, letterSpacing: 1 }}>
            {"★".repeat(rating.rating)}
            <span style={{ color: "#DDD6E8" }}>{"★".repeat(5 - rating.rating)}</span>
          </strong>
          {rating.comment && (
            <p
              style={{
                color: "#4B5563",
                fontSize: 13.5,
                fontWeight: 600,
                margin: "5px 0 0",
                lineHeight: 1.45,
              }}
            >
              “{rating.comment}”
            </p>
          )}
        </>
      ) : (
        <span style={{ color: "#8A5A00", fontSize: 13.5, fontWeight: 800 }}>
          {rating.pending ?? "Not rated yet"}
        </span>
      )}
    </div>
  );
}

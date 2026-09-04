"use client";

const STAGES = ["Booked", "Confirmed", "Arrived", "Done"];

function stageIndex(status: string) {
  if (["offered", "declined"].includes(status)) return 0;
  if (status === "scheduled") return 1;
  if (status === "in_progress") return 2;
  if (status === "completed") return 3;
  return 0;
}

export default function BookingProgress({
  status,
  labels = STAGES,
  details,
  stage,
}: {
  status: string;
  labels?: string[];
  details?: Array<string | null>;
  stage?: number;
}) {
  const current = stage ?? stageIndex(status);
  const count = Math.max(labels.length, 1);
  const side = 50 / count;
  const progressWidth = Math.min(current, count - 1) * (100 / count);
  const maximumWidth = ((count - 1) / count) * 100;

  return (
    <div
      className={`booking-progress${details ? " has-details" : ""}`}
      aria-label={`Booking progress: ${labels[current] ?? STAGES[current]}`}
    >
      <span
        className="rail"
        aria-hidden="true"
        style={{ left: `${side}%`, right: `${side}%` }}
      />
      <span
        className="fill"
        aria-hidden="true"
        style={{
          left: `${side}%`,
          width: `${progressWidth}%`,
          maxWidth: `${maximumWidth}%`,
        }}
      />
      <ol style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
        {labels.map((label, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li
              key={label}
              className={done ? "done" : active ? "active" : "future"}
            >
              <span className="node">{done ? "✓" : index + 1}</span>
              <strong>{label}</strong>
              {details?.[index] && <small>{details[index]}</small>}
            </li>
          );
        })}
      </ol>

      <style jsx>{`
        .booking-progress {
          position: relative;
          margin: 19px 0 17px;
          padding-top: 1px;
        }
        .rail,
        .fill {
          position: absolute;
          top: 15px;
          height: 5px;
          border-radius: 999px;
        }
        .rail {
          background: var(--ob-border);
        }
        .fill {
          background: linear-gradient(100deg, #f5c542, #c86fc9 55%, #7b2ff7);
          transition: width 0.35s ease;
        }
        ol {
          position: relative;
          z-index: 1;
          display: grid;
          list-style: none;
          padding: 0;
          margin: 0;
        }
        li {
          display: grid;
          justify-items: center;
          gap: 7px;
          color: #a0a7b0;
          min-width: 0;
        }
        .node {
          width: 30px;
          height: 30px;
          display: grid;
          place-items: center;
          box-sizing: border-box;
          border: 3px solid var(--ob-surface);
          border-radius: 50%;
          background: var(--ob-surface-soft);
          color: var(--ob-muted);
          font-size: 12px;
          font-weight: 900;
          box-shadow: 0 0 0 1px var(--ob-border);
        }
        li.done .node {
          background: var(--ob-purple-soft);
          color: var(--ob-purple);
          box-shadow: 0 0 0 1px var(--ob-purple);
        }
        li.active .node {
          background: linear-gradient(100deg, #f5c542, #c86fc9 55%, #7b2ff7);
          color: #fff;
          box-shadow:
            0 0 0 1px #c86fc9,
            0 0 0 5px rgba(200, 111, 201, 0.13);
        }
        li.done,
        li.active {
          color: var(--ob-text);
        }
        strong {
          font-size: 12px;
          font-weight: 900;
          text-align: center;
        }
        small {
          color: var(--ob-muted);
          font-size: 10.5px;
          font-weight: 700;
          line-height: 1.25;
          text-align: center;
        }
        .has-details {
          margin: 28px 0 26px;
        }
        @media (max-width: 420px) {
          strong {
            font-size: 10.5px;
          }
          .node {
            width: 27px;
            height: 27px;
          }
          .rail,
          .fill {
            top: 13.5px;
          }
        }
        @media (max-width: 640px) {
          .has-details small {
            display: none;
          }
          .has-details {
            margin-top: 24px;
            margin-bottom: 20px;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .fill {
            transition: none;
          }
        }
      `}</style>
    </div>
  );
}

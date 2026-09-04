"use client";

// Job actions — changes with the job's stage.
// Save at: app/worker/JobActions.tsx

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import {
  acceptJob,
  declineJob,
  checkInJob,
  verifyCheckInOtp,
  checkOutJob,
  rateClient,
} from "./actions";
import JobExceptions from "./JobExceptions";

const green: React.CSSProperties = {
  background: "#16202A",
  color: "#FFFFFF",
  border: "none",
  borderRadius: 999,
  padding: "10px 22px",
  fontWeight: 600,
  fontSize: 14,
  cursor: "pointer",
};

const ghost: React.CSSProperties = {
  background: "transparent",
  color: "#B0384F",
  border: "1.5px solid #F3CBD4",
  borderRadius: 999,
  padding: "10px 22px",
  fontWeight: 600,
  fontSize: 14,
  cursor: "pointer",
};

const apricot: React.CSSProperties = {
  ...green,
  background: "#6D28D9",
  color: "#fff",
};

export default function JobActions({
  id,
  status,
  scheduledAt,
  existingRating,
  showExceptions = true,
  compact = false,
}: {
  id: string;
  status: string;
  scheduledAt: string;
  existingRating?: { rating: number; comment: string | null } | null;
  showExceptions?: boolean;
  compact?: boolean;
}) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const dim = (s: React.CSSProperties) => ({
    ...s,
    opacity: pending ? 0.6 : 1,
    cursor: pending ? ("wait" as const) : s.cursor,
  });

  if (status === "offered") {
    return (
      <div style={{ marginTop: compact ? 0 : 16 }}>
        <div
          style={{
            display: "flex",
            justifyContent: compact ? "flex-end" : undefined,
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <button
            onClick={() =>
              start(async () => {
                await declineJob(id);
              })
            }
            disabled={pending}
            style={dim(ghost)}
          >
            Decline
          </button>
          <button
            onClick={() =>
              start(async () => {
                const r = await acceptJob(id);
                if (r?.taken) {
                  setNote("Someone else took this job first.");
                } else if (r?.error) {
                  setNote(r.error);
                }
              })
            }
            disabled={pending}
            style={dim(compact ? apricot : green)}
          >
            {pending ? "…" : compact ? "Accept booking" : "Accept"}
          </button>
        </div>
        {note && (
          <p
            style={{
              margin: "10px 0 0",
              padding: "10px 12px",
              borderRadius: 10,
              fontSize: 13.5,
              background: "#FFE6EA",
              color: "#B0384F",
            }}
          >
            {note}
          </p>
        )}
      </div>
    );
  }

  if (status === "scheduled") {
    return (
      <div style={{ marginTop: compact ? 0 : 16 }}>
        <CheckInControl id={id} compact={compact} />
        {showExceptions && (
          <JobExceptions
            bookingId={id}
            status={status}
            scheduledAt={scheduledAt}
          />
        )}
      </div>
    );
  }

  if (status === "in_progress") {
    return (
      <div style={{ marginTop: compact ? 0 : 16 }}>
        <button
          onClick={() =>
            start(async () => {
              const r = await checkOutJob(id);
              setNote(
                r?.earned
                  ? `Job complete — the customer has been charged and £${r.earned.toFixed(
                      2,
                    )} is on its way to you.`
                  : "Job complete — the customer has been charged.",
              );
            })
          }
          disabled={pending}
          style={dim(apricot)}
        >
          {pending ? "Finishing…" : "Finish & check out"}
        </button>
        {!compact && (
          <p style={{ color: "#7A828C", fontSize: 13, margin: "10px 0 0" }}>
            Checking out completes the job and charges the customer — your share
            is released automatically.
          </p>
        )}
        {note && (
          <p
            style={{
              margin: "10px 0 0",
              padding: "10px 12px",
              borderRadius: 10,
              fontSize: 13.5,
              background: "#F4ECFE",
              color: "#16202A",
            }}
          >
            {note}
          </p>
        )}
        {showExceptions && (
          <JobExceptions
            bookingId={id}
            status={status}
            scheduledAt={scheduledAt}
          />
        )}
      </div>
    );
  }

  if (status === "completed") {
    return (
      <div style={{ marginTop: compact ? 0 : 14 }}>
        <p
          style={{
            margin: "0 0 10px",
            color: "#16202A",
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          ✓ Completed — payment taken and your share sent.
        </p>
        <RateClientBox id={id} existing={existingRating ?? null} />
      </div>
    );
  }

  return null;
}

export function CheckInControl({
  id,
  compact = false,
  animated = false,
  label = "I've arrived — check in",
  panelTargetId,
}: {
  id: string;
  compact?: boolean;
  animated?: boolean;
  label?: string;
  panelTargetId?: string;
}) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [otpStep, setOtpStep] = useState(false);
  const [otp, setOtp] = useState("");
  const [panelTarget, setPanelTarget] = useState<HTMLElement | null>(null);
  const [blocked, setBlocked] = useState<{
    lat: number | null;
    lng: number | null;
  } | null>(null);

  useEffect(() => {
    setPanelTarget(
      panelTargetId ? document.getElementById(panelTargetId) : null,
    );
  }, [panelTargetId]);

  const run = (lat?: number | null, lng?: number | null, force = false) =>
    start(async () => {
      const result = await checkInJob(id, lat, lng, force);
      setNote(result?.reason ?? null);
      setOtpStep(
        Boolean(result && "otpRequired" in result && result.otpRequired),
      );
      setBlocked(
        result?.blocked && "canForce" in result && result.canForce
          ? { lat: lat ?? null, lng: lng ?? null }
          : null,
      );
    });

  const locate = (force = false) => {
    setNote(null);
    if (!navigator.geolocation) {
      run(null, null, force);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        run(position.coords.latitude, position.coords.longitude, force),
      () => run(null, null, force),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  const good =
    note?.startsWith("Location confirmed") ||
    note?.startsWith("Development location bypass") ||
    note?.startsWith("Code confirmed");

  const showFeedback = otpStep || Boolean(note) || Boolean(blocked) || !compact;
  const feedback = showFeedback ? (
    <div className="worker-checkin-feedback">
      {otpStep && (
        <div
          style={{
            marginTop: compact ? 0 : 10,
            padding: compact ? "10px 12px" : "14px",
            border: "1.5px solid var(--ob-border)",
            borderRadius: 14,
            background: "var(--ob-surface)",
          }}
        >
          <strong
            style={{
              display: "block",
              color: "var(--ob-text)",
              fontSize: 14,
              marginBottom: 7,
            }}
          >
            Enter the client&apos;s 6-digit code
          </strong>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              aria-label="Client check-in code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={otp}
              onChange={(event) =>
                setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))
              }
              placeholder="000000"
              style={{
                flex: "1 1 120px",
                minWidth: 0,
                border: "1.5px solid var(--ob-border)",
                borderRadius: 10,
                padding: "10px 12px",
                background: "var(--ob-surface)",
                color: "var(--ob-text)",
                font: "inherit",
                fontSize: 18,
                fontWeight: 900,
                letterSpacing: "0.18em",
                textAlign: "center",
              }}
            />
            <button
              type="button"
              className="worker-checkin-button"
              disabled={pending || otp.length !== 6}
              onClick={() =>
                start(async () => {
                  const result = await verifyCheckInOtp(id, otp);
                  setNote(result.reason);
                  if (result.ok) setOtpStep(false);
                })
              }
            >
              {pending ? "Checking…" : "Confirm code"}
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              setOtpStep(false);
              setOtp("");
              setNote(null);
            }}
            style={{
              marginTop: 8,
              padding: 0,
              border: 0,
              background: "none",
              color: "var(--ob-muted)",
              font: "inherit",
              fontSize: 12.5,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Check location again
          </button>
        </div>
      )}
      {!compact && (
        <p
          style={{ color: "var(--ob-muted)", fontSize: 13, margin: "10px 0 0" }}
        >
          You need to be at the customer&apos;s address to check in.
        </p>
      )}
      {note && (
        <p
          style={{
            margin: "8px 0 0",
            padding: "9px 11px",
            borderRadius: 9,
            fontSize: 12.5,
            background: good ? "var(--ob-purple-soft)" : "var(--ob-blush)",
            color: good ? "var(--ob-text)" : "var(--ob-danger-text)",
          }}
        >
          {note}
        </p>
      )}
      {blocked && (
        <button
          type="button"
          onClick={() => run(blocked.lat, blocked.lng, true)}
          disabled={pending}
          style={{
            ...ghost,
            marginTop: 8,
            fontSize: 12,
            padding: "7px 13px",
          }}
        >
          Continue anyway — development only
        </button>
      )}
    </div>
  ) : null;

  return (
    <div className="worker-checkin-control">
      {!otpStep && (
        <button
          type="button"
          className={
            animated
              ? "worker-checkin-button animated"
              : "worker-checkin-button"
          }
          onClick={() => locate()}
          disabled={pending}
        >
          {pending ? "Checking location…" : label}
        </button>
      )}
      {panelTarget ? createPortal(feedback, panelTarget) : feedback}
    </div>
  );
}

// Provider rates the client.
function RateClientBox({
  id,
  existing,
}: {
  id: string;
  existing: { rating: number; comment: string | null } | null;
}) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState("");
  const [done, setDone] = useState<string | null>(null);

  if (existing) {
    return (
      <div style={{ marginTop: 8 }}>
        <strong style={{ color: "#6D28D9", fontSize: 16 }}>
          {"★".repeat(existing.rating)}
          <span style={{ color: "#DDD6E8" }}>
            {"★".repeat(5 - existing.rating)}
          </span>
        </strong>
        <p style={{ margin: "3px 0 0", color: "#7A828C", fontSize: 13.5 }}>
          {existing.comment
            ? `“${existing.comment}”`
            : "Your rating was submitted."}
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <p style={{ margin: 0, fontSize: 13.5, color: "#7A828C" }}>{done}</p>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          font: "inherit",
          fontSize: 13.5,
          color: "#6D28D9",
          textDecoration: "underline",
          cursor: "pointer",
        }}
      >
        Rate this client
      </button>
    );
  }

  return (
    <div>
      <p style={{ margin: "0 0 8px", fontSize: 13.5, color: "#7A828C" }}>
        How was this client? Only admins see individual ratings.
      </p>
      <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            onClick={() => setStars(n)}
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: 22,
              lineHeight: 1,
              padding: 0,
              color: n <= stars ? "#6D28D9" : "#E5E7EA",
            }}
          >
            ★
          </button>
        ))}
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={2}
        placeholder="Access, clarity, anything worth noting (optional)"
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "10px 12px",
          border: "1.5px solid #E5E7EA",
          borderRadius: 10,
          font: "inherit",
          fontSize: 13.5,
          marginBottom: 10,
          resize: "vertical",
        }}
      />
      <button
        disabled={pending || stars === 0}
        onClick={() =>
          start(async () => {
            const r = await rateClient(id, stars, comment);
            setDone(
              r?.error
                ? "You've already rated this client."
                : `Thanks — you rated this client ${stars} stars.`,
            );
          })
        }
        style={{
          background: "#16202A",
          color: "#FFFFFF",
          border: "none",
          borderRadius: 999,
          padding: "9px 20px",
          font: "inherit",
          fontSize: 13.5,
          fontWeight: 600,
          cursor: pending || stars === 0 ? "not-allowed" : "pointer",
          opacity: pending || stars === 0 ? 0.6 : 1,
        }}
      >
        {pending ? "Sending…" : "Submit"}
      </button>
    </div>
  );
}

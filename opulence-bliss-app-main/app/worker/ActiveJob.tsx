"use client";

// Compact job-state card used only on the provider Jobs dashboard.

import { useEffect, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  Clock3,
  CreditCard,
  Eye,
  Info,
  MapPin,
  MessageSquare,
  Navigation,
  RotateCcw,
} from "lucide-react";
import BookingProgress from "@/components/BookingProgress";
import JobActions, { CheckInControl } from "./JobActions";
import ReportDelay from "./ReportDelay";

export type ActiveJobData = {
  id: string;
  status: string;
  scheduled_at: string;
  address: string | null;
  notes: string | null;
  client: string | null;
  clientEmail?: string | null;
  clientRating?: number | null;
  clientRatingCount?: number | null;
  clientCompletedBookings?: number;
  service: string;
  durationMinutes: number | null;
  earns: number | null;
  paymentLabel?: string | null;
  arrivedAt: string | null;
  leftAt: string | null;
  geofencePass: boolean | null;
  offerExpiresAt?: string | null;
  delayMinutes?: number | null;
  delayReportedAt?: string | null;
};

const STAGES = ["Booked", "Confirmed", "On the way", "In progress", "Done"];

function stageIndex(status: string) {
  if (status === "completed") return 4;
  if (status === "in_progress") return 3;
  if (status === "scheduled") return 1;
  return 0;
}

function relativeDate(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "long",
  });
}

function fullDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function durationLabel(minutes: number | null) {
  if (!minutes) return "Flexible time";
  if (minutes >= 120 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} min`;
}

function finishTime(start: string, duration: number | null) {
  if (!duration) return null;
  return new Date(new Date(start).getTime() + duration * 60_000).toISOString();
}

function offerTimeLeft(iso: string | null | undefined) {
  if (!iso) return "Respond while the offer is open.";
  const minutes = Math.floor((new Date(iso).getTime() - Date.now()) / 60_000);
  if (minutes <= 0) return "This offer is expiring now.";
  if (minutes < 60) return `${minutes} minutes left to respond.`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"} left to respond.`;
}

function statusCopy(job: ActiveJobData, elapsed: string) {
  if (job.status === "offered") {
    return {
      tone: "offer",
      title: "New booking request",
      detail: offerTimeLeft(job.offerExpiresAt),
    };
  }
  if (job.status === "scheduled") {
    if (job.delayMinutes) {
      const eta = new Date(
        new Date(job.scheduled_at).getTime() + job.delayMinutes * 60_000,
      ).toISOString();
      return {
        tone: "delay",
        title: `You reported a ${job.delayMinutes}-minute delay`,
        detail: `The customer has been notified · updated arrival around ${clock(eta)}.`,
      };
    }
    return {
      tone: "confirmed",
      title: "You have confirmed this job",
      detail:
        "Open the full details before you travel so you know what to expect.",
    };
  }
  if (job.status === "in_progress") {
    return {
      tone: "live",
      title: "This visit is in progress",
      detail: elapsed
        ? `${elapsed} on site`
        : "You are checked in with the client.",
    };
  }
  if (job.status === "completed") {
    return {
      tone: "done",
      title: "Job completed successfully",
      detail: "Your completed visit and payout status are saved.",
    };
  }
  return {
    tone: "neutral",
    title: "Job update",
    detail: "Open the full details for the latest information.",
  };
}

export default function ActiveJob({
  job,
  canAct = true,
}: {
  job: ActiveJobData;
  compact?: boolean;
  canAct?: boolean;
}) {
  const live = job.status === "in_progress";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  let elapsed = "";
  if (live && job.arrivedAt) {
    const seconds = Math.max(
      0,
      Math.floor((now - new Date(job.arrivedAt).getTime()) / 1000),
    );
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    elapsed = `${hours ? `${hours}:` : ""}${String(minutes).padStart(
      hours ? 2 : 1,
      "0",
    )}:${String(rest).padStart(2, "0")}`;
  }

  const finish = finishTime(job.scheduled_at, job.durationMinutes);
  const maps = job.address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        job.address,
      )}`
    : null;
  const status = statusCopy(job, elapsed);
  const detailHref = live ? "/worker/current" : `/worker/job/${job.id}`;
  const checkInPanelId = `dashboard-checkin-panel-${job.id}`;
  const customerInitial = (job.client ?? "C").trim().charAt(0).toUpperCase();

  return (
    <section className={`dashboard-job ${status.tone}`}>
      <header className="job-head">
        <div className="job-title">
          <h3>
            {job.service} · {durationLabel(job.durationMinutes)}
          </h3>
          <div className="date-row">
            <span>
              <CalendarDays size={16} /> {relativeDate(job.scheduled_at)},{" "}
              {fullDate(job.scheduled_at)}
            </span>
            <span>
              <Clock3 size={16} /> {clock(job.scheduled_at)}
              {finish ? ` – ${clock(finish)}` : ""}
            </span>
          </div>
        </div>

        <div className="progress-wrap">
          <BookingProgress
            status={job.status}
            stage={stageIndex(job.status)}
            labels={STAGES}
          />
        </div>
      </header>

      <div className="summary-grid">
        <div className="identity-card client-identity">
          <div className="client-row">
            <span className="avatar">{customerInitial}</span>
            <div className="identity-copy">
              <strong>{job.client ?? "Customer"}</strong>
              <div className="identity-meta">
                <b className="rating">
                  {job.clientRating !== null && job.clientRating !== undefined
                    ? `${Number(job.clientRating).toFixed(1)} ★ (${job.clientRatingCount ?? 0})`
                    : "Not yet rated"}
                </b>
                {(job.clientCompletedBookings ?? 0) > 0 && (
                  <span>Repeat client</span>
                )}
              </div>
              <small className="history">
                <RotateCcw size={13} />
                {(job.clientCompletedBookings ?? 0) > 0
                  ? `${job.clientCompletedBookings} completed ${job.clientCompletedBookings === 1 ? "booking" : "bookings"} with you`
                  : "First booking with you"}
              </small>
            </div>
          </div>
        </div>

        <Summary tone="sky" icon={<MapPin size={19} />} label="Location">
          <strong>{job.address ?? "Address unavailable"}</strong>
          {maps && (
            <a href={maps} target="_blank" rel="noreferrer">
              <Navigation size={13} /> Open map
            </a>
          )}
        </Summary>

        <Summary tone="butter" icon={<Clock3 size={19} />} label="Duration">
          <strong>{durationLabel(job.durationMinutes)}</strong>
          <small>
            {clock(job.scheduled_at)}
            {finish ? ` – ${clock(finish)}` : ""}
          </small>
        </Summary>

        <Summary tone="blush" icon={<CreditCard size={19} />} label="Payout">
          <strong>
            {job.earns !== null ? `£${job.earns.toFixed(2)}` : "—"}
          </strong>
          <small>{job.paymentLabel ?? "Payout updates after completion"}</small>
        </Summary>
      </div>

      {job.status === "scheduled" && (
        <div id={checkInPanelId} className="checkin-panel-row" />
      )}

      <footer className="state-bar">
        {status.tone === "offer" ? (
          <Info size={22} />
        ) : (
          <CheckCircle2 size={24} />
        )}
        <div className="state-copy">
          <strong>{status.title}</strong>
          <span>{status.detail}</span>
        </div>

        <div className="state-actions">
          {job.status === "offered" ? (
            canAct ? (
              <JobActions
                id={job.id}
                status={job.status}
                scheduledAt={job.scheduled_at}
                showExceptions={false}
                compact
              />
            ) : (
              <span className="locked-copy">Finish setup to respond</span>
            )
          ) : job.status === "completed" ? (
            <>
              <a className="secondary-action" href="/worker/earnings">
                View payout
              </a>
              <a className="primary-action" href="/worker#past-work">
                View completed jobs
              </a>
            </>
          ) : (
            <>
              <a className="secondary-action" href={detailHref}>
                <Eye size={16} /> See full details
              </a>
              {job.status === "scheduled" && (
                <>
                  <ReportDelay
                    bookingId={job.id}
                    currentMinutes={job.delayMinutes}
                    compact
                  />
                  <CheckInControl
                    id={job.id}
                    compact
                    animated
                    label="Check in"
                    panelTargetId={checkInPanelId}
                  />
                </>
              )}
              <a className="primary-action" href={`${detailHref}?chat=1`}>
                <MessageSquare size={16} /> Message client
              </a>
            </>
          )}
        </div>
      </footer>

      <style jsx>{`
        .dashboard-job {
          container-type: inline-size;
          box-sizing: border-box;
          width: 100%;
          overflow: hidden;
          border: 1px solid var(--ob-border);
          border-radius: 18px;
          background: var(--ob-surface);
          color: var(--ob-text);
          box-shadow: 0 8px 24px rgba(22, 32, 42, 0.06);
          font-family: "Nunito", system-ui, sans-serif;
        }
        .dashboard-job.live {
          border-color: color-mix(
            in srgb,
            var(--ob-purple) 55%,
            var(--ob-border)
          );
          box-shadow: 0 12px 30px var(--ob-shadow);
        }
        .dashboard-job.delay {
          border-color: #f2c66d;
        }
        .checkin-panel-row:not(:empty) {
          margin: 0 14px 12px;
          padding: 12px;
          border: 1px solid var(--ob-border);
          border-radius: 13px;
          background: var(--ob-purple-soft);
        }
        .job-head {
          display: grid;
          grid-template-columns: minmax(260px, 0.9fr) minmax(430px, 1.2fr);
          align-items: start;
          gap: 26px;
          padding: 17px 20px 8px;
        }
        .job-title,
        .progress-wrap {
          min-width: 0;
        }
        h3 {
          margin: 0;
          color: var(--ob-text);
          font-size: 20px;
          font-weight: 900;
          letter-spacing: -0.02em;
        }
        .date-row {
          display: flex;
          align-items: center;
          gap: 7px;
          flex-wrap: wrap;
          margin-top: 7px;
        }
        .date-row span {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          border-radius: 8px;
          background: var(--ob-purple-soft);
          color: var(--ob-text);
          padding: 5px 9px;
          font-size: 12.5px;
          font-weight: 800;
        }
        .date-row span:first-child {
          background: var(--ob-mint);
        }
        .progress-wrap :global(.booking-progress) {
          margin: 0;
        }
        .summary-grid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 10px;
          padding: 6px 20px 10px;
        }
        .client-row {
          display: flex;
          align-items: center;
          gap: 9px;
          min-width: 0;
        }
        .client-row > div {
          min-width: 0;
        }
        .identity-card {
          display: flex;
          align-items: center;
          min-width: 0;
          min-height: 88px;
          box-sizing: border-box;
          border: 1px solid
            color-mix(in srgb, var(--ob-border) 75%, transparent);
          border-radius: 13px;
          padding: 10px 12px;
          background: var(--ob-mint);
          color: var(--ob-text);
        }
        .identity-copy {
          display: grid;
          gap: 3px;
          min-width: 0;
        }
        .identity-copy > strong {
          overflow: hidden;
          color: var(--ob-text);
          font-size: 14px;
          font-weight: 900;
          line-height: 1.2;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .identity-meta {
          display: flex;
          align-items: center;
          gap: 7px;
          flex-wrap: wrap;
        }
        .identity-meta b {
          font-size: 12px;
        }
        .identity-meta span {
          border-radius: 999px;
          background: color-mix(
            in srgb,
            var(--ob-success-text) 12%,
            transparent
          );
          color: var(--ob-success-text);
          padding: 2px 7px;
          font-size: 10px;
          font-weight: 900;
        }
        .history {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          color: var(--ob-muted);
          font-size: 10.5px;
          font-weight: 750;
          line-height: 1.25;
        }
        .avatar {
          display: grid;
          place-items: center;
          width: 48px;
          height: 48px;
          flex: 0 0 48px;
          border-radius: 50%;
          background: linear-gradient(100deg, #f5c542, #c86fc9 55%, #7b2ff7);
          color: #fff;
          font-size: 15px;
          font-weight: 900;
        }
        .rating {
          color: var(--ob-success-text) !important;
          font-weight: 900 !important;
        }
        .state-bar {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          align-items: center;
          gap: 10px;
          min-height: 54px;
          padding: 9px 14px;
          border-top: 1px solid var(--ob-border);
          background: var(--ob-purple-soft);
          color: var(--ob-purple);
        }
        .confirmed .state-bar,
        .done .state-bar {
          background: var(--ob-mint);
          color: var(--ob-success-text);
        }
        .live .state-bar {
          background: var(--ob-sky);
          color: var(--ob-info-text);
        }
        .state-copy {
          display: grid;
          min-width: 0;
        }
        .state-copy strong {
          color: inherit;
          font-size: 14px;
          font-weight: 900;
        }
        .state-copy span,
        .locked-copy {
          color: var(--ob-muted);
          font-size: 12px;
          font-weight: 700;
        }
        .state-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 9px;
          flex-wrap: wrap;
        }
        .state-actions :global(button),
        .secondary-action,
        .primary-action {
          min-height: 38px;
          box-sizing: border-box;
          white-space: nowrap;
        }
        @container (max-width: 980px) {
          .job-head {
            grid-template-columns: 1fr;
            gap: 7px;
          }
          .summary-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .state-bar {
            grid-template-columns: auto minmax(0, 1fr);
            align-items: start;
            padding: 12px 14px;
          }
          .state-actions {
            grid-column: 1 / -1;
            justify-content: flex-start;
            width: 100%;
          }
          .state-copy span {
            max-width: 62ch;
          }
        }
        @container (max-width: 640px) {
          .summary-grid {
            grid-template-columns: 1fr;
          }
          .state-actions {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .state-actions :global(> div),
          .state-actions :global(> div > div) {
            display: grid !important;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            width: 100%;
          }
          .state-actions :global(button),
          .secondary-action,
          .primary-action {
            width: 100%;
          }
        }
        @container (max-width: 410px) {
          .state-actions,
          .state-actions :global(> div),
          .state-actions :global(> div > div) {
            grid-template-columns: 1fr;
          }
        }
        .secondary-action,
        .primary-action {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          border-radius: 9px;
          padding: 8px 15px;
          font-size: 12.5px;
          font-weight: 900;
          text-decoration: none;
        }
        .secondary-action {
          border: 1px solid var(--ob-purple);
          background: var(--ob-surface);
          color: var(--ob-purple);
        }
        .primary-action {
          border: 1px solid var(--ob-purple);
          background: var(--ob-purple);
          color: #fff;
        }
        @media (max-width: 1080px) {
          .job-head {
            grid-template-columns: 1fr;
            gap: 6px;
          }
          .progress-wrap {
            margin-top: 4px;
          }
          .summary-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
        @media (max-width: 680px) {
          .job-head {
            padding: 16px 16px 7px;
          }
          h3 {
            font-size: 18px;
          }
          .date-row {
            align-items: stretch;
          }
          .date-row span {
            flex: 1 1 190px;
          }
          .summary-grid {
            grid-template-columns: 1fr;
            padding: 5px 16px 10px;
          }
          .state-bar {
            grid-template-columns: auto minmax(0, 1fr);
            align-items: start;
            padding: 12px 14px;
          }
          .state-actions {
            grid-column: 1 / -1;
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            width: 100%;
          }
          .state-actions :global(> div),
          .state-actions :global(> div > div) {
            display: grid !important;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            width: 100%;
          }
          .state-actions :global(button),
          .secondary-action,
          .primary-action {
            width: 100%;
          }
        }
        @media (max-width: 430px) {
          .state-actions,
          .state-actions :global(> div),
          .state-actions :global(> div > div) {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </section>
  );
}

function Summary({
  tone,
  icon,
  label,
  children,
}: {
  tone: "mint" | "sky" | "butter" | "blush";
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`summary ${tone}`}>
      <div className="summary-label">
        {icon} {label}
      </div>
      <div className="summary-body">{children}</div>

      <style jsx>{`
        .summary {
          min-width: 0;
          min-height: 88px;
          box-sizing: border-box;
          border: 1px solid
            color-mix(in srgb, var(--ob-border) 75%, transparent);
          border-radius: 13px;
          padding: 10px 12px;
        }
        .mint {
          background: var(--ob-mint);
          color: var(--ob-success-text);
        }
        .sky {
          background: var(--ob-sky);
          color: var(--ob-info-text);
        }
        .butter {
          background: var(--ob-butter);
          color: var(--ob-warning-text);
        }
        .blush {
          background: var(--ob-blush);
          color: var(--ob-danger-text);
        }
        .summary-label {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-bottom: 7px;
          font-size: 10.5px;
          font-weight: 900;
          letter-spacing: 0.055em;
          text-transform: uppercase;
        }
        .summary-body {
          display: grid;
          gap: 3px;
          min-width: 0;
          color: var(--ob-text);
        }
        .summary-body :global(strong) {
          overflow: hidden;
          color: var(--ob-text);
          font-size: 13.5px;
          font-weight: 900;
          line-height: 1.25;
          text-overflow: ellipsis;
        }
        .summary-body :global(small) {
          color: var(--ob-muted);
          font-size: 11.5px;
          font-weight: 700;
          line-height: 1.3;
        }
        .summary-body :global(a) {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          width: fit-content;
          color: var(--ob-purple);
          font-size: 11.5px;
          font-weight: 900;
          text-decoration: none;
        }
      `}</style>
    </div>
  );
}

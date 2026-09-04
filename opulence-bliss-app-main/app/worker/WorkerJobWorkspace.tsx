"use client";

import { useEffect, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  Clock3,
  CreditCard,
  Flag,
  Headphones,
  Info,
  MapPin,
  MessageSquare,
  Navigation,
  ShieldCheck,
  Star,
  X,
} from "lucide-react";
import BookingProgress from "@/components/BookingProgress";
import MessageThread from "@/components/MessageThread";
import JobActions, { CheckInControl } from "./JobActions";
import JobExceptions from "./JobExceptions";
import ReportDelay from "./ReportDelay";
import type { WorkerJobWorkspaceData } from "./jobData";

function money(value: number | null) {
  return value === null ? "—" : `£${value.toFixed(2)}`;
}

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function fullDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function relativeDate(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return date.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function compactDateTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function endTime(start: string, durationMinutes: number | null) {
  if (!durationMinutes) return null;
  return new Date(
    new Date(start).getTime() + durationMinutes * 60_000,
  ).toISOString();
}

function workerStage(job: WorkerJobWorkspaceData) {
  if (job.status === "completed") return 4;
  if (job.status === "in_progress") return 3;
  if (job.checkIn.arrivedAt) return 3;
  if (job.status === "scheduled") return 1;
  return 0;
}

function statusCopy(job: WorkerJobWorkspaceData) {
  if (job.status === "in_progress") {
    return {
      tone: "live",
      title: "This visit is in progress",
      detail: "Finish the service, then check out to complete the visit.",
    };
  }
  if (job.status === "completed") {
    return {
      tone: "good",
      title: "This visit is complete",
      detail: "Your check-out and payout status are recorded below.",
    };
  }
  if (job.status === "needs_review") {
    return {
      tone: "warning",
      title: "This visit is being reviewed",
      detail: "The resolution team will decide what happens next.",
    };
  }
  if (job.status === "cancelled") {
    return {
      tone: "alert",
      title: "This booking was cancelled",
      detail: "No further visit action is required.",
    };
  }
  if (job.status === "scheduled" && job.delayMinutes) {
    const eta = new Date(
      new Date(job.scheduledAt).getTime() + job.delayMinutes * 60_000,
    ).toISOString();
    return {
      tone: "warning",
      title: `You reported a ${job.delayMinutes}-minute delay`,
      detail: `The client was notified and your updated arrival is around ${clock(eta)}.`,
    };
  }
  return {
    tone: "good",
    title: "This booking is confirmed",
    detail: "Head to the address on time and check in when you arrive.",
  };
}

function nextSteps(job: WorkerJobWorkspaceData) {
  const finish = endTime(job.scheduledAt, job.durationMinutes);
  if (job.status === "completed") {
    return [
      ["Visit complete", "Your check-out is recorded.", job.checkIn.leftAt],
      ["Payout review", job.money.explanation, null],
      ["Rate the client", "Share how the visit went.", null],
      ["Next job", "Return to your schedule when you're ready.", null],
    ];
  }
  if (job.status === "in_progress") {
    return [
      [
        "Visit in progress",
        "Follow the client's booking notes.",
        job.checkIn.arrivedAt,
      ],
      ["Expected finish", "Use the planned duration as your guide.", finish],
      ["Check out", "Finish the job only when the work is done.", null],
      ["Payout", "Your payout status updates after completion.", null],
    ];
  }
  return [
    [
      "Head to location",
      "Use directions to reach the client's address.",
      job.scheduledAt,
    ],
    ["Check in on arrival", "Your location is checked at the address.", null],
    ["Complete the service", "Follow the notes and agreed duration.", null],
    [
      "Finish and check out",
      "This completes the visit and starts payout processing.",
      finish,
    ],
  ];
}

export default function WorkerJobWorkspace({
  job,
}: {
  job: WorkerJobWorkspaceData;
}) {
  const [chatOpen, setChatOpen] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const modalOpen = chatOpen || issueOpen;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("chat") === "1") setChatOpen(true);
  }, []);

  useEffect(() => {
    if (!modalOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setChatOpen(false);
        setIssueOpen(false);
      }
    };
    window.addEventListener("keydown", close);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", close);
    };
  }, [modalOpen]);

  const finish = endTime(job.scheduledAt, job.durationMinutes);
  const stage = workerStage(job);
  const status = statusCopy(job);
  const maps = job.address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(job.address)}`
    : null;
  const bookingRef = `#BKG-${job.id.slice(0, 8).toUpperCase()}`;
  const clientFirstName = job.client.name.split(" ")[0] || "Client";
  const chatClosed =
    job.status === "cancelled" ||
    new Date(job.scheduledAt).getTime() < Date.now() - 7 * 24 * 60 * 60 * 1000;
  const timelineDetails = [
    compactDateTime(job.createdAt),
    compactDateTime(job.confirmedAt),
    stage >= 2
      ? compactDateTime(job.checkIn.arrivedAt ?? job.scheduledAt)
      : compactDateTime(
          new Date(
            new Date(job.scheduledAt).getTime() - 30 * 60_000,
          ).toISOString(),
        ),
    compactDateTime(job.checkIn.arrivedAt ?? job.scheduledAt),
    compactDateTime(job.checkIn.leftAt ?? finish),
  ];
  const checkInPanelId = `worker-checkin-panel-${job.id}`;

  function closeDialogs() {
    setChatOpen(false);
    setIssueOpen(false);
  }

  return (
    <div className="worker-workspace">
      <section className="job-card">
        <header className="job-head">
          <div>
            <h1>
              {job.service}
              {job.durationMinutes
                ? ` · ${job.durationMinutes >= 120 && job.durationMinutes % 60 === 0 ? `${job.durationMinutes / 60} hours` : `${job.durationMinutes} min`}`
                : ""}
            </h1>
            <p>Booking ID: {bookingRef}</p>
          </div>
          <div className="head-actions">
            {job.status === "scheduled" && (
              <ReportDelay
                bookingId={job.id}
                currentMinutes={job.delayMinutes}
              />
            )}
            {job.status === "scheduled" && (
              <CheckInControl
                id={job.id}
                compact
                animated
                label="Check in"
                panelTargetId={checkInPanelId}
              />
            )}
            <button className="message" onClick={() => setChatOpen(true)}>
              <MessageSquare size={18} /> Message {clientFirstName}
            </button>
            {maps && (
              <a href={maps} target="_blank" rel="noreferrer">
                <Navigation size={18} /> Get directions
              </a>
            )}
          </div>
        </header>

        {job.status === "scheduled" && (
          <div id={checkInPanelId} className="checkin-panel-row" />
        )}

        <div className="date-chip">
          <span>
            <CalendarDays size={18} /> {relativeDate(job.scheduledAt)},{" "}
            {fullDate(job.scheduledAt)}
          </span>
          <span>
            <Clock3 size={18} /> {clock(job.scheduledAt)}
          </span>
          {job.delayMinutes && (
            <strong className="delay-chip">
              Updated arrival: {clock(new Date(new Date(job.scheduledAt).getTime() + job.delayMinutes * 60_000).toISOString())}
            </strong>
          )}
        </div>

        <BookingProgress
          status={job.status}
          stage={stage}
          labels={["Booked", "Confirmed", "On the way", "In progress", "Done"]}
          details={timelineDetails}
        />

        <div className="summary-grid">
          <SummaryCard tone="sky" icon={<MapPin size={22} />} label="Location">
            <strong>{job.address ?? "Address unavailable"}</strong>
            {maps && (
              <small>
                <a href={maps} target="_blank" rel="noreferrer">
                  Open directions
                </a>
              </small>
            )}
          </SummaryCard>
          <SummaryCard
            tone="butter"
            icon={<Clock3 size={22} />}
            label="Duration"
          >
            <strong>
              {job.durationMinutes
                ? `${job.durationMinutes} min`
                : "Set service time"}
            </strong>
            <small>
              {clock(job.scheduledAt)}
              {finish ? ` – ${clock(finish)}` : ""}
            </small>
          </SummaryCard>
          <SummaryCard
            tone="blush"
            icon={<CreditCard size={22} />}
            label="Earnings (payout)"
          >
            <strong>{money(job.money.earns)}</strong>
            <b>{job.money.label}</b>
            <small>{job.money.explanation}</small>
          </SummaryCard>
        </div>

        <section className="client-card">
          <div className="client-profile">
            <ClientAvatar name={job.client.name} />
            <div>
              <h2>{job.client.name}</h2>
              <Rating
                rating={job.client.rating}
                count={job.client.ratingCount}
              />
              <div className="tags">
                <span>
                  <ShieldCheck size={14} /> Booking verified
                </span>
                {job.client.completedWithYou > 0 && <span>Repeat client</span>}
              </div>
              {job.client.email && <p>{job.client.email}</p>}
            </div>
          </div>
          <div className="instructions">
            <Instruction
              icon={<MapPin size={18} />}
              title="Service address"
              body={job.address ?? "Address unavailable"}
            />
            <Instruction
              icon={<MessageSquare size={18} />}
              title="Booking notes"
              body={job.notes ?? "No special requests were added."}
            />
            <Instruction
              icon={<Clock3 size={18} />}
              title="Planned time"
              body={`${clock(job.scheduledAt)}${finish ? ` – ${clock(finish)}` : ""}`}
            />
            <Instruction
              icon={<CreditCard size={18} />}
              title="Visit type"
              body={
                job.isMembership ? "Membership visit" : "Pay-per-visit booking"
              }
            />
          </div>
          <p className="rating-note">
            <Info size={16} /> Client ratings are based on completed bookings.
          </p>
        </section>

        <section className={`status-banner ${status.tone}`}>
          <CheckCircle2 size={29} />
          <div>
            <strong>{status.title}</strong>
            <p>{status.detail}</p>
          </div>
          {job.status !== "scheduled" && (
            <div className="job-action">
              <JobActions
                id={job.id}
                status={job.status}
                scheduledAt={job.scheduledAt}
                existingRating={job.existingClientRating}
                showExceptions={false}
                compact
              />
            </div>
          )}
        </section>

        <div className="detail-grid">
          <section className="next-card">
            <h2>What happens next?</h2>
            <ol>
              {nextSteps(job).map(([title, description, at], index) => (
                <li key={`${title}-${index}`}>
                  <span className="step-icon">
                    {index === 3 ? (
                      <CheckCircle2 size={17} />
                    ) : (
                      <Navigation size={17} />
                    )}
                  </span>
                  <div>
                    <strong>{title}</strong>
                    {at && <b>{compactDateTime(at)}</b>}
                    <p>{description}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <div className="detail-stack">
            <section className="small-card">
              <h2>
                <CreditCard size={18} /> Payout details
              </h2>
              <DetailRow label="Your payout" value={money(job.money.earns)} />
              {job.money.platformFee !== null && (
                <DetailRow
                  label="Platform fee"
                  value={`− ${money(job.money.platformFee)}`}
                  danger
                />
              )}
              {job.money.tips > 0 && (
                <DetailRow label="Tips" value={money(job.money.tips)} />
              )}
              <DetailRow label="Status" value={job.money.label} badge />
              <p className="detail-note">
                <Info size={15} /> {job.money.explanation}
              </p>
            </section>
            <section className="small-card">
              <h2>
                <CalendarDays size={18} /> Booking details
              </h2>
              <DetailRow
                label="Service"
                value={`${job.service}${job.durationMinutes ? ` · ${job.durationMinutes} min` : ""}`}
              />
              <DetailRow
                label="Date"
                value={`${fullDate(job.scheduledAt)} (${relativeDate(job.scheduledAt)})`}
              />
              <DetailRow
                label="Time"
                value={`${clock(job.scheduledAt)}${finish ? ` – ${clock(finish)}` : ""}`}
              />
              <DetailRow label="Booking ID" value={bookingRef} />
              <DetailRow
                label="Created"
                value={compactDateTime(job.createdAt)}
              />
            </section>
            {(job.checkIn.arrivedAt || job.checkIn.leftAt) && (
              <section className="small-card">
                <h2>
                  <MapPin size={18} /> Check-in record
                </h2>
                <DetailRow
                  label="Arrived"
                  value={compactDateTime(job.checkIn.arrivedAt)}
                />
                <DetailRow
                  label="Left"
                  value={compactDateTime(job.checkIn.leftAt)}
                />
                <DetailRow
                  label="Location"
                  value={
                    job.checkIn.geofencePass === true
                      ? "Confirmed at address"
                      : job.checkIn.geofencePass === false
                        ? "Flagged away from address"
                        : "Not verified"
                  }
                />
              </section>
            )}
          </div>
        </div>

        <section className="support-bar">
          <Headphones size={27} />
          <div>
            <strong>Need help?</strong>
            <p>Contact support or report an issue with this visit.</p>
          </div>
          <button
            onClick={() =>
              window.dispatchEvent(new Event("opulence:open-support"))
            }
          >
            Contact support
          </button>
          {["scheduled", "in_progress"].includes(job.status) && (
            <button className="report" onClick={() => setIssueOpen(true)}>
              <Flag size={17} /> Report issue
            </button>
          )}
        </section>
      </section>

      {chatOpen && (
        <Modal
          onClose={closeDialogs}
          label={`Messages with ${job.client.name}`}
        >
          <header className="dialog-head">
            <ClientAvatar name={job.client.name} small />
            <div>
              <strong>{job.client.name}</strong>
              <span>
                {job.client.rating !== null
                  ? `${job.client.rating.toFixed(1)} ★ (${job.client.ratingCount})`
                  : "Client"}
              </span>
            </div>
            <button onClick={closeDialogs} aria-label="Close messages">
              <X size={21} />
            </button>
          </header>
          <p className="chat-safety">
            <ShieldCheck size={19} /> This chat is for booking-related messages
            only. Be kind and respectful.
          </p>
          <MessageThread
            bookingId={job.id}
            viewerRole="provider"
            closed={chatClosed}
            bare
          />
        </Modal>
      )}

      {issueOpen && (
        <Modal onClose={closeDialogs} label="Report a job issue" narrow>
          <header className="dialog-head issue-head">
            <span className="issue-icon">
              <Flag size={20} />
            </span>
            <div>
              <strong>Report an issue</strong>
              <span>Tell us what went wrong with this booking.</span>
            </div>
            <button onClick={closeDialogs} aria-label="Close issue report">
              <X size={21} />
            </button>
          </header>
          <JobExceptions
            bookingId={job.id}
            status={job.status}
            scheduledAt={job.scheduledAt}
            defaultOpen={job.status === "scheduled" ? "cant" : "noaccess"}
            showLauncher={false}
          />
        </Modal>
      )}

      <style jsx>{`
        .worker-workspace {
          width: 100%;
          color: var(--ob-text);
          font-family: "Nunito", system-ui, sans-serif;
        }
        .job-card {
          background: var(--ob-surface);
          border: 1px solid var(--ob-border);
          border-radius: 24px;
          padding: clamp(20px, 3vw, 34px);
          box-shadow: 0 12px 38px
            color-mix(in srgb, var(--ob-shadow) 55%, transparent);
        }
        .job-head {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 18px;
          flex-wrap: wrap;
        }
        h1 {
          margin: 0;
          color: var(--ob-text);
          font-size: clamp(25px, 3.2vw, 34px);
          font-weight: 900;
          letter-spacing: -0.03em;
        }
        .job-head p {
          margin: 4px 0 0;
          color: var(--ob-muted);
          font-size: 14px;
          font-weight: 700;
        }
        .head-actions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }
        .delay-chip {
          border-radius: 999px;
          padding: 5px 10px;
          background: #fff0c9;
          color: #845500;
          font-size: 12.5px;
          font-weight: 900;
        }
        .head-actions button,
        .head-actions a,
        .support-bar button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          border: 1.5px solid var(--ob-border);
          border-radius: 10px;
          background: transparent;
          color: var(--ob-text);
          padding: 10px 15px;
          font: inherit;
          font-size: 14px;
          font-weight: 900;
          cursor: pointer;
          text-decoration: none;
        }
        .head-actions .message,
        .support-bar button {
          border-color: var(--ob-purple);
          color: var(--ob-purple);
        }
        .checkin-panel-row:not(:empty) {
          width: 100%;
          box-sizing: border-box;
          margin-top: 14px;
          padding: 14px;
          border: 1px solid var(--ob-border);
          border-radius: 14px;
          background: var(--ob-purple-soft);
        }
        .date-chip {
          display: inline-flex;
          align-items: center;
          gap: 20px;
          flex-wrap: wrap;
          margin-top: 15px;
          padding: 10px 15px;
          border-radius: 12px;
          background: var(--ob-mint);
          color: var(--ob-success-text);
        }
        .date-chip span {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          font-size: 14px;
          font-weight: 900;
        }
        .summary-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
          padding: 12px;
          border: 1px solid var(--ob-border);
          border-radius: 18px;
        }
        .client-card {
          display: grid;
          grid-template-columns: minmax(280px, 0.85fr) minmax(0, 1.3fr);
          gap: 24px;
          margin-top: 18px;
          padding: 22px;
          border: 1px solid var(--ob-border);
          border-radius: 18px;
        }
        .client-profile {
          display: flex;
          align-items: flex-start;
          gap: 18px;
          min-width: 0;
          padding-right: 22px;
          border-right: 1px solid var(--ob-border);
        }
        .client-profile h2 {
          margin: 3px 0 8px;
          font-size: 22px;
          font-weight: 900;
        }
        .client-profile p {
          margin: 9px 0 0;
          color: var(--ob-muted);
          font-size: 13px;
          font-weight: 700;
          overflow-wrap: anywhere;
        }
        .tags {
          display: flex;
          gap: 7px;
          flex-wrap: wrap;
          margin-top: 10px;
        }
        .tags span {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          border-radius: 7px;
          padding: 4px 7px;
          background: var(--ob-purple-soft);
          color: var(--ob-purple);
          font-size: 11px;
          font-weight: 900;
        }
        .instructions {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 0;
        }
        .rating-note {
          grid-column: 1/-1;
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 0;
          padding: 9px 12px;
          border-radius: 10px;
          background: var(--ob-purple-soft);
          color: var(--ob-purple);
          font-size: 12.5px;
          font-weight: 800;
        }
        .status-banner {
          display: grid;
          grid-template-columns: auto 1fr minmax(220px, auto);
          align-items: center;
          gap: 13px;
          margin-top: 18px;
          padding: 17px 19px;
          border: 1px solid var(--ob-border);
          border-radius: 15px;
          background: var(--ob-mint);
          color: var(--ob-success-text);
        }
        .status-banner.live {
          background: var(--ob-sky);
          color: var(--ob-info-text);
        }
        .status-banner.warning {
          background: var(--ob-butter);
          color: var(--ob-warning-text);
        }
        .status-banner.alert {
          background: var(--ob-blush);
          color: var(--ob-danger-text);
        }
        .status-banner strong {
          display: block;
          font-size: 16px;
          font-weight: 900;
        }
        .status-banner p {
          margin: 2px 0 0;
          color: var(--ob-text);
          font-size: 13.5px;
          font-weight: 700;
        }
        .job-action {
          justify-self: end;
          max-width: 360px;
        }
        .job-action > :global(div) {
          margin-top: 0 !important;
        }
        .detail-grid {
          display: grid;
          grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.05fr);
          gap: 16px;
          margin-top: 18px;
        }
        .next-card,
        .small-card {
          border: 1px solid var(--ob-border);
          border-radius: 16px;
          background: var(--ob-surface);
          padding: 19px;
        }
        .next-card h2,
        .small-card h2 {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 0 0 16px;
          font-size: 16px;
          font-weight: 900;
        }
        .next-card ol {
          list-style: none;
          margin: 0;
          padding: 0;
        }
        .next-card li {
          position: relative;
          display: grid;
          grid-template-columns: 34px 1fr;
          gap: 11px;
          padding-bottom: 18px;
        }
        .next-card li:not(:last-child)::after {
          content: "";
          position: absolute;
          left: 16px;
          top: 32px;
          bottom: 0;
          width: 1px;
          background: var(--ob-border);
        }
        .step-icon {
          display: grid;
          place-items: center;
          width: 33px;
          height: 33px;
          border-radius: 50%;
          background: var(--ob-purple-soft);
          color: var(--ob-purple);
        }
        .next-card li strong,
        .next-card li b {
          display: block;
          font-size: 13.5px;
        }
        .next-card li b {
          margin-top: 2px;
          color: var(--ob-purple);
        }
        .next-card li p {
          margin: 5px 0 0;
          color: var(--ob-muted);
          font-size: 12.5px;
          font-weight: 600;
          line-height: 1.45;
        }
        .detail-stack {
          display: grid;
          gap: 14px;
        }
        .detail-note {
          display: flex;
          align-items: flex-start;
          gap: 7px;
          margin: 10px 0 0;
          color: var(--ob-muted);
          font-size: 11.5px;
          font-weight: 700;
          line-height: 1.4;
        }
        .support-bar {
          display: grid;
          grid-template-columns: auto 1fr auto auto;
          align-items: center;
          gap: 13px;
          margin-top: 18px;
          padding: 16px 19px;
          border-radius: 14px;
          background: var(--ob-purple-soft);
          color: var(--ob-purple);
        }
        .support-bar strong {
          display: block;
          font-size: 14px;
          font-weight: 900;
        }
        .support-bar p {
          margin: 2px 0 0;
          font-size: 12.5px;
          font-weight: 700;
        }
        .support-bar .report {
          border-color: var(--ob-danger-text);
          color: var(--ob-danger-text);
        }
        .dialog-head {
          display: grid;
          grid-template-columns: auto 1fr auto;
          align-items: center;
          gap: 12px;
        }
        .dialog-head strong {
          display: block;
          font-size: 20px;
          font-weight: 900;
        }
        .dialog-head span {
          display: block;
          color: var(--ob-muted);
          font-size: 13px;
          font-weight: 700;
        }
        .dialog-head button {
          display: grid;
          place-items: center;
          width: 38px;
          height: 38px;
          border: 1px solid var(--ob-border);
          border-radius: 50%;
          background: transparent;
          color: var(--ob-text);
          cursor: pointer;
        }
        .chat-safety {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          margin: 18px 0;
          padding: 14px 16px;
          border-radius: 12px;
          background: var(--ob-purple-soft);
          color: var(--ob-purple);
          font-size: 13.5px;
          font-weight: 800;
          line-height: 1.5;
        }
        .issue-icon {
          display: grid !important;
          place-items: center;
          width: 42px;
          height: 42px;
          border-radius: 50%;
          background: var(--ob-blush);
          color: var(--ob-danger-text) !important;
        }
        @media (max-width: 900px) {
          .summary-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .client-card,
          .detail-grid {
            grid-template-columns: 1fr;
          }
          .client-profile {
            padding-right: 0;
            padding-bottom: 20px;
            border-right: 0;
            border-bottom: 1px solid var(--ob-border);
          }
          .status-banner {
            grid-template-columns: auto 1fr;
          }
          .job-action {
            grid-column: 1/-1;
            justify-self: stretch;
            max-width: none;
          }
          .support-bar {
            grid-template-columns: auto 1fr;
          }
          .support-bar button {
            width: 100%;
            grid-column: 1/-1;
          }
        }
        @media (max-width: 640px) {
          .job-card {
            border-radius: 18px;
            padding: 17px !important;
          }
          .head-actions,
          .head-actions button,
          .head-actions a {
            width: 100%;
          }
          .date-chip {
            display: flex;
            gap: 8px 16px;
          }
          .summary-grid {
            grid-template-columns: 1fr;
            padding: 8px;
          }
          .client-profile {
            flex-direction: column;
          }
          .instructions {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
}

function Modal({
  children,
  onClose,
  label,
  narrow = false,
}: {
  children: React.ReactNode;
  onClose: () => void;
  label: string;
  narrow?: boolean;
}) {
  return (
    <div
      className="backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={narrow ? "dialog narrow" : "dialog"}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
      </section>
      <style jsx>{`
        .backdrop {
          position: fixed;
          inset: 0;
          z-index: 10020;
          display: grid;
          place-items: center;
          padding: 20px;
          background: rgba(8, 12, 19, 0.58);
          backdrop-filter: blur(5px);
        }
        .dialog {
          width: min(720px, 100%);
          max-height: calc(100vh - 40px);
          overflow-y: auto;
          box-sizing: border-box;
          border: 1px solid var(--ob-border);
          border-radius: 22px;
          background: var(--ob-surface);
          color: var(--ob-text);
          padding: 24px;
          box-shadow: 0 28px 80px rgba(0, 0, 0, 0.32);
        }
        .dialog.narrow {
          width: min(620px, 100%);
        }
        @media (max-width: 640px) {
          .backdrop {
            align-items: end;
            padding: 0;
          }
          .dialog {
            width: 100%;
            max-height: 92vh;
            border-radius: 22px 22px 0 0;
            padding: 18px;
          }
        }
      `}</style>
    </div>
  );
}

function SummaryCard({
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
    <article className={`summary ${tone}`}>
      <span>
        {icon}
        {label}
      </span>
      {children}
      <style jsx>{`
        .summary {
          min-width: 0;
          min-height: 150px;
          box-sizing: border-box;
          border-radius: 14px;
          padding: 15px;
        }
        .mint {
          background: var(--ob-mint);
        }
        .sky {
          background: var(--ob-sky);
        }
        .butter {
          background: var(--ob-butter);
        }
        .blush {
          background: var(--ob-blush);
        }
        .summary > span {
          display: flex;
          align-items: center;
          gap: 7px;
          color: var(--ob-muted);
          font-size: 11px;
          font-weight: 900;
          letter-spacing: 0.05em;
          text-transform: uppercase;
        }
        .summary :global(strong),
        .summary :global(b),
        .summary :global(small) {
          display: flex;
          align-items: flex-start;
          gap: 6px;
        }
        .summary :global(strong) {
          margin-top: 14px;
          color: var(--ob-text);
          font-size: 17px;
          font-weight: 900;
          overflow-wrap: anywhere;
        }
        .summary :global(b) {
          margin-top: 5px;
          color: var(--ob-text);
          font-size: 13.5px;
          font-weight: 900;
        }
        .summary :global(small) {
          margin-top: 12px;
          color: var(--ob-muted);
          font-size: 11.5px;
          font-weight: 700;
          line-height: 1.4;
        }
        .summary :global(a) {
          color: var(--ob-purple);
          font-weight: 900;
        }
      `}</style>
    </article>
  );
}

function ClientAvatar({
  name,
  small = false,
}: {
  name: string;
  small?: boolean;
}) {
  const size = small ? 52 : 108;
  return (
    <span
      style={{
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        display: "grid",
        placeItems: "center",
        borderRadius: "50%",
        border: "3px solid var(--ob-surface)",
        boxShadow: "0 0 0 1px var(--ob-border)",
        background:
          "linear-gradient(135deg,var(--ob-purple-soft),var(--ob-sky))",
        color: "var(--ob-purple)",
        fontSize: small ? 18 : 34,
        fontWeight: 900,
      }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

function Rating({ rating, count }: { rating: number | null; count: number }) {
  if (rating === null)
    return (
      <p
        style={{
          margin: 0,
          color: "var(--ob-muted)",
          fontSize: 13,
          fontWeight: 700,
        }}
      >
        Not yet rated
      </p>
    );
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        color: "var(--ob-success-text)",
        fontSize: 14,
      }}
    >
      <strong>{rating.toFixed(1)}</strong>
      <span style={{ display: "inline-flex", gap: 2 }}>
        {[1, 2, 3, 4, 5].map((item) => (
          <Star
            key={item}
            size={15}
            fill={item <= Math.round(rating) ? "currentColor" : "none"}
            opacity={item <= Math.round(rating) ? 1 : 0.35}
          />
        ))}
      </span>
      <span style={{ color: "var(--ob-muted)" }}>({count} ratings)</span>
    </div>
  );
}

function Instruction({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="instruction">
      <span>{icon}</span>
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
      <style jsx>{`
        .instruction {
          display: grid;
          grid-template-columns: 24px 1fr;
          gap: 9px;
          padding: 10px 14px;
          border-bottom: 1px solid var(--ob-border);
        }
        .instruction:nth-child(odd) {
          border-right: 1px solid var(--ob-border);
        }
        .instruction > span {
          color: var(--ob-text);
        }
        strong {
          font-size: 12.5px;
          font-weight: 900;
        }
        p {
          margin: 4px 0 0;
          color: var(--ob-muted);
          font-size: 12px;
          font-weight: 650;
          line-height: 1.45;
          overflow-wrap: anywhere;
        }
        @media (max-width: 640px) {
          .instruction:nth-child(odd) {
            border-right: 0;
          }
        }
      `}</style>
    </div>
  );
}

function DetailRow({
  label,
  value,
  badge = false,
  danger = false,
}: {
  label: string;
  value: string;
  badge?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="row">
      <span>{label}</span>
      <strong className={`${badge ? "badge " : ""}${danger ? "danger" : ""}`}>
        {value}
      </strong>
      <style jsx>{`
        .row {
          display: flex;
          justify-content: space-between;
          gap: 18px;
          padding: 6px 0;
          color: var(--ob-text);
          font-size: 12.5px;
        }
        .row span {
          color: var(--ob-muted);
          font-weight: 700;
        }
        .row strong {
          max-width: 66%;
          text-align: right;
          font-weight: 800;
          overflow-wrap: anywhere;
        }
        .row strong.badge {
          border-radius: 7px;
          background: var(--ob-butter);
          color: var(--ob-warning-text);
          padding: 3px 7px;
        }
        .row strong.danger {
          color: var(--ob-danger-text);
        }
      `}</style>
    </div>
  );
}

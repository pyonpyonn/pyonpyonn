"use client";

// Compact booking-state card used only on the customer My bookings dashboard.

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
  RotateCcw,
  ShieldCheck,
  Star,
} from "lucide-react";
import BookingProgress from "@/components/BookingProgress";
import CheckInCodePanel from "@/components/CheckInCodePanel";
import { BookingTools, type BookingServiceOption } from "./BookingTools";

export type Visit = {
  id: string;
  packageId: string;
  status: string;
  scheduled_at: string;
  address: string | null;
  service: string;
  durationMinutes: number | null;
  providerName: string | null;
  providerPhoto?: string | null;
  providerYearsExperience?: number | null;
  providerVerified?: boolean;
  providerRating: number | null;
  providerRatingCount?: number | null;
  paymentAmount?: number | null;
  paymentStatus?: string | null;
  paymentLabel?: string | null;
  arrivedAt: string | null;
  finishedAt?: string | null;
  delayMinutes?: number | null;
  delayReportedAt?: string | null;
  bookingNotes?: string | null;
};

const STAGES = ["Booked", "Confirmed", "Arrived", "Done"];

function stageIndex(status: string) {
  if (status === "completed") return 3;
  if (status === "in_progress") return 2;
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

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function countdown(iso: string) {
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (minutes <= 0) return "starting now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(hours / 24);
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}

function finishTime(start: string, duration: number | null) {
  if (!duration) return null;
  return new Date(new Date(start).getTime() + duration * 60_000).toISOString();
}

function durationLabel(minutes: number | null) {
  if (!minutes) return "Flexible time";
  if (minutes >= 120 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} min`;
}

function paymentState(visit: Visit) {
  switch (visit.paymentStatus) {
    case "succeeded":
      return "Paid";
    case "refunded":
      return "Refunded";
    case "cancelled":
      return "Hold released";
    case "capture_failed":
    case "failed":
      return "Payment needs attention";
    case "authorised":
      return visit.status === "offered" || visit.status === "declined"
        ? "Payment held"
        : "Payment secured";
    case "capturing":
      return "Payment processing";
  }
  if (visit.status === "completed") return "Paid";
  return visit.paymentLabel ?? "Payment secured";
}

function stateCopy(visit: Visit, elapsed: string) {
  const professional = visit.providerName ?? "Your professional";
  if (["offered", "declined"].includes(visit.status)) {
    return {
      tone: "booked",
      title: "Waiting for professional confirmation",
      detail: "We’ll let you know as soon as your professional confirms.",
    };
  }
  if (visit.status === "scheduled") {
    if (visit.delayMinutes) {
      const eta = new Date(
        new Date(visit.scheduled_at).getTime() + visit.delayMinutes * 60_000,
      ).toISOString();
      return {
        tone: "delay",
        title: `${professional} is running about ${visit.delayMinutes} minutes late`,
        detail: `Updated arrival around ${clock(eta)} · you can message them for details.`,
      };
    }
    return {
      tone: "confirmed",
      title: `${professional} has confirmed your booking`,
      detail: `You’ll receive updates when ${professional} is on the way.`,
    };
  }
  if (visit.status === "in_progress") {
    return {
      tone: "arrived",
      title: `${professional} has arrived`,
      detail: elapsed
        ? `Your visit is in progress · ${elapsed}`
        : "Your visit is starting now.",
    };
  }
  if (visit.status === "completed") {
    return {
      tone: "done",
      title: "Visit completed successfully",
      detail: `We hope you enjoyed your experience with ${professional}.`,
    };
  }
  return {
    tone: "neutral",
    title: "Booking update",
    detail: "Open your booking for the latest information.",
  };
}

export default function CurrentVisit({
  visit,
  serviceOptions = [],
}: {
  visit: Visit;
  serviceOptions?: BookingServiceOption[];
}) {
  const live = visit.status === "in_progress";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  let elapsed = "";
  if (live && visit.arrivedAt) {
    const seconds = Math.max(
      0,
      Math.floor((now - new Date(visit.arrivedAt).getTime()) / 1000),
    );
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    elapsed = `${hours ? `${hours}:` : ""}${String(minutes).padStart(
      hours ? 2 : 1,
      "0",
    )}:${String(rest).padStart(2, "0")}`;
  }

  const finish = finishTime(visit.scheduled_at, visit.durationMinutes);
  const state = stateCopy(visit, elapsed);
  const detailHref = `/account/visit/${visit.id}`;
  const assigned = Boolean(visit.providerName);
  const providerInitial = (visit.providerName ?? "P")
    .trim()
    .charAt(0)
    .toUpperCase();

  return (
    <section className={`booking-state ${state.tone}`}>
      <header className="booking-head">
        <div className="booking-title">
          <h3>
            {visit.service} · {durationLabel(visit.durationMinutes)}
          </h3>
          <div className="date-row">
            <span>
              <CalendarDays size={16} /> {relativeDate(visit.scheduled_at)} at{" "}
              {clock(visit.scheduled_at)}
            </span>
            {!live && visit.status !== "completed" && (
              <b>· {countdown(visit.scheduled_at)}</b>
            )}
            {visit.status === "completed" && visit.finishedAt && (
              <b>Completed at {clock(visit.finishedAt)}</b>
            )}
          </div>
        </div>

        <div className="progress-wrap">
          <BookingProgress
            status={visit.status}
            stage={stageIndex(visit.status)}
            labels={STAGES}
          />
        </div>
      </header>

      <div className="summary-grid">
        <div className="identity-card professional-identity">
          {assigned ? (
            <div className="professional-row">
              {visit.providerPhoto ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={visit.providerPhoto} alt="" className="avatar" />
              ) : (
                <span className="avatar fallback">{providerInitial}</span>
              )}
              <div className="identity-copy">
                <strong>{visit.providerName}</strong>
                <div className="identity-meta">
                  <b className="rating">
                    {visit.providerRating !== null
                      ? `${Number(visit.providerRating).toFixed(1)} ★ (${visit.providerRatingCount ?? 0})`
                      : "Not yet rated"}
                  </b>
                  {visit.providerVerified && (
                    <span>
                      <ShieldCheck size={11} /> Verified
                    </span>
                  )}
                </div>
                <small className="history">
                  <RotateCcw size={13} />
                  {visit.providerYearsExperience
                    ? `${visit.providerYearsExperience}+ years experience`
                    : `${visit.providerRatingCount ?? 0} client reviews`}
                </small>
              </div>
            </div>
          ) : (
            <>
              <strong>TBD</strong>
              <small>Assigning a professional</small>
            </>
          )}
        </div>

        <Summary tone="sky" icon={<MapPin size={19} />} label="Location">
          <strong>{visit.address ?? "Address unavailable"}</strong>
        </Summary>

        <Summary tone="butter" icon={<Clock3 size={19} />} label="Duration">
          <strong>{durationLabel(visit.durationMinutes)}</strong>
          <small>
            {clock(visit.scheduled_at)}
            {finish ? ` – ${clock(finish)}` : ""}
          </small>
        </Summary>

        <Summary tone="blush" icon={<CreditCard size={19} />} label="Payment">
          <strong>
            {visit.paymentAmount !== null && visit.paymentAmount !== undefined
              ? `£${visit.paymentAmount.toFixed(2)}`
              : "Included"}
          </strong>
          <small>{paymentState(visit)}</small>
        </Summary>
      </div>

      {visit.status === "scheduled" && (
        <CheckInCodePanel
          bookingId={visit.id}
          providerName={visit.providerName}
          compact
        />
      )}

      <footer className="state-bar">
        {state.tone === "booked" ? (
          <Info size={22} />
        ) : (
          <CheckCircle2 size={24} />
        )}
        <div className="state-copy">
          <strong>{state.title}</strong>
          <span>{state.detail}</span>
        </div>

        <div className="state-actions">
          {state.tone === "booked" ? (
            <>
              <BookingTools
                id={visit.id}
                postcode={visit.address}
                showCancel={false}
                service={visit.service}
                durationMinutes={visit.durationMinutes}
                scheduledAt={visit.scheduled_at}
                providerName={visit.providerName}
                address={visit.address}
                paymentAmount={visit.paymentAmount}
                packageId={visit.packageId}
                bookingNotes={visit.bookingNotes}
                serviceOptions={serviceOptions}
                triggerVariant="card"
                triggerLabel="Manage booking"
              />
              <a className="danger-action" href={`${detailHref}?cancel=1`}>
                Cancel booking
              </a>
            </>
          ) : state.tone === "confirmed" ? (
            <>
              <BookingTools
                id={visit.id}
                postcode={visit.address}
                showCancel={false}
                service={visit.service}
                durationMinutes={visit.durationMinutes}
                scheduledAt={visit.scheduled_at}
                providerName={visit.providerName}
                address={visit.address}
                paymentAmount={visit.paymentAmount}
                packageId={visit.packageId}
                bookingNotes={visit.bookingNotes}
                serviceOptions={serviceOptions}
                triggerVariant="card"
              />
              <a className="danger-action" href={`${detailHref}?cancel=1`}>
                Cancel booking
              </a>
              <a className="secondary-action" href={detailHref}>
                <Eye size={16} /> See full details
              </a>
              <a className="primary-action" href={`${detailHref}?chat=1`}>
                <MessageSquare size={16} /> Message{" "}
                {visit.providerName?.split(" ")[0] ?? "pro"}
              </a>
            </>
          ) : state.tone === "done" ? (
            <>
              <a
                className="secondary-action success"
                href={`${detailHref}#review`}
              >
                <Star size={16} /> Rate your pro
              </a>
              <a className="primary-action success" href="/book">
                <CalendarDays size={16} /> Book again
              </a>
            </>
          ) : (
            <>
              <a className="secondary-action" href={detailHref}>
                <Eye size={16} /> {live ? "Open details" : "See full details"}
              </a>
              <a className="primary-action" href={`${detailHref}?chat=1`}>
                <MessageSquare size={16} /> Message{" "}
                {visit.providerName?.split(" ")[0] ?? "pro"}
              </a>
            </>
          )}
        </div>
      </footer>

      <style jsx>{`
        .booking-state {
          container-type: inline-size;
          box-sizing: border-box;
          width: 100%;
          overflow: hidden;
          margin-bottom: 16px;
          border: 1px solid var(--ob-border);
          border-radius: 18px;
          background: var(--ob-surface);
          color: var(--ob-text);
          box-shadow: 0 8px 24px rgba(22, 32, 42, 0.06);
          font-family: "Nunito", system-ui, sans-serif;
        }
        .booking-state.arrived {
          border-color: color-mix(
            in srgb,
            var(--ob-info-text) 45%,
            var(--ob-border)
          );
          box-shadow: 0 12px 30px var(--ob-shadow);
        }
        .booking-state.delay {
          border-color: #f2c66d;
        }
        .booking-head {
          display: grid;
          grid-template-columns: minmax(260px, 0.9fr) minmax(390px, 1.2fr);
          align-items: start;
          gap: 26px;
          padding: 17px 20px 8px;
        }
        .booking-title,
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
        .date-row b {
          color: var(--ob-muted);
          font-size: 12px;
          font-weight: 800;
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
        .professional-row {
          display: flex;
          align-items: center;
          gap: 9px;
          min-width: 0;
        }
        .professional-row > div {
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
          display: inline-flex;
          align-items: center;
          gap: 3px;
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
          width: 48px;
          height: 48px;
          flex: 0 0 48px;
          border-radius: 50%;
          object-fit: cover;
        }
        .avatar.fallback {
          display: grid;
          place-items: center;
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
        .arrived .state-bar {
          background: var(--ob-butter);
          color: var(--ob-warning-text);
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
        .state-copy span {
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
        .secondary-action,
        .primary-action,
        .danger-action {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          min-height: 38px;
          box-sizing: border-box;
          border-radius: 9px;
          padding: 8px 15px;
          white-space: nowrap;
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
          cursor: pointer;
          font-family: inherit;
        }
        .danger-action {
          border: 1px solid var(--ob-danger-text);
          background: var(--ob-surface);
          color: var(--ob-danger-text);
        }
        .secondary-action.success {
          border-color: var(--ob-success-text);
          color: var(--ob-success-text);
        }
        .primary-action.success {
          border-color: var(--ob-success-text);
          background: var(--ob-success-text);
        }
        @container (max-width: 960px) {
          .booking-head {
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
        @container (max-width: 620px) {
          .summary-grid {
            grid-template-columns: 1fr;
          }
          .state-actions {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .secondary-action,
          .primary-action,
          .danger-action {
            width: 100%;
          }
        }
        @container (max-width: 390px) {
          .state-actions {
            grid-template-columns: 1fr;
          }
        }
        @media (max-width: 1080px) {
          .booking-head {
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
          .booking-head {
            padding: 16px 16px 7px;
          }
          h3 {
            font-size: 18px;
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
          .secondary-action,
          .primary-action,
          .danger-action {
            width: 100%;
          }
        }
        @media (max-width: 430px) {
          .state-actions {
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
      `}</style>
    </div>
  );
}

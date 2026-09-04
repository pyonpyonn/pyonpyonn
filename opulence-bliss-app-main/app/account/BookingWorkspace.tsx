"use client";

import { useEffect, useState, useTransition } from "react";
import type { ReactNode } from "react";
import {
  CalendarDays,
  Check,
  CheckCircle2,
  Clock3,
  CreditCard,
  Headphones,
  Info,
  MapPin,
  MessageSquare,
  ShieldCheck,
  Star,
  X,
} from "lucide-react";
import BookingProgress from "@/components/BookingProgress";
import CheckInCodePanel from "@/components/CheckInCodePanel";
import MessageThread from "@/components/MessageThread";
import type { VisitStatus } from "@/lib/visitStatus";
import { cancelBooking } from "./actions";

export type ClientBookingWorkspaceData = {
  id: string;
  status: string;
  service: string;
  durationMinutes: number | null;
  scheduledAt: string;
  address: string | null;
  bookedAt: string | null;
  confirmedAt: string | null;
  delayMinutes: number | null;
  delayReportedAt: string | null;
  arrivedAt: string | null;
  finishedAt: string | null;
  paymentAmount: number | null;
  paymentLabel: string;
  paymentExplanation: string;
  provider: {
    assigned: boolean;
    name: string | null;
    photoUrl: string | null;
    rating: number | null;
    ratingCount: number;
    bio: string | null;
    yearsExperience: number | null;
    profession: string;
    backgroundChecked: boolean;
  };
  latestReview: { rating: number; comment: string | null } | null;
};

const CANCEL_REASONS = [
  "Change of plans",
  "Found another time",
  "Too expensive",
  "Service no longer needed",
  "Other reason",
];

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

function endTime(start: string, minutes: number | null) {
  if (!minutes) return null;
  return new Date(new Date(start).getTime() + minutes * 60_000).toISOString();
}

function stageFor(booking: ClientBookingWorkspaceData) {
  if (booking.status === "completed") return 3;
  if (booking.status === "in_progress" || booking.arrivedAt) return 2;
  if (booking.status === "scheduled" || booking.confirmedAt) return 1;
  return 0;
}

function nextSteps(booking: ClientBookingWorkspaceData) {
  const end = endTime(booking.scheduledAt, booking.durationMinutes);
  const arrival = booking.delayMinutes
    ? new Date(
        new Date(booking.scheduledAt).getTime() +
          booking.delayMinutes * 60_000,
      ).toISOString()
    : booking.scheduledAt;
  if (booking.status === "completed") {
    return [
      ["Visit complete", "Your provider checked out.", booking.finishedAt],
      ["Payment", "Your visit payment has been settled.", null],
      ["Your review", "Share how the visit went.", null],
      ["Book again", "Repeat the service whenever you need it.", null],
    ];
  }
  if (booking.status === "in_progress") {
    return [
      [
        "Visit in progress",
        "Your provider is taking care of it now.",
        booking.arrivedAt,
      ],
      ["Expected finish", "The planned visit duration ends here.", end],
      ["Check-out", "You will see the recorded finish time.", null],
      ["Payment", "Your card is charged after the visit finishes.", null],
    ];
  }
  if (["offered", "declined"].includes(booking.status)) {
    return [
      [
        "Provider confirmation",
        "We are matching the right professional.",
        null,
      ],
      [
        "Arriving",
        "Your professional will message before arrival.",
        arrival,
      ],
      ["Visit in progress", "They check in when they reach the address.", null],
      ["Visit complete", "Payment is handled after check-out.", end],
    ];
  }
  return [
    [
      "Arriving",
      `${booking.provider.name ?? "Your professional"} will message before arrival.`,
      arrival,
    ],
    [
      "On the way",
      "You will get an update when your professional is close.",
      null,
    ],
    ["Visit in progress", "They check in, and the live timer starts.", null],
    [
      "Visit complete",
      "You are only charged after the visit is finished.",
      end,
    ],
  ];
}

export default function BookingWorkspace({
  booking,
  visitStatus,
  canCancel,
  canModify,
  chatClosed,
  modifyControl,
  children,
}: {
  booking: ClientBookingWorkspaceData;
  visitStatus: VisitStatus | null;
  canCancel: boolean;
  canModify: boolean;
  chatClosed: boolean;
  modifyControl?: ReactNode;
  children?: ReactNode;
}) {
  const [chatOpen, setChatOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [otherReason, setOtherReason] = useState("");
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const modalOpen = chatOpen || cancelOpen;
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("chat") === "1") setChatOpen(true);
    if (params.get("cancel") === "1" && canCancel) setCancelOpen(true);
  }, [canCancel]);

  useEffect(() => {
    if (!modalOpen) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setChatOpen(false);
        setCancelOpen(false);
      }
    };
    window.addEventListener("keydown", escape);
    return () => {
      document.body.style.overflow = before;
      window.removeEventListener("keydown", escape);
    };
  }, [modalOpen]);

  const providerName = booking.provider.assigned
    ? (booking.provider.name ?? "Assigned professional")
    : "Being matched";
  const finish = endTime(booking.scheduledAt, booking.durationMinutes);
  const updatedArrival = booking.delayMinutes
    ? new Date(
        new Date(booking.scheduledAt).getTime() +
          booking.delayMinutes * 60_000,
      ).toISOString()
    : null;
  const bookingRef = `#BKG-${booking.id.slice(0, 8).toUpperCase()}`;
  const stage = stageFor(booking);
  const timelineDetails = [
    compactDateTime(booking.bookedAt),
    compactDateTime(booking.confirmedAt),
    compactDateTime(booking.arrivedAt ?? booking.scheduledAt),
    compactDateTime(booking.finishedAt ?? finish),
  ];
  const timelineLabels = [
    "Booked",
    "Confirmed",
    stage >= 2 ? "Arrived" : "Arriving",
    "Done",
  ];

  function closeDialogs() {
    setChatOpen(false);
    setCancelOpen(false);
    setCancelError(null);
  }

  function confirmCancellation() {
    setCancelError(null);
    startTransition(async () => {
      try {
        const selected = reason === "Other reason" ? otherReason : reason;
        const result = await cancelBooking(booking.id, selected);
        if (!result.ok) {
          setCancelError(result.message);
          return;
        }
        window.location.href = "/account";
      } catch (error) {
        setCancelError(
          error instanceof Error
            ? error.message
            : "This booking could not be cancelled.",
        );
      }
    });
  }

  return (
    <div className="booking-workspace">
      <section className="booking-card">
        <div className="booking-head">
          <div>
            <h1>
              {booking.service}
              {booking.durationMinutes
                ? ` · ${booking.durationMinutes} min`
                : ""}
            </h1>
            <p className="booking-id">Booking ID: {bookingRef}</p>
          </div>
          <div className="head-buttons">
            {canModify && modifyControl}
            {booking.provider.assigned && (
              <button
                className="message-button"
                onClick={() => setChatOpen(true)}
              >
                <MessageSquare size={18} /> Message {providerName.split(" ")[0]}
              </button>
            )}
          </div>
        </div>

        <div className="date-chip">
          <span>
            <CalendarDays size={18} /> {relativeDate(booking.scheduledAt)},{" "}
            {fullDate(booking.scheduledAt)}
          </span>
          <span>
            <Clock3 size={18} /> {clock(booking.scheduledAt)}
          </span>
          {updatedArrival && (
            <strong className="delay-chip">
              Updated arrival: {clock(updatedArrival)}
            </strong>
          )}
        </div>

        <BookingProgress
          status={booking.status}
          stage={stage}
          labels={timelineLabels}
          details={timelineDetails}
        />

        <div className="summary-grid">
          <SummaryCard tone="sky" icon={<MapPin size={22} />} label="Location">
            <strong>{booking.address ?? "Address saved"}</strong>
            <small>Your booked service address</small>
          </SummaryCard>
          <SummaryCard
            tone="butter"
            icon={<Clock3 size={22} />}
            label="Duration"
          >
            <strong>
              {booking.durationMinutes
                ? `${booking.durationMinutes} min`
                : "Set service time"}
            </strong>
            <small>
              {clock(booking.scheduledAt)}
              {finish ? ` – ${clock(finish)}` : ""}
            </small>
          </SummaryCard>
          <SummaryCard
            tone="blush"
            icon={<CreditCard size={22} />}
            label="Payment"
          >
            <strong>{booking.paymentLabel}</strong>
            <b>{money(booking.paymentAmount)}</b>
            <small>
              <Info size={14} /> {booking.paymentExplanation}
            </small>
          </SummaryCard>
        </div>

        {booking.provider.assigned && (
          <section className="professional-card">
            <div className="professional-main">
              <ProviderAvatar
                name={providerName}
                photoUrl={booking.provider.photoUrl}
                large
              />
              <div className="professional-copy">
                <div className="professional-title">
                  <h2>{providerName}</h2>
                  {booking.provider.rating !== null &&
                    booking.provider.rating >= 4.7 && <span>Top rated</span>}
                </div>
                <p>{booking.provider.profession}</p>
                <div className="rating-line">
                  {booking.provider.rating !== null ? (
                    <>
                      <strong>{booking.provider.rating.toFixed(1)}</strong>
                      <span
                        className="stars"
                        aria-label={`${booking.provider.rating.toFixed(1)} out of 5 stars`}
                      >
                        {[1, 2, 3, 4, 5].map((item) => {
                          const filled =
                            item <= Math.round(booking.provider.rating ?? 0);
                          return (
                            <Star
                              key={item}
                              size={16}
                              fill={filled ? "currentColor" : "none"}
                              opacity={filled ? 1 : 0.38}
                            />
                          );
                        })}
                      </span>
                      <span>({booking.provider.ratingCount} reviews)</span>
                    </>
                  ) : (
                    <span>New to Opulence Bliss</span>
                  )}
                </div>
                {booking.provider.yearsExperience !== null && (
                  <p>{booking.provider.yearsExperience}+ years experience</p>
                )}
                {booking.provider.backgroundChecked && (
                  <p className="verified">
                    <ShieldCheck size={17} /> Background checked
                  </p>
                )}
                {booking.provider.bio && (
                  <p className="bio">{booking.provider.bio}</p>
                )}
              </div>
            </div>
            <div className="review-column">
              <span className="mini-heading">What clients say</span>
              {booking.latestReview?.comment ? (
                <blockquote>
                  “{booking.latestReview.comment}”
                  <small>— Verified client</small>
                </blockquote>
              ) : (
                <blockquote>
                  This professional&apos;s rating comes from completed visits.
                </blockquote>
              )}
              <a href="/providers">View all professionals</a>
            </div>
            <p className="rating-note">
              <Info size={16} /> This rating is from completed visits by other
              clients.
            </p>
          </section>
        )}

        <section
          className={`status-banner ${booking.delayMinutes && booking.status === "scheduled" ? "warning" : (visitStatus?.tone ?? "neutral")}`}
        >
          <CheckCircle2 size={29} />
          <div>
            <strong>
              {booking.delayMinutes && booking.status === "scheduled"
                ? `${providerName} is running about ${booking.delayMinutes} minutes late`
                : (visitStatus?.headline ?? "Your booking is confirmed")}
            </strong>
            <p>
              {booking.delayMinutes && updatedArrival
                ? `Updated arrival around ${clock(updatedArrival)}. The provider’s update is also saved in Messages.`
                : (visitStatus?.detail ?? "We will keep you updated here.")}
            </p>
          </div>
          {canCancel && (
            <button onClick={() => setCancelOpen(true)}>Cancel booking</button>
          )}
        </section>

        {booking.status === "scheduled" && (
          <CheckInCodePanel
            bookingId={booking.id}
            providerName={booking.provider.name}
          />
        )}

        <div className="detail-grid">
          <section className="next-card">
            <h2>What happens next?</h2>
            <ol>
              {nextSteps(booking).map(([title, description, at], index) => (
                <li key={title}>
                  <span className="step-icon">
                    {index === 3 ? <Star size={16} /> : <Clock3 size={16} />}
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

          <div className="stacked-details">
            <section className="small-detail-card">
              <h2>
                <CreditCard size={18} /> Payment details
              </h2>
              <DetailRow label="Amount" value={money(booking.paymentAmount)} />
              <DetailRow
                label="Payment status"
                value={booking.paymentLabel}
                badge
              />
              <DetailRow
                label="You’ll be charged"
                value={
                  visitStatus?.money.state === "authorised"
                    ? "After the visit is complete"
                    : (visitStatus?.money.explanation ??
                      booking.paymentExplanation)
                }
              />
            </section>
            <section className="small-detail-card">
              <h2>
                <CalendarDays size={18} /> Booking details
              </h2>
              <DetailRow
                label="Service"
                value={`${booking.service}${booking.durationMinutes ? ` · ${booking.durationMinutes} min` : ""}`}
              />
              <DetailRow
                label="Date"
                value={`${fullDate(booking.scheduledAt)} (${relativeDate(booking.scheduledAt)})`}
              />
              <DetailRow
                label="Time"
                value={`${clock(booking.scheduledAt)}${finish ? ` – ${clock(finish)}` : ""}`}
              />
              <DetailRow label="Booking ID" value={bookingRef} />
              <DetailRow
                label="Created"
                value={compactDateTime(booking.bookedAt)}
              />
            </section>
          </div>
        </div>

        {children && (
          <section className="additional-actions">{children}</section>
        )}

        <section className="support-bar">
          <Headphones size={26} />
          <div>
            <strong>Need help?</strong>
            <p>Our support team is here for you.</p>
          </div>
          <button
            onClick={() =>
              window.dispatchEvent(new Event("opulence:open-support"))
            }
          >
            Contact support
          </button>
        </section>
      </section>

      {chatOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDialogs();
          }}
        >
          <section
            className="dialog chat-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`Messages with ${providerName}`}
          >
            <header className="dialog-head chat-head">
              <ProviderAvatar
                name={providerName}
                photoUrl={booking.provider.photoUrl}
              />
              <div>
                <strong>{providerName}</strong>
                <span>
                  {booking.provider.profession}
                  {booking.provider.rating !== null
                    ? ` · ${booking.provider.rating.toFixed(1)} ★ (${booking.provider.ratingCount})`
                    : ""}
                </span>
              </div>
              <button
                className="icon-close"
                onClick={closeDialogs}
                aria-label="Close messages"
              >
                <X size={21} />
              </button>
            </header>
            <p className="chat-safety">
              <ShieldCheck size={19} /> This chat is for booking-related
              messages only. Be kind and respectful.
            </p>
            <MessageThread
              bookingId={booking.id}
              viewerRole="customer"
              closed={chatClosed}
              bare
            />
          </section>
        </div>
      )}

      {cancelOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDialogs();
          }}
        >
          <section
            className="dialog cancel-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cancel-title"
          >
            <header className="dialog-head cancel-head">
              <span className="danger-icon">!</span>
              <div>
                <h2 id="cancel-title">Cancel booking</h2>
                <p>Are you sure you want to cancel this booking?</p>
              </div>
              <button
                className="icon-close"
                onClick={closeDialogs}
                aria-label="Keep booking"
              >
                <X size={21} />
              </button>
            </header>

            <div className="cancel-summary">
              <ProviderAvatar
                name={providerName}
                photoUrl={booking.provider.photoUrl}
              />
              <div>
                <strong>
                  {booking.service}
                  {booking.durationMinutes
                    ? ` · ${booking.durationMinutes} min`
                    : ""}
                </strong>
                <span>
                  <CalendarDays size={15} /> {relativeDate(booking.scheduledAt)}
                  , {fullDate(booking.scheduledAt)} at{" "}
                  {clock(booking.scheduledAt)}
                </span>
                <span>
                  <MapPin size={15} />{" "}
                  {booking.address ?? "Your service address"}
                </span>
                <span>
                  {providerName}
                  {booking.provider.rating !== null
                    ? ` · ${booking.provider.rating.toFixed(1)} ★ (${booking.provider.ratingCount})`
                    : ""}
                </span>
              </div>
              <div className="cancel-money">
                <strong>{money(booking.paymentAmount)}</strong>
                <span>{booking.paymentLabel}</span>
              </div>
            </div>

            <fieldset className="reason-list">
              <legend>
                Why are you cancelling? <span>(optional)</span>
              </legend>
              {CANCEL_REASONS.map((item) => (
                <label key={item}>
                  <input
                    type="radio"
                    name="cancel-reason"
                    value={item}
                    checked={reason === item}
                    onChange={() => setReason(item)}
                  />
                  <span>{reason === item && <Check size={13} />}</span>
                  {item}
                </label>
              ))}
            </fieldset>

            {reason === "Other reason" && (
              <textarea
                className="other-reason"
                value={otherReason}
                onChange={(event) => setOtherReason(event.target.value)}
                placeholder="Tell us briefly what changed (optional)"
                maxLength={240}
                rows={2}
              />
            )}

            <p className="cancel-notice">
              <Info size={18} /> {booking.paymentExplanation} Your bank may take
              a few days to remove a released hold.
            </p>
            {cancelError && <p className="cancel-error">{cancelError}</p>}
            <div className="cancel-buttons">
              <button className="keep" onClick={closeDialogs}>
                Keep booking
              </button>
              <button
                className="confirm-cancel"
                onClick={confirmCancellation}
                disabled={pending}
              >
                {pending ? "Cancelling…" : "Yes, cancel booking"}
              </button>
            </div>
            <p className="payment-safe">
              <ShieldCheck size={17} /> We will update the payment record
              automatically.
            </p>
          </section>
        </div>
      )}

      <style jsx>{`
        .booking-workspace {
          container-type: inline-size;
          width: 100%;
          font-family: "Nunito", system-ui, sans-serif;
          color: var(--ob-text);
        }
        .booking-card {
          background: var(--ob-surface);
          border: 1px solid var(--ob-border);
          border-radius: 24px;
          padding: clamp(20px, 3vw, 34px);
          box-shadow: 0 12px 38px
            color-mix(in srgb, var(--ob-shadow) 55%, transparent);
        }
        .booking-head {
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
        .booking-id {
          margin: 4px 0 0;
          color: var(--ob-muted);
          font-size: 14px;
          font-weight: 700;
        }
        .head-buttons {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 9px;
          flex-wrap: wrap;
        }
        .message-button,
        .modify-button,
        .support-bar button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          border: 1.5px solid var(--ob-purple);
          border-radius: 10px;
          background: transparent;
          color: var(--ob-purple);
          padding: 10px 15px;
          font: inherit;
          font-size: 14px;
          font-weight: 900;
          cursor: pointer;
          text-decoration: none;
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
        .delay-chip {
          border-radius: 999px;
          padding: 5px 10px;
          background: #fff0c9;
          color: #845500;
          font-size: 12.5px;
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
        .professional-card {
          display: grid;
          grid-template-columns: minmax(0, 1.05fr) minmax(260px, 0.95fr);
          gap: 24px;
          margin-top: 18px;
          padding: 22px;
          border: 1px solid var(--ob-border);
          border-radius: 18px;
        }
        .professional-main {
          display: flex;
          gap: 20px;
          align-items: flex-start;
          min-width: 0;
        }
        .professional-copy {
          min-width: 0;
        }
        .professional-title {
          display: flex;
          align-items: center;
          gap: 9px;
          flex-wrap: wrap;
        }
        .professional-title h2 {
          margin: 0;
          color: var(--ob-text);
          font-size: 25px;
          font-weight: 900;
        }
        .professional-title span {
          border-radius: 7px;
          background: var(--ob-purple-soft);
          color: var(--ob-purple);
          padding: 4px 8px;
          font-size: 11px;
          font-weight: 900;
        }
        .professional-copy > p {
          margin: 6px 0;
          color: var(--ob-muted);
          font-size: 14px;
          font-weight: 700;
        }
        .professional-copy .bio {
          margin-top: 12px;
          line-height: 1.5;
        }
        .verified,
        .rating-line {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .rating-line {
          flex-wrap: wrap;
          margin: 7px 0;
          color: var(--ob-success-text);
          font-size: 14px;
        }
        .rating-line strong {
          font-size: 16px;
        }
        .rating-line > span:last-child {
          color: var(--ob-muted);
        }
        .stars {
          display: inline-flex;
          gap: 2px;
        }
        .review-column {
          min-width: 0;
        }
        .mini-heading {
          color: var(--ob-muted);
          font-size: 11px;
          font-weight: 900;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        blockquote {
          margin: 10px 0;
          padding: 15px 16px;
          border: 1px solid var(--ob-border);
          border-radius: 13px;
          background: var(--ob-surface-soft);
          color: var(--ob-text);
          font-size: 13.5px;
          font-weight: 700;
          line-height: 1.55;
        }
        blockquote small {
          display: block;
          margin-top: 7px;
          color: var(--ob-muted);
        }
        .review-column a {
          display: inline-block;
          color: var(--ob-purple);
          font-size: 13px;
          font-weight: 900;
        }
        .rating-note {
          grid-column: 1 / -1;
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
        @container (max-width: 1050px) {
          .professional-card {
            grid-template-columns: minmax(0, 1fr);
            gap: 20px;
          }
          .review-column {
            padding-top: 18px;
            border-top: 1px solid var(--ob-border);
          }
          .rating-note {
            grid-column: auto;
          }
        }
        @container (max-width: 600px) {
          .professional-main {
            flex-direction: column;
          }
          .professional-copy,
          .review-column {
            width: 100%;
          }
          .rating-line {
            align-items: flex-start;
            row-gap: 7px;
          }
          .rating-line > span:last-child {
            flex-basis: 100%;
          }
          blockquote {
            overflow-wrap: anywhere;
          }
        }
        .status-banner {
          display: grid;
          grid-template-columns: auto 1fr auto;
          align-items: center;
          gap: 13px;
          margin-top: 18px;
          padding: 17px 19px;
          border: 1px solid var(--ob-border);
          border-radius: 15px;
          background: var(--ob-mint);
          color: var(--ob-success-text);
        }
        .status-banner.warning {
          background: var(--ob-butter);
          color: var(--ob-warning-text);
        }
        .status-banner.alert {
          background: var(--ob-blush);
          color: var(--ob-danger-text);
        }
        .status-banner.live {
          background: var(--ob-sky);
          color: var(--ob-info-text);
        }
        .status-banner.neutral {
          background: var(--ob-surface-soft);
          color: var(--ob-muted);
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
        .status-banner button {
          border: 1.5px solid var(--ob-danger-text);
          border-radius: 9px;
          background: transparent;
          color: var(--ob-danger-text);
          padding: 9px 13px;
          font: inherit;
          font-size: 13px;
          font-weight: 900;
          cursor: pointer;
        }
        .detail-grid {
          display: grid;
          grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.05fr);
          gap: 16px;
          margin-top: 18px;
        }
        .next-card,
        .small-detail-card,
        .additional-actions {
          border: 1px solid var(--ob-border);
          border-radius: 16px;
          background: var(--ob-surface);
          padding: 19px;
        }
        .next-card h2,
        .small-detail-card h2 {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 0 0 16px;
          color: var(--ob-text);
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
        .stacked-details {
          display: grid;
          gap: 14px;
        }
        .additional-actions {
          margin-top: 18px;
        }
        .support-bar {
          display: grid;
          grid-template-columns: auto 1fr auto;
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
        .modal-backdrop {
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
          width: min(680px, 100%);
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
        .chat-dialog {
          width: min(720px, 100%);
        }
        .dialog-head {
          display: grid;
          grid-template-columns: auto 1fr auto;
          align-items: center;
          gap: 12px;
        }
        .dialog-head strong,
        .dialog-head h2 {
          display: block;
          margin: 0;
          color: var(--ob-text);
          font-size: 20px;
          font-weight: 900;
        }
        .dialog-head span {
          color: var(--ob-muted);
          font-size: 13px;
          font-weight: 700;
        }
        .icon-close {
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
        .cancel-head {
          align-items: start;
        }
        .cancel-head p {
          margin: 5px 0 0;
          color: var(--ob-muted);
          font-size: 14px;
          font-weight: 650;
        }
        .danger-icon {
          display: grid !important;
          place-items: center;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          background: #f04b55;
          color: #fff !important;
          font-size: 22px !important;
          font-weight: 900 !important;
        }
        .cancel-summary {
          display: grid;
          grid-template-columns: auto 1fr auto;
          gap: 14px;
          align-items: start;
          margin: 20px 0;
          padding: 16px;
          border: 1px solid var(--ob-border);
          border-radius: 14px;
          background: var(--ob-surface-soft);
        }
        .cancel-summary > div:nth-child(2) {
          display: grid;
          gap: 4px;
        }
        .cancel-summary span {
          display: flex;
          align-items: center;
          gap: 5px;
          color: var(--ob-muted);
          font-size: 12.5px;
          font-weight: 700;
        }
        .cancel-money {
          justify-items: end;
        }
        .cancel-money strong {
          font-size: 16px;
        }
        .cancel-money span {
          margin-top: 5px;
          border-radius: 7px;
          background: var(--ob-butter);
          color: var(--ob-warning-text);
          padding: 4px 8px;
        }
        .reason-list {
          margin: 0;
          padding: 0;
          border: 1px solid var(--ob-border);
          border-radius: 14px;
          overflow: hidden;
        }
        .reason-list legend {
          width: 100%;
          box-sizing: border-box;
          padding: 0 0 10px;
          border: 0;
          color: var(--ob-text);
          font-size: 13.5px;
          font-weight: 900;
        }
        .reason-list legend span {
          color: var(--ob-muted);
          font-weight: 600;
        }
        .reason-list label {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 14px;
          border-bottom: 1px solid var(--ob-border);
          color: var(--ob-text);
          font-size: 13.5px;
          font-weight: 700;
          cursor: pointer;
        }
        .reason-list label:last-child {
          border-bottom: 0;
        }
        .reason-list input {
          position: absolute;
          opacity: 0;
          pointer-events: none;
        }
        .reason-list label > span {
          display: grid;
          place-items: center;
          width: 18px;
          height: 18px;
          border: 1.5px solid var(--ob-border);
          border-radius: 50%;
          color: var(--ob-purple);
        }
        .reason-list input:checked + span {
          border-color: var(--ob-purple);
          background: var(--ob-purple-soft);
        }
        .other-reason {
          width: 100%;
          box-sizing: border-box;
          margin-top: 10px;
          border: 1px solid var(--ob-border);
          border-radius: 12px;
          padding: 11px 12px;
          font: inherit;
          resize: vertical;
        }
        .cancel-notice,
        .cancel-error {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          margin: 16px 0;
          padding: 12px 14px;
          border-radius: 12px;
          background: var(--ob-blush);
          color: var(--ob-danger-text);
          font-size: 12.5px;
          font-weight: 750;
          line-height: 1.45;
        }
        .cancel-error {
          display: block;
        }
        .cancel-buttons {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }
        .cancel-buttons button {
          border-radius: 10px;
          padding: 12px 14px;
          font: inherit;
          font-size: 14px;
          font-weight: 900;
          cursor: pointer;
        }
        .keep {
          border: 1.5px solid #e52d3a;
          background: transparent;
          color: #e52d3a;
        }
        .confirm-cancel {
          border: 1.5px solid #e52d3a;
          background: #e52d3a;
          color: #fff;
        }
        .confirm-cancel:disabled {
          opacity: 0.55;
          cursor: wait;
        }
        .payment-safe {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          margin: 14px 0 0;
          color: var(--ob-muted);
          font-size: 12.5px;
          font-weight: 700;
        }
        @media (max-width: 900px) {
          .summary-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .professional-card,
          .detail-grid {
            grid-template-columns: 1fr;
          }
          .rating-note {
            grid-column: auto;
          }
        }
        @media (max-width: 640px) {
          .booking-card {
            border-radius: 18px;
            padding: 17px !important;
          }
          .head-buttons,
          .message-button,
          .modify-button,
          .support-bar button {
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
          .professional-main {
            flex-direction: column;
          }
          .professional-card {
            padding: 17px !important;
          }
          .status-banner,
          .support-bar {
            grid-template-columns: auto 1fr;
          }
          .status-banner button,
          .support-bar button {
            grid-column: 1 / -1;
          }
          .modal-backdrop {
            align-items: end;
            padding: 0;
          }
          .dialog {
            width: 100%;
            max-height: 92vh;
            border-radius: 22px 22px 0 0;
            padding: 18px;
          }
          .cancel-summary {
            grid-template-columns: auto 1fr;
          }
          .cancel-money {
            grid-column: 2;
            justify-items: start;
          }
          .cancel-buttons {
            grid-template-columns: 1fr;
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
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <article className={`summary-card ${tone}`}>
      <span className="summary-label">
        {icon} {label}
      </span>
      {children}
      <style jsx>{`
        .summary-card {
          min-width: 0;
          min-height: 150px;
          box-sizing: border-box;
          border-radius: 14px;
          padding: 15px;
          color: var(--ob-text);
        }
        .summary-card.mint {
          background: var(--ob-mint);
        }
        .summary-card.sky {
          background: var(--ob-sky);
        }
        .summary-card.butter {
          background: var(--ob-butter);
        }
        .summary-card.blush {
          background: var(--ob-blush);
        }
        .summary-label {
          display: flex;
          align-items: center;
          gap: 7px;
          color: var(--ob-muted);
          font-size: 11px;
          font-weight: 900;
          letter-spacing: 0.05em;
          text-transform: uppercase;
        }
        .summary-card :global(strong),
        .summary-card :global(b),
        .summary-card :global(small) {
          display: flex;
          align-items: flex-start;
          gap: 6px;
        }
        .summary-card :global(strong) {
          margin-top: 14px;
          color: var(--ob-text);
          font-size: 17px;
          font-weight: 900;
          overflow-wrap: anywhere;
        }
        .summary-card :global(b) {
          margin-top: 5px;
          color: var(--ob-text);
          font-size: 15px;
          font-weight: 900;
        }
        .summary-card :global(small) {
          margin-top: 12px;
          color: var(--ob-muted);
          font-size: 11.5px;
          font-weight: 700;
          line-height: 1.4;
        }
      `}</style>
    </article>
  );
}

function ProviderAvatar({
  name,
  photoUrl,
  large = false,
}: {
  name: string;
  photoUrl: string | null;
  large?: boolean;
}) {
  const size = large ? 108 : 52;
  const avatarStyle = {
    width: size,
    height: size,
    flex: `0 0 ${size}px`,
    borderRadius: "50%",
    objectFit: "cover" as const,
    border: "3px solid var(--ob-surface)",
    boxShadow: "0 0 0 1px var(--ob-border)",
  };

  return photoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img style={avatarStyle} src={photoUrl} alt={name} />
  ) : (
    <span
      style={{
        ...avatarStyle,
        display: "grid",
        placeItems: "center",
        boxSizing: "border-box",
        background:
          "linear-gradient(135deg, var(--ob-purple-soft), var(--ob-sky))",
        color: "var(--ob-purple)",
        fontSize: large ? 34 : 18,
        fontWeight: 900,
      }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

function DetailRow({
  label,
  value,
  badge = false,
}: {
  label: string;
  value: string;
  badge?: boolean;
}) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong className={badge ? "badge" : ""}>{value}</strong>
      <style jsx>{`
        .detail-row {
          display: flex;
          justify-content: space-between;
          gap: 18px;
          padding: 6px 0;
          color: var(--ob-text);
          font-size: 12.5px;
        }
        .detail-row span {
          color: var(--ob-muted);
          font-weight: 700;
        }
        .detail-row strong {
          max-width: 65%;
          text-align: right;
          font-weight: 800;
          overflow-wrap: anywhere;
        }
        .detail-row strong.badge {
          border-radius: 7px;
          background: var(--ob-butter);
          color: var(--ob-warning-text);
          padding: 3px 7px;
        }
      `}</style>
    </div>
  );
}

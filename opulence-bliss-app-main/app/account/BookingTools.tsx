"use client";

// Cancel / reschedule / rate — the client's controls on each booking.
// Save at: app/account/BookingTools.tsx

import { useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import AppointmentTimePicker from "@/components/AppointmentTimePicker";
import modalStyles from "./BookingToolsModal.module.css";
import {
  CalendarDays,
  Check,
  Clock3,
  CreditCard,
  Info,
  MapPin,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  cancelBooking,
  loadRescheduleWindow,
  modifyBooking,
  rateBooking,
} from "./actions";

export type BookingServiceOption = {
  id: string;
  name: string;
  price: number;
  durationMinutes: number | null;
  serviceType: string | null;
};

function label(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const tmr = new Date();
  tmr.setDate(today.getDate() + 1);
  const day =
    d.toDateString() === today.toDateString()
      ? "Today"
      : d.toDateString() === tmr.toDateString()
        ? "Tomorrow"
        : d.toLocaleDateString("en-GB", {
            weekday: "short",
            day: "numeric",
            month: "short",
          });
  return `${day}, ${d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  })}`;
}

function fullDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function timeRange(iso: string, durationMinutes: number | null) {
  const start = new Date(iso);
  const end = new Date(start.getTime() + (durationMinutes ?? 120) * 60_000);
  const clock = (date: Date) =>
    date.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  return `${clock(start)} – ${clock(end)}`;
}

function durationLabel(minutes: number | null) {
  if (!minutes) return "Visit";
  if (minutes >= 120 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} min`;
}

const RESCHEDULE_REASONS = [
  "Schedule conflict",
  "Change of plans",
  "Found a better time",
  "Other",
];

const linkBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  font: "inherit",
  fontSize: 13.5,
  cursor: "pointer",
  textDecoration: "underline",
};

export function BookingTools({
  id,
  postcode,
  showCancel = true,
  service = "Your service",
  durationMinutes = null,
  scheduledAt,
  providerName,
  address,
  paymentAmount = null,
  packageId,
  bookingNotes = "",
  serviceOptions = [],
  triggerVariant = "link",
  triggerLabel = "Modify booking",
}: {
  id: string;
  postcode: string | null;
  showCancel?: boolean;
  service?: string;
  durationMinutes?: number | null;
  scheduledAt?: string;
  providerName?: string | null;
  address?: string | null;
  paymentAmount?: number | null;
  packageId: string;
  bookingNotes?: string | null;
  serviceOptions?: BookingServiceOption[];
  triggerVariant?: "link" | "card" | "header";
  triggerLabel?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [slots, setSlots] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [cutoff, setCutoff] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState("");
  const [selectedPackageId, setSelectedPackageId] = useState(packageId);
  const [visitNotes, setVisitNotes] = useState(bookingNotes ?? "");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const openedFromLink = useRef(false);

  function closeDialog() {
    if (pending) return;
    setOpen(false);
    setSelectedSlot(scheduledAt ?? "");
    setSelectedPackageId(packageId);
    setVisitNotes(bookingNotes ?? "");
    setMessage(null);
  }

  async function fetchSlots(
    selectedDuration: number | null,
    preferredSlot = scheduledAt ?? "",
  ) {
    setSlots(null);
    try {
      const res = await fetch(
        `/api/slots?postcode=${encodeURIComponent(
          postcode ?? "",
        )}&duration=${encodeURIComponent(String(selectedDuration ?? 120))}`,
      );
      const data = await res.json();
      const nextSlots = (data.slots ?? []) as string[];
      const choices = preferredSlot
        ? Array.from(new Set([preferredSlot, ...nextSlots])).sort(
            (a, b) => new Date(a).getTime() - new Date(b).getTime(),
          )
        : nextSlots;
      setSlots(choices);
      setSelectedSlot(preferredSlot || choices[0] || "");
    } catch {
      setSlots([]);
      setMessage("Available appointments could not be loaded. Try again.");
    }
  }

  async function loadSlots() {
    setOpen(true);
    setMessage(null);
    setSlots(null);
    setSelectedSlot(scheduledAt ?? "");
    setSelectedPackageId(packageId);
    setVisitNotes(bookingNotes ?? "");
    try {
      const windowResult = await loadRescheduleWindow(id);
      if (!windowResult.ok) {
        setMessage(windowResult.message);
        setSlots([]);
        return;
      }
      setCutoff(windowResult.window.cutoff_at ?? null);
      if (!windowResult.window.can_reschedule) {
        setMessage(
          windowResult.window.reason ?? "This visit can no longer be changed.",
        );
        setSlots([]);
        return;
      }

      await fetchSlots(durationMinutes, scheduledAt);
    } catch {
      setSlots([]);
      setMessage("Available appointments could not be loaded. Try again.");
    }
  }

  useEffect(() => {
    if (openedFromLink.current) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("reschedule") !== "1") return;
    openedFromLink.current = true;
    void loadSlots();
    // loadSlots is intentionally run once for the explicit dashboard link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const openForBooking = (event: Event) => {
      const detail = (event as CustomEvent<{ bookingId?: string }>).detail;
      if (detail?.bookingId === id) void loadSlots();
    };
    window.addEventListener("opulence:modify-booking", openForBooking);
    return () =>
      window.removeEventListener("opulence:modify-booking", openForBooking);
    // loadSlots reads the latest component props; this listener is refreshed
    // whenever the booking data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, scheduledAt, packageId, bookingNotes, durationMinutes]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) closeDialog();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKeyDown);
    };
    // closeDialog only uses local setters and pending is deliberately observed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pending]);

  const currentService = serviceOptions.find((item) => item.id === packageId);
  const selectedService =
    serviceOptions.find((item) => item.id === selectedPackageId) ??
    currentService;
  const selectedDuration = selectedService?.durationMinutes ?? durationMinutes;
  const changed =
    (scheduledAt
      ? new Date(selectedSlot).getTime() !== new Date(scheduledAt).getTime()
      : Boolean(selectedSlot)) ||
    selectedPackageId !== packageId ||
    visitNotes.trim() !== (bookingNotes ?? "").trim();

  function confirmModification() {
    if (!selectedSlot || !reason || pending) return;
    start(async () => {
      const result = await modifyBooking(
        id,
        selectedSlot,
        selectedPackageId,
        visitNotes,
        reason,
        note,
      );
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  const dialog = open ? (
    <div
      className={modalStyles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <section
        className="reschedule-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`modify-booking-title-${id}`}
      >
        <header className="dialog-head">
          <h2 id={`modify-booking-title-${id}`}>Modify booking</h2>
          <button
            type="button"
            onClick={closeDialog}
            aria-label="Keep current time"
          >
            <X size={22} />
          </button>
        </header>

        <div className="booking-summary">
          <span className="calendar-icon">
            <CalendarDays size={30} />
          </span>
          <div>
            <strong>{providerName ?? "Your professional"}</strong>
            <b>
              {selectedService?.name ?? service} ·{" "}
              {durationLabel(selectedDuration)}
            </b>
            {scheduledAt && (
              <span>
                <CalendarDays size={15} /> {fullDate(scheduledAt)}
              </span>
            )}
            {scheduledAt && (
              <span>
                <Clock3 size={15} />{" "}
                {timeRange(scheduledAt, selectedDuration)}
              </span>
            )}
            <span>
              <MapPin size={15} /> {address ?? postcode ?? "Service address"}
            </span>
            {paymentAmount !== null && (
              <span>
                <CreditCard size={15} /> £{paymentAmount.toFixed(2)} held
              </span>
            )}
          </div>
        </div>

        {slots === null ? (
          <div className="loading-state">Finding available times…</div>
        ) : message && slots.length === 0 ? (
          <div className="blocked-state">
            <Info size={21} />
            <div>
              <strong>This booking cannot be moved online</strong>
              <span>{message}</span>
              {scheduledAt && (
                <small>The current visit is {fullDate(scheduledAt)}.</small>
              )}
            </div>
          </div>
        ) : slots.length === 0 ? (
          <div className="blocked-state">
            <Info size={21} />
            <div>
              <strong>No alternative times are available</strong>
              <span>Please keep the current appointment or try again later.</span>
            </div>
          </div>
        ) : (
          <>
            <p className="intro">
              Change the service, date, time or visit instructions below.
              We&apos;ll notify your professional and update the admin schedule
              automatically.
            </p>

            {serviceOptions.length > 0 && (
              <>
                <label className="field-label" htmlFor={`service-${id}`}>
                  Service
                </label>
                <div className="select-wrap">
                  <select
                    id={`service-${id}`}
                    value={selectedPackageId}
                    onChange={(event) => {
                      const nextId = event.target.value;
                      const next = serviceOptions.find(
                        (item) => item.id === nextId,
                      );
                      setSelectedPackageId(nextId);
                      setMessage(null);
                      void fetchSlots(
                        next?.durationMinutes ?? durationMinutes,
                        nextId === packageId ? scheduledAt : "",
                      );
                    }}
                  >
                    {serviceOptions.map((item) => {
                      const compatible =
                        item.id === packageId ||
                        (item.price === currentService?.price &&
                          item.serviceType === currentService?.serviceType);
                      return (
                        <option
                          key={item.id}
                          value={item.id}
                          disabled={!compatible}
                        >
                          {item.name} · £{item.price.toFixed(2)}
                          {!compatible ? " — new booking required" : ""}
                        </option>
                      );
                    })}
                  </select>
                </div>
                <p className="service-help">
                  Services with a different price or professional type need a
                  new secure booking so your payment and matching remain
                  correct.
                </p>
              </>
            )}

            <label className="field-label" htmlFor={`visit-notes-${id}`}>
              Visit instructions <small>(optional)</small>
            </label>
            <div className="note-wrap visit-notes">
              <textarea
                id={`visit-notes-${id}`}
                value={visitNotes}
                onChange={(event) =>
                  setVisitNotes(event.target.value.slice(0, 1000))
                }
                placeholder="Access details, rooms to focus on, pets or other useful information…"
                rows={3}
              />
              <small>{visitNotes.length}/1000</small>
            </div>

            <label className="field-label">Date and time</label>
            <div className="appointment-time">
              <AppointmentTimePicker
                slots={slots}
                value={selectedSlot || null}
                onChange={setSelectedSlot}
                durationMinutes={selectedDuration}
              />
            </div>

            <fieldset className="reason-fieldset">
              <legend>Reason for change</legend>
              <div>
                {RESCHEDULE_REASONS.map((item) => (
                  <label key={item}>
                    <input
                      type="radio"
                      name={`reschedule-reason-${id}`}
                      value={item}
                      checked={reason === item}
                      onChange={() => setReason(item)}
                    />
                    <span>{reason === item && <Check size={12} />}</span>
                    {item}
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="field-label" htmlFor={`note-${id}`}>
              Message to your professional <small>(optional)</small>
            </label>
            <div className="note-wrap">
              <textarea
                id={`note-${id}`}
                value={note}
                onChange={(event) => setNote(event.target.value.slice(0, 250))}
                placeholder="Add a short note about the change…"
                rows={3}
              />
              <small>{note.length}/250</small>
            </div>

            <div className="policy-note">
              <Info size={19} />
              <div>
                <strong>Everyone stays in sync automatically.</strong>
                <span>
                  {cutoff
                    ? `You can update this booking until ${label(cutoff)}.`
                    : "Your existing booking remains in place until you save."}
                </span>
              </div>
            </div>
            {message && <p className="form-error">{message}</p>}
          </>
        )}

        <footer className="dialog-actions">
          <button type="button" className="keep-time" onClick={closeDialog}>
            Keep booking
          </button>
          {slots && slots.length > 0 && (
            <button
              type="button"
              className="confirm-time"
              disabled={!selectedSlot || !reason || !changed || pending}
              onClick={confirmModification}
            >
              {pending ? "Saving changes…" : "Save booking changes"}
            </button>
          )}
        </footer>
        <p className="support-line">
          <ShieldCheck size={16} /> Need help? Contact support.
        </p>
      </section>
    </div>
  ) : null;

  return (
    <div className={`booking-tools ${triggerVariant}`}>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <button
          className="modify-trigger"
          style={triggerVariant === "link" ? { ...linkBtn, color: "#6D28D9" } : undefined}
          disabled={pending}
          onClick={() => void loadSlots()}
        >
          {triggerVariant === "header" && <CalendarDays size={18} />}
          {triggerLabel}
        </button>
        {showCancel && (
          <button
            style={{ ...linkBtn, color: "#B0384F" }}
            disabled={pending}
            onClick={() => {
              if (
                !window.confirm(
                  "Cancel this booking? Your card won't be charged.",
                )
              )
                return;
              start(async () => {
                await cancelBooking(id);
              });
            }}
          >
            {pending ? "Working…" : "Cancel booking"}
          </button>
        )}
      </div>

      {!open && message && (
        <p style={{ color: "#B0384F", fontSize: 13.5, margin: "10px 0 0" }}>
          {message}
        </p>
      )}

      {dialog && createPortal(dialog, document.body)}

      <style jsx>{`
        .booking-tools.card {
          width: 100%;
        }
        .modify-trigger.card,
        .card .modify-trigger {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          min-height: 38px;
          box-sizing: border-box;
          border: 1px solid var(--ob-purple);
          border-radius: 9px;
          padding: 8px 15px;
          background: var(--ob-surface);
          color: var(--ob-purple);
          font: inherit;
          font-size: 12.5px;
          font-weight: 900;
          white-space: nowrap;
          cursor: pointer;
        }
        .booking-tools.header .modify-trigger {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          min-height: 43px;
          box-sizing: border-box;
          border: 1.5px solid var(--ob-purple);
          border-radius: 10px;
          padding: 10px 15px;
          background: transparent;
          color: var(--ob-purple);
          font: inherit;
          font-size: 14px;
          font-weight: 900;
          white-space: nowrap;
          cursor: pointer;
        }
        .reschedule-backdrop {
          position: fixed;
          inset: 0;
          z-index: 10000;
          display: grid;
          place-items: center;
          padding: 20px;
          background: rgba(19, 26, 37, 0.58);
          backdrop-filter: blur(4px);
        }
        .reschedule-dialog {
          width: min(620px, 100%);
          max-height: calc(100vh - 40px);
          overflow-y: auto;
          border: 1px solid var(--ob-border);
          border-radius: 22px;
          background: var(--ob-surface);
          color: var(--ob-text);
          box-shadow: 0 28px 80px rgba(12, 18, 30, 0.3);
          font-family: "Nunito", system-ui, sans-serif;
        }
        .dialog-head {
          position: sticky;
          top: 0;
          z-index: 2;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 21px 26px;
          border-bottom: 1px solid var(--ob-border);
          background: var(--ob-surface);
        }
        .dialog-head h2 {
          margin: 0;
          font-size: 21px;
          font-weight: 900;
        }
        .dialog-head button {
          display: grid;
          place-items: center;
          padding: 5px;
          border: 0;
          background: transparent;
          color: var(--ob-muted);
          cursor: pointer;
        }
        .booking-summary {
          display: grid;
          grid-template-columns: 78px 1fr;
          gap: 18px;
          margin: 22px 26px;
          padding: 18px;
          border: 1px solid var(--ob-border);
          border-radius: 16px;
          background: color-mix(
            in srgb,
            var(--ob-purple) 4%,
            var(--ob-surface)
          );
        }
        .calendar-icon {
          display: grid;
          place-items: center;
          width: 74px;
          height: 74px;
          border-radius: 16px;
          color: var(--ob-purple);
          background: color-mix(
            in srgb,
            var(--ob-purple) 11%,
            var(--ob-surface)
          );
        }
        .booking-summary > div {
          display: grid;
          gap: 5px;
          min-width: 0;
        }
        .booking-summary strong {
          font-size: 16px;
          font-weight: 900;
        }
        .booking-summary b {
          color: var(--ob-muted);
          font-size: 13.5px;
        }
        .booking-summary span:not(.calendar-icon) {
          display: flex;
          align-items: center;
          gap: 7px;
          color: var(--ob-text);
          font-size: 13px;
          overflow-wrap: anywhere;
        }
        .intro,
        .field-label,
        .select-wrap,
        .appointment-time,
        .reason-fieldset,
        .note-wrap,
        .policy-note,
        .form-error,
        .loading-state,
        .blocked-state {
          margin-left: 26px;
          margin-right: 26px;
        }
        .intro {
          margin-top: 0;
          margin-bottom: 18px;
          color: var(--ob-muted);
          font-size: 13.5px;
          line-height: 1.5;
        }
        .service-help {
          margin: -9px 26px 18px;
          color: var(--ob-muted);
          font-size: 11.5px;
          line-height: 1.45;
        }
        .field-label,
        .reason-fieldset legend {
          display: block;
          margin-bottom: 8px;
          color: var(--ob-text);
          font-size: 13.5px;
          font-weight: 900;
        }
        .field-label small {
          color: var(--ob-muted);
          font-weight: 700;
        }
        .select-wrap {
          display: flex;
          align-items: center;
          gap: 9px;
          margin-bottom: 18px;
          padding: 0 13px;
          border: 1.5px solid var(--ob-border);
          border-radius: 11px;
          color: var(--ob-muted);
        }
        .select-wrap select {
          width: 100%;
          padding: 12px 0;
          border: 0;
          outline: 0;
          background: transparent;
          color: var(--ob-text);
          font: inherit;
          font-size: 14px;
          font-weight: 800;
        }
        .appointment-time {
          margin-bottom: 20px;
        }
        .reason-fieldset {
          padding: 0;
          border: 0;
          margin-bottom: 19px;
        }
        .reason-fieldset > div {
          display: flex;
          align-items: center;
          gap: 14px 20px;
          flex-wrap: wrap;
        }
        .reason-fieldset label {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          font-size: 13px;
          cursor: pointer;
        }
        .reason-fieldset input {
          position: absolute;
          opacity: 0;
          pointer-events: none;
        }
        .reason-fieldset label > span {
          display: grid;
          place-items: center;
          width: 17px;
          height: 17px;
          border: 1.5px solid var(--ob-muted);
          border-radius: 999px;
          color: white;
        }
        .reason-fieldset input:checked + span {
          border-color: var(--ob-purple);
          background: var(--ob-purple);
        }
        .note-wrap {
          position: relative;
          margin-bottom: 17px;
        }
        .note-wrap textarea {
          width: 100%;
          box-sizing: border-box;
          resize: vertical;
          padding: 12px 13px 25px;
          border: 1.5px solid var(--ob-border);
          border-radius: 11px;
          outline: 0;
          background: var(--ob-surface);
          color: var(--ob-text);
          font: inherit;
          font-size: 14px;
        }
        .note-wrap textarea:focus {
          border-color: var(--ob-purple);
        }
        .note-wrap small {
          position: absolute;
          right: 11px;
          bottom: 8px;
          color: var(--ob-muted);
          font-size: 11px;
        }
        .policy-note,
        .blocked-state {
          display: flex;
          align-items: flex-start;
          gap: 11px;
          padding: 13px 14px;
          border-radius: 12px;
          color: var(--ob-purple);
          background: color-mix(
            in srgb,
            var(--ob-purple) 9%,
            var(--ob-surface)
          );
        }
        .policy-note div,
        .blocked-state div {
          display: grid;
          gap: 2px;
        }
        .policy-note strong,
        .blocked-state strong {
          font-size: 13.5px;
        }
        .policy-note span,
        .blocked-state span,
        .blocked-state small {
          color: var(--ob-muted);
          font-size: 12.5px;
          line-height: 1.45;
        }
        .blocked-state {
          margin-top: 22px;
          margin-bottom: 22px;
          color: #b0384f;
          background: color-mix(in srgb, #b0384f 9%, var(--ob-surface));
        }
        .loading-state {
          min-height: 150px;
          display: grid;
          place-items: center;
          color: var(--ob-muted);
          font-size: 14px;
          font-weight: 800;
        }
        .form-error {
          color: #b0384f;
          font-size: 13px;
          font-weight: 800;
        }
        .dialog-actions {
          display: grid;
          grid-template-columns: 1fr 1.35fr;
          gap: 12px;
          margin-top: 18px;
          padding: 18px 26px;
          border-top: 1px solid var(--ob-border);
        }
        .dialog-actions button {
          min-height: 47px;
          border-radius: 10px;
          font: inherit;
          font-size: 14px;
          font-weight: 900;
          cursor: pointer;
        }
        .keep-time {
          border: 1.5px solid var(--ob-purple);
          background: transparent;
          color: var(--ob-purple);
        }
        .confirm-time {
          border: 0;
          background: linear-gradient(100deg, #f5a623, #c86fc9 52%, #6d28d9);
          color: white;
          box-shadow: 0 9px 22px
            color-mix(in srgb, var(--ob-purple) 28%, transparent);
        }
        .confirm-time:disabled {
          cursor: not-allowed;
          opacity: 0.45;
          box-shadow: none;
        }
        .support-line {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          margin: 0;
          padding: 0 20px 18px;
          color: var(--ob-muted);
          font-size: 12.5px;
          font-weight: 800;
        }
        @media (max-width: 640px) {
          .reschedule-backdrop {
            align-items: end;
            padding: 0;
          }
          .reschedule-dialog {
            width: 100%;
            max-height: 94vh;
            border-radius: 22px 22px 0 0;
          }
          .dialog-head {
            padding: 18px;
          }
          .booking-summary,
          .intro,
          .field-label,
          .select-wrap,
          .appointment-time,
          .reason-fieldset,
          .note-wrap,
          .policy-note,
          .form-error,
          .loading-state,
          .blocked-state {
            margin-left: 18px;
            margin-right: 18px;
          }
          .service-help {
            margin-left: 18px;
            margin-right: 18px;
          }
          .booking-summary {
            grid-template-columns: 54px 1fr;
            padding: 14px;
          }
          .calendar-icon {
            width: 52px;
            height: 52px;
          }
          .dialog-actions {
            grid-template-columns: 1fr;
            padding: 16px 18px;
          }
        }
      `}</style>
    </div>
  );
}

export function RateBooking({
  id,
  existing,
}: {
  id: string;
  existing?: { rating: number; comment: string | null } | null;
}) {
  const [pending, start] = useTransition();
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState("");
  const [open, setOpen] = useState(false);

  if (existing) {
    return (
      <p style={{ marginTop: 12, marginBottom: 0, fontSize: 14 }}>
        <span style={{ color: "#6D28D9" }}>
          {"★".repeat(existing.rating)}
          {"☆".repeat(5 - existing.rating)}
        </span>{" "}
        <span style={{ color: "#7A828C" }}>
          {existing.comment ? `“${existing.comment}”` : "Thanks for rating."}
        </span>
      </p>
    );
  }

  if (!open) {
    return (
      <button
        style={{ ...linkBtn, color: "#6D28D9", marginTop: 12 }}
        onClick={() => setOpen(true)}
      >
        Rate this visit
      </button>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
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
              fontSize: 24,
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
        placeholder="Anything you'd like to add? (optional)"
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "10px 12px",
          border: "1.5px solid #E5E7EA",
          borderRadius: 10,
          font: "inherit",
          fontSize: 14,
          marginBottom: 10,
          resize: "vertical",
        }}
      />
      <button
        disabled={pending || stars === 0}
        onClick={() => start(() => rateBooking(id, stars, comment))}
        style={{
          background: "#16202A",
          color: "#FFFFFF",
          border: "none",
          borderRadius: 999,
          padding: "9px 20px",
          font: "inherit",
          fontSize: 14,
          fontWeight: 600,
          cursor: pending || stars === 0 ? "not-allowed" : "pointer",
          opacity: pending || stars === 0 ? 0.6 : 1,
        }}
      >
        {pending ? "Sending…" : "Submit rating"}
      </button>
    </div>
  );
}

// Tip your provider after a completed visit.
export function TipBooking({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function tip(amount: number) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/tip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId: id, amount }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      throw new Error(data.error || "Couldn't start the tip");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Tip failed");
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        style={{ ...linkBtn, color: "#6D28D9", marginTop: 10 }}
        onClick={() => setOpen(true)}
      >
        Add a tip
      </button>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      <p style={{ margin: "0 0 8px", fontSize: 13.5, color: "#7A828C" }}>
        Tips go entirely to your provider — we take nothing.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {[3, 5, 10].map((n) => (
          <button
            key={n}
            disabled={busy}
            onClick={() => tip(n)}
            style={{
              background: "#FFFFFF",
              border: "1.5px solid #EDEFF1",
              borderRadius: 999,
              padding: "9px 18px",
              font: "inherit",
              fontSize: 14,
              fontWeight: 600,
              color: "#16202A",
              cursor: busy ? "wait" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            £{n}
          </button>
        ))}
        <button
          style={{ ...linkBtn, color: "#7A828C" }}
          onClick={() => setOpen(false)}
        >
          Not now
        </button>
      </div>
      {err && (
        <p
          style={{
            background: "#FFE6EA",
            color: "#B0384F",
            padding: "10px 12px",
            borderRadius: 10,
            fontSize: 13.5,
            marginTop: 10,
          }}
        >
          {err}
        </p>
      )}
    </div>
  );
}

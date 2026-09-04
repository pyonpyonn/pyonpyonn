"use client";

import { useState, useTransition } from "react";
import { adminRescheduleBooking } from "../management-actions";
import AppointmentTimePicker from "@/components/AppointmentTimePicker";

export default function BookingScheduleControl({
  bookingId,
  scheduledAt,
  postcode,
  durationMinutes,
}: {
  bookingId: string;
  scheduledAt: string;
  postcode: string | null;
  durationMinutes: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [slots, setSlots] = useState<string[] | null>(null);
  const [slot, setSlot] = useState(scheduledAt);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="control">
      <button
        type="button"
        className="open"
        onClick={async () => {
          const next = !open;
          setOpen(next);
          if (next && slots === null) {
            const response = await fetch(
              `/api/slots?postcode=${encodeURIComponent(
                postcode ?? "",
              )}&duration=${encodeURIComponent(
                String(durationMinutes ?? 120),
              )}`,
            );
            const data = await response.json();
            setSlots(data.slots ?? []);
          }
        }}
      >
        {open ? "Close" : "Change schedule"}
      </button>
      {open && (
        <div className="editor">
          {slots === null ? (
            <p className="empty">Loading appointment times…</p>
          ) : slots.length ? (
            <AppointmentTimePicker
              slots={slots}
              value={slots.includes(slot) ? slot : null}
              onChange={setSlot}
              durationMinutes={durationMinutes}
            />
          ) : (
            <p className="empty">No permitted times found for this address.</p>
          )}
          <label>
            Reason for the audit record
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Client called support to move the visit"
              maxLength={220}
            />
          </label>
          <button
            type="button"
            className="save"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                if (!slot) {
                  setMessage("Choose a new date and time.");
                  return;
                }
                const result = await adminRescheduleBooking(
                  bookingId,
                  slot,
                  reason,
                );
                setMessage(result.message);
                if (result.ok) setOpen(false);
              })
            }
          >
            {pending ? "Saving…" : "Save audited change"}
          </button>
        </div>
      )}
      {message && <span className="message">{message}</span>}

      <style jsx>{`
        .control {
          position: relative;
          display: grid;
          justify-items: end;
          gap: 7px;
        }
        button {
          border-radius: 9px;
          padding: 8px 11px;
          font: inherit;
          font-size: 12px;
          font-weight: 850;
          cursor: pointer;
        }
        .open {
          border: 1px solid #d8c8f5;
          background: #fff;
          color: #6d28d9;
        }
        .editor {
          position: absolute;
          z-index: 30;
          top: 42px;
          right: 0;
          width: min(350px, calc(100vw - 36px));
          box-sizing: border-box;
          border: 1px solid #e5e7eb;
          border-radius: 14px;
          padding: 14px;
          background: #fff;
          box-shadow: 0 16px 40px rgba(22, 32, 42, 0.18);
        }
        label {
          display: block;
          margin-bottom: 10px;
          color: #59616d;
          font-size: 11.5px;
          font-weight: 800;
        }
        input {
          display: block;
          width: 100%;
          box-sizing: border-box;
          margin-top: 5px;
          border: 1px solid #dfe3e8;
          border-radius: 9px;
          padding: 9px 10px;
          font: inherit;
          font-size: 13px;
        }
        .save {
          width: 100%;
          border: 0;
          background: #16202a;
          color: #fff;
        }
        .empty {
          margin: 0 0 12px;
          color: #7a828c;
          font-size: 12.5px;
        }
        .message {
          max-width: 240px;
          color: #4b5563;
          font-size: 11px;
          text-align: right;
        }
        @media (max-width: 640px) {
          .control {
            justify-items: stretch;
          }
          .editor {
            position: fixed;
            top: 50%;
            left: 16px;
            right: 16px;
            width: auto;
            transform: translateY(-50%);
          }
        }
      `}</style>
    </div>
  );
}

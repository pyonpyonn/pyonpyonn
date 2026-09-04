"use client";

import { useEffect, useState, useTransition } from "react";
import { reportProviderNoShow } from "./exception-actions";

const PURPLE = "#6D28D9";
const GRACE_MS = 15 * 60_000;

export default function ReportNoShow({
  bookingId,
  scheduledAt,
  status,
  hasArrived,
}: {
  bookingId: string;
  scheduledAt: string;
  status: string;
  hasArrived: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [now, setNow] = useState(() => Date.now());
  const [pending, startTransition] = useTransition();

  const reportFrom = new Date(scheduledAt).getTime() + GRACE_MS;

  useEffect(() => {
    if (now >= reportFrom) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(reportFrom - now + 250, 2_147_000_000),
    );
    return () => window.clearTimeout(timer);
  }, [now, reportFrom]);

  if (status !== "scheduled" || hasArrived || now < reportFrom) return null;

  return (
    <div className="wrap">
      {!open ? (
        <button className="quiet" onClick={() => setOpen(true)}>
          My provider hasn&apos;t arrived
        </button>
      ) : (
        <div className="panel">
          <strong className="heading">Nobody turned up?</strong>
          <p className="copy">
            Tell us what happened. Payment will be paused while a person reviews
            both sides and decides the next step.
          </p>
          <textarea
            rows={2}
            value={reason}
            maxLength={1000}
            onChange={(event) => setReason(event.target.value)}
            placeholder="For example: I waited 20 minutes and received no message"
          />
          <div className="row">
            <button
              className="go"
              disabled={pending || !reason.trim()}
              onClick={() =>
                startTransition(async () => {
                  const result = await reportProviderNoShow(bookingId, reason);
                  setMessage({ ok: result.ok, text: result.message });
                  if (result.ok) {
                    setOpen(false);
                    setReason("");
                  }
                })
              }
            >
              {pending ? "Reporting…" : "Report this"}
            </button>
            <button className="cancel" onClick={() => setOpen(false)}>
              Not yet
            </button>
          </div>
        </div>
      )}

      {message && (
        <p className={message.ok ? "flash ok" : "flash no"}>{message.text}</p>
      )}

      <style jsx>{`
        .wrap {
          margin-top: 12px;
        }
        .quiet {
          background: none;
          border: none;
          padding: 4px 0;
          font: inherit;
          font-size: 13.5px;
          font-weight: 800;
          color: #b0384f;
          text-decoration: underline;
          cursor: pointer;
        }
        .panel {
          background: #fff8f9;
          border: 2px solid #f3cbd4;
          border-radius: 16px;
          padding: 15px 17px;
        }
        .heading {
          display: block;
          font-size: 15.5px;
          font-weight: 900;
          color: #b0384f;
          margin-bottom: 5px;
        }
        .copy {
          font-size: 13.5px;
          font-weight: 600;
          line-height: 1.55;
          color: #4b5563;
          margin: 0 0 10px;
        }
        textarea {
          width: 100%;
          box-sizing: border-box;
          border: 2px solid #edeff1;
          border-radius: 12px;
          padding: 10px 12px;
          font: inherit;
          font-size: 16px;
          font-weight: 600;
          color: #16202a;
          resize: vertical;
          margin-bottom: 10px;
        }
        textarea:focus-visible {
          outline: none;
          border-color: ${PURPLE};
        }
        .row {
          display: flex;
          gap: 8px;
        }
        .go {
          flex: 1;
          background: #16202a;
          color: #fff;
          border: none;
          border-radius: 999px;
          padding: 11px;
          font: inherit;
          font-size: 14px;
          font-weight: 900;
          cursor: pointer;
        }
        .go:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .cancel {
          background: #fff;
          border: 2px solid #edeff1;
          border-radius: 999px;
          padding: 11px 18px;
          font: inherit;
          font-size: 14px;
          font-weight: 800;
          color: #16202a;
          cursor: pointer;
        }
        .flash {
          margin: 10px 0 0;
          padding: 10px 13px;
          border-radius: 11px;
          font-size: 13.5px;
          font-weight: 700;
        }
        .flash.ok {
          background: #e4f6ec;
          color: #137b4e;
        }
        .flash.no {
          background: #ffe6ea;
          color: #b0384f;
        }
      `}</style>
    </div>
  );
}

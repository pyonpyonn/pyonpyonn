"use client";

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { ClockAlert, Info, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

const QUICK_OPTIONS = [10, 20, 30, 40, 50];

function validDelay(value: number | null) {
  if (value === null) return 20;
  return Math.min(50, Math.max(10, Math.round(value / 5) * 5));
}

export default function ReportDelay({
  bookingId,
  currentMinutes = null,
  compact = false,
}: {
  bookingId: string;
  currentMinutes?: number | null;
  compact?: boolean;
}) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(validDelay(currentMinutes));
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const openFromChat = (event: Event) => {
      const detail = (event as CustomEvent<{ bookingId?: string }>).detail;
      if (detail?.bookingId !== bookingId) return;
      setMessage(null);
      setSelected(validDelay(currentMinutes));
      setOpen(true);
    };
    window.addEventListener("opulence:report-delay", openFromChat);
    return () =>
      window.removeEventListener("opulence:report-delay", openFromChat);
  }, [bookingId, currentMinutes]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", close);
    };
  }, [currentMinutes, open, pending]);

  function submit(minutes: number) {
    startTransition(async () => {
      setMessage(null);
      const supabase = createClient();
      const { error } = await supabase.rpc("report_provider_delay", {
        p_booking_id: bookingId,
        p_delay_minutes: minutes,
      });

      if (error) {
        setMessage(error.message);
        return;
      }

      setOpen(false);
      setMessage(
        minutes === 0
          ? "Customer notified that you’re back on schedule."
          : `Customer notified: about ${minutes} minutes late.`,
      );
      window.dispatchEvent(new Event("opulence:refresh"));
      router.refresh();
    });
  }

  const dialog =
    mounted && open
      ? createPortal(
          <div
            className="delay-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !pending) {
                setOpen(false);
              }
            }}
          >
            <section
              className="delay-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby={`delay-title-${bookingId}`}
            >
              <header className="delay-head">
                <span className="delay-icon">
                  <ClockAlert size={25} />
                </span>
                <div>
                  <h2 id={`delay-title-${bookingId}`}>Update your arrival</h2>
                  <p>
                    Choose how late you expect to be. The client is notified
                    immediately and the update appears in Messages.
                  </p>
                </div>
                <button
                  type="button"
                  className="close"
                  onClick={() => setOpen(false)}
                  aria-label="Close arrival update"
                  disabled={pending}
                >
                  <X size={20} />
                </button>
              </header>

              <div className="delay-value">
                <small>Expected delay</small>
                <strong>{selected} minutes</strong>
                <span>Updated arrival is shared with the client.</span>
              </div>

              <div className="slider-wrap">
                <input
                  type="range"
                  min="10"
                  max="50"
                  step="5"
                  value={selected}
                  onChange={(event) => setSelected(Number(event.target.value))}
                  aria-label="Expected delay in minutes"
                  aria-valuetext={`${selected} minutes late`}
                />
                <div className="slider-labels">
                  <span>10 min</span>
                  <span>50 min</span>
                </div>
              </div>

              <div className="quick-options" aria-label="Quick delay choices">
                {QUICK_OPTIONS.map((minutes) => (
                  <button
                    type="button"
                    key={minutes}
                    className={selected === minutes ? "selected" : ""}
                    onClick={() => setSelected(minutes)}
                  >
                    {minutes} min
                  </button>
                ))}
              </div>

              <div className="arrival-note">
                <Info size={18} />
                <span>
                  Arrival updates do not reschedule the booking. Use Messages
                  if the client needs more detail.
                </span>
              </div>

              {message && <p className="dialog-error">{message}</p>}

              <footer className="delay-actions">
                {currentMinutes ? (
                  <button
                    type="button"
                    className="on-time"
                    disabled={pending}
                    onClick={() => submit(0)}
                  >
                    Back on time
                  </button>
                ) : (
                  <button
                    type="button"
                    className="cancel"
                    disabled={pending}
                    onClick={() => setOpen(false)}
                  >
                    Cancel
                  </button>
                )}
                <button
                  type="button"
                  className="notify"
                  disabled={pending}
                  onClick={() => submit(selected)}
                >
                  {pending ? "Updating…" : `Notify client · ${selected} min`}
                </button>
              </footer>
            </section>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className={`delay-control ${compact ? "compact" : ""}`}>
      <button
        type="button"
        className={currentMinutes ? "delay-button active" : "delay-button"}
        onClick={() => {
          setMessage(null);
          setSelected(validDelay(currentMinutes));
          setOpen(true);
        }}
        aria-expanded={open}
      >
        <ClockAlert size={16} />
        {currentMinutes ? `${currentMinutes} min late` : "Running late?"}
      </button>

      {message && <span className="result">{message}</span>}
      {dialog}

      <style jsx>{`
        .delay-control {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
          font-family: "Nunito", system-ui, sans-serif;
        }
        .delay-button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          min-height: 40px;
          border: 1.5px solid #f2b84b;
          border-radius: 10px;
          padding: 9px 14px;
          background: #fffaf0;
          color: #945f00;
          font: inherit;
          font-size: 13.5px;
          font-weight: 900;
          cursor: pointer;
          white-space: nowrap;
        }
        .delay-button.active {
          border-color: #e5a321;
          background: #fff0c9;
        }
        .result {
          max-width: 220px;
          color: var(--ob-success-text);
          font-size: 11px;
          font-weight: 800;
          line-height: 1.25;
        }
        :global(.delay-backdrop) {
          position: fixed;
          inset: 0;
          z-index: 10040;
          display: grid;
          place-items: center;
          box-sizing: border-box;
          padding: 20px;
          background: rgba(15, 20, 30, 0.6);
          backdrop-filter: blur(5px);
        }
        :global(.delay-dialog) {
          width: min(560px, 100%);
          max-height: calc(100vh - 40px);
          overflow-y: auto;
          box-sizing: border-box;
          border: 1px solid var(--ob-border);
          border-radius: 24px;
          padding: 24px;
          background: var(--ob-surface);
          color: var(--ob-text);
          box-shadow: 0 28px 80px rgba(12, 18, 30, 0.32);
          font-family: "Nunito", system-ui, sans-serif;
        }
        :global(.delay-head) {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          align-items: start;
          gap: 13px;
        }
        :global(.delay-icon) {
          display: grid;
          place-items: center;
          width: 48px;
          height: 48px;
          border-radius: 15px;
          background: linear-gradient(135deg, #fff0c9, #f4ecfe);
          color: #945f00;
        }
        :global(.delay-head h2) {
          margin: 1px 0 3px;
          font-size: 21px;
          font-weight: 900;
          letter-spacing: -0.02em;
        }
        :global(.delay-head p) {
          margin: 0;
          color: var(--ob-muted);
          font-size: 13px;
          font-weight: 650;
          line-height: 1.45;
        }
        :global(.delay-head .close) {
          display: grid;
          place-items: center;
          width: 36px;
          height: 36px;
          border: 0;
          background: transparent;
          color: var(--ob-muted);
          cursor: pointer;
        }
        :global(.delay-value) {
          display: grid;
          place-items: center;
          margin-top: 22px;
          padding: 20px;
          border: 1px solid #e3dced;
          border-radius: 18px;
          background: linear-gradient(135deg, #fff9e9, #f6efff);
          text-align: center;
        }
        :global(.delay-value small) {
          color: #8a778f;
          font-size: 10.5px;
          font-weight: 900;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        :global(.delay-value strong) {
          margin-top: 3px;
          color: var(--ob-text);
          font-size: 32px;
          font-weight: 900;
          letter-spacing: -0.03em;
        }
        :global(.delay-value span) {
          color: var(--ob-muted);
          font-size: 12px;
          font-weight: 700;
        }
        :global(.slider-wrap) {
          padding: 22px 4px 4px;
        }
        :global(.slider-wrap input) {
          width: 100%;
          height: 8px;
          margin: 0;
          border-radius: 999px;
          outline: 0;
          accent-color: #6d28d9;
          cursor: grab;
        }
        :global(.slider-wrap input:active) {
          cursor: grabbing;
        }
        :global(.slider-labels) {
          display: flex;
          justify-content: space-between;
          margin-top: 7px;
          color: var(--ob-muted);
          font-size: 11px;
          font-weight: 800;
        }
        :global(.quick-options) {
          display: grid;
          grid-template-columns: repeat(5, minmax(0, 1fr));
          gap: 7px;
          margin-top: 11px;
        }
        :global(.quick-options button) {
          min-height: 42px;
          border: 1.5px solid var(--ob-border);
          border-radius: 11px;
          background: var(--ob-surface-soft);
          color: var(--ob-text);
          font: inherit;
          font-size: 12px;
          font-weight: 850;
          cursor: pointer;
        }
        :global(.quick-options button.selected) {
          border-color: #6d28d9;
          background: #f4ecfe;
          color: #6d28d9;
          box-shadow: 0 0 0 2px color-mix(in srgb, #6d28d9 12%, transparent);
        }
        :global(.arrival-note) {
          display: flex;
          align-items: flex-start;
          gap: 9px;
          margin-top: 18px;
          padding: 12px 13px;
          border-radius: 12px;
          background: var(--ob-purple-soft);
          color: var(--ob-purple);
          font-size: 12.5px;
          font-weight: 750;
          line-height: 1.45;
        }
        :global(.arrival-note svg) {
          flex: 0 0 auto;
        }
        :global(.dialog-error) {
          margin: 12px 0 0;
          color: var(--ob-danger-text);
          font-size: 12.5px;
          font-weight: 800;
        }
        :global(.delay-actions) {
          display: grid;
          grid-template-columns: 0.8fr 1.35fr;
          gap: 10px;
          margin-top: 19px;
        }
        :global(.delay-actions button) {
          min-height: 47px;
          border-radius: 11px;
          padding: 11px 15px;
          font: inherit;
          font-size: 13.5px;
          font-weight: 900;
          cursor: pointer;
        }
        :global(.delay-actions .on-time),
        :global(.delay-actions .cancel) {
          border: 1.5px solid var(--ob-purple);
          background: transparent;
          color: var(--ob-purple);
        }
        :global(.delay-actions .notify) {
          border: 0;
          background: linear-gradient(100deg, #f5a623, #c86fc9 52%, #6d28d9);
          color: #fff;
          box-shadow: 0 9px 22px rgba(109, 40, 217, 0.22);
        }
        :global(.delay-actions button:disabled) {
          opacity: 0.55;
          cursor: wait;
        }
        @media (max-width: 560px) {
          :global(.delay-backdrop) {
            align-items: end;
            padding: 0;
          }
          :global(.delay-dialog) {
            width: 100%;
            max-height: 94vh;
            border-radius: 24px 24px 0 0;
            padding: 19px;
          }
          :global(.quick-options) {
            grid-template-columns: repeat(3, minmax(0, 1fr));
          }
          :global(.delay-actions) {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
}

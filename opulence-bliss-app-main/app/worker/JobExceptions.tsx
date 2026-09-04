"use client";

// SETUP: mkdir -p "app/worker" && code "app/worker/JobExceptions.tsx"
//
// Deliberately understated. These aren't buttons anyone should press by
// accident, but a provider standing outside a locked door needs to find them
// in one tap.

import { useEffect, useState, useTransition } from "react";
import { cannotAttend, reportClientUnavailable } from "./exception-actions";

const PURPLE = "#6D28D9";

type Result = { ok: boolean; message: string };

export default function JobExceptions({
  bookingId,
  status,
  scheduledAt,
  defaultOpen = null,
  showLauncher = true,
}: {
  bookingId: string;
  status: string;
  scheduledAt: string;
  defaultOpen?: null | "cant" | "noaccess";
  showLauncher?: boolean;
}) {
  const [open, setOpen] = useState<null | "cant" | "noaccess">(defaultOpen);
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pending, start] = useTransition();

  const scheduled = new Date(scheduledAt).getTime();
  const noAccessFrom = scheduled + 15 * 60_000;

  useEffect(() => {
    if (now >= noAccessFrom) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(noAccessFrom - now + 250, 2_147_000_000),
    );
    return () => window.clearTimeout(timer);
  }, [noAccessFrom, now]);

  // Dropping out only makes sense before you've started.
  const canWithdraw = status === "scheduled";
  const canReportAccess =
    (status === "scheduled" && now >= noAccessFrom) || status === "in_progress";

  if (!canWithdraw && !canReportAccess) return null;

  const hoursOut = (scheduled - now) / 3_600_000;
  const late = hoursOut < 24 && hoursOut > 0;

  function run(fn: () => Promise<Result>) {
    start(async () => {
      try {
        const r = await fn();
        setResult(r);
        if (r.ok) {
          setOpen(null);
          setReason("");
        }
      } catch (e) {
        setResult({
          ok: false,
          message: e instanceof Error ? e.message : "Something went wrong",
        });
      }
    });
  }

  function withGps(then: (gps: { lat: number; lng: number } | null) => void) {
    if (!navigator.geolocation) return then(null);
    navigator.geolocation.getCurrentPosition(
      (p) => then({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => then(null),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }

  return (
    <div className="wrap">
      {!open && showLauncher && (
        <button
          className="quiet"
          onClick={() => setOpen(canWithdraw ? "cant" : "noaccess")}
        >
          Something&apos;s wrong with this job
        </button>
      )}

      {open && (
        <div className="panel">
          <div className="tabs">
            {canWithdraw && (
              <button
                className={open === "cant" ? "tab on" : "tab"}
                onClick={() => setOpen("cant")}
              >
                I can&apos;t attend
              </button>
            )}
            {canReportAccess && (
              <button
                className={open === "noaccess" ? "tab on" : "tab"}
                onClick={() => setOpen("noaccess")}
              >
                Nobody&apos;s home
              </button>
            )}
            {showLauncher && (
              <button
                className="tab close"
                onClick={() => {
                  setOpen(null);
                  setResult(null);
                }}
              >
                ×
              </button>
            )}
          </div>

          {open === "cant" && (
            <>
              <p className="says">
                {hoursOut > 0
                  ? "We'll take this off your schedule and offer it to other providers. The client's slot and existing card hold stay in place."
                  : "This visit is already due. We'll remove it from your schedule and send it to the resolution team."}
              </p>
              {late && (
                <p className="warn">
                  This visit is in under 24 hours. Late withdrawals are recorded
                  and affect the jobs you&apos;re offered.
                </p>
              )}
              <textarea
                rows={2}
                value={reason}
                maxLength={1000}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why can't you make it? The client won't see this."
              />
              <button
                className="go"
                disabled={pending || !reason.trim()}
                onClick={() => run(() => cannotAttend(bookingId, reason))}
              >
                {pending ? "Removing…" : "Remove me from this job"}
              </button>
            </>
          )}

          {open === "noaccess" && (
            <>
              <p className="says">
                Use this if you&apos;ve arrived and can&apos;t get in. We check
                your location, pause payment and payout, and a person decides
                what happens next — so don&apos;t just leave.
              </p>
              <textarea
                rows={2}
                value={reason}
                maxLength={1000}
                onChange={(e) => setReason(e.target.value)}
                placeholder="What happened? e.g. rang the bell and called twice, no answer after 15 minutes"
              />
              <button
                className="go"
                disabled={pending || !reason.trim()}
                onClick={() =>
                  withGps((gps) =>
                    run(() => reportClientUnavailable(bookingId, reason, gps)),
                  )
                }
              >
                {pending ? "Reporting…" : "Report no access"}
              </button>
            </>
          )}
        </div>
      )}

      {result && (
        <p className={result.ok ? "flash ok" : "flash no"}>{result.message}</p>
      )}

      <style jsx>{`
        .wrap {
          margin-top: 14px;
        }
        .quiet {
          background: none;
          border: none;
          padding: 4px 0;
          font: inherit;
          font-size: 13.5px;
          font-weight: 700;
          color: #a9afb7;
          text-decoration: underline;
          cursor: pointer;
        }
        .quiet:hover {
          color: ${PURPLE};
        }
        .panel {
          background: #fbfaff;
          border: 2px solid #ece5fb;
          border-radius: 16px;
          padding: 14px 16px;
          margin-top: 8px;
        }
        .tabs {
          display: flex;
          gap: 7px;
          margin-bottom: 12px;
        }
        .tab {
          background: #fff;
          border: 2px solid #edeff1;
          border-radius: 999px;
          padding: 8px 14px;
          font: inherit;
          font-size: 13px;
          font-weight: 800;
          color: #16202a;
          cursor: pointer;
        }
        .tab.on {
          background: ${PURPLE};
          border-color: ${PURPLE};
          color: #fff;
        }
        .tab.close {
          margin-left: auto;
          padding: 8px 12px;
          font-size: 15px;
        }
        .says {
          font-size: 13.5px;
          font-weight: 600;
          line-height: 1.55;
          color: #4b5563;
          margin: 0 0 10px;
        }
        .warn {
          background: #fff8e8;
          border: 1.5px solid #ffe09e;
          color: #8a5a00;
          border-radius: 10px;
          padding: 10px 12px;
          font-size: 13px;
          font-weight: 700;
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
        .go {
          width: 100%;
          background: #16202a;
          color: #fff;
          border: none;
          border-radius: 999px;
          padding: 12px;
          font: inherit;
          font-size: 14.5px;
          font-weight: 900;
          cursor: pointer;
        }
        .go:disabled {
          opacity: 0.45;
          cursor: not-allowed;
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

"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();
const POLL_MS = 4_000;

type ActiveCode = {
  active: true;
  code: string;
  expires_at: string;
  requested_at: string;
};

type CodeResult = ActiveCode | { active: false };

export default function CheckInCodePanel({
  bookingId,
  providerName,
  compact = false,
}: {
  bookingId: string;
  providerName?: string | null;
  compact?: boolean;
}) {
  const [challenge, setChallenge] = useState<ActiveCode | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("customer_checkin_code", {
      p_booking_id: bookingId,
    });
    if (error) {
      setChallenge(null);
      return;
    }
    const result = data as CodeResult | null;
    setChallenge(result?.active ? result : null);
  }, [bookingId]);

  useEffect(() => {
    void load();
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    const refresh = () => void load();
    window.addEventListener("focus", refresh);
    window.addEventListener("opulence:notification", refresh);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("opulence:notification", refresh);
    };
  }, [load]);

  if (!challenge) return null;

  const seconds = Math.max(
    0,
    Math.ceil((new Date(challenge.expires_at).getTime() - now) / 1_000),
  );
  if (seconds === 0) return null;
  const remaining = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const firstName = providerName?.trim().split(/\s+/)[0] ?? "your provider";

  return (
    <section className={`checkin-code ${compact ? "compact" : ""}`}>
      <span className="key-icon" aria-hidden="true">
        <KeyRound size={compact ? 20 : 24} />
      </span>
      <div className="copy">
        <strong>{firstName} is ready to check in</strong>
        <p>
          Give this code to {firstName} only when they are with you. It expires
          in {remaining}.
        </p>
      </div>
      <button
        type="button"
        className="code"
        aria-label={`Copy check-in code ${challenge.code}`}
        onClick={async () => {
          await navigator.clipboard?.writeText(challenge.code);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_500);
        }}
      >
        <span>{challenge.code}</span>
        {copied ? <Check size={17} /> : <Copy size={17} />}
      </button>
      {!compact && (
        <small>
          <ShieldCheck size={14} /> The job cannot start until this code is
          confirmed.
        </small>
      )}

      <style jsx>{`
        .checkin-code {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          align-items: center;
          gap: 13px;
          margin: 14px 0;
          border: 1.5px solid
            color-mix(in srgb, var(--ob-purple) 35%, var(--ob-border));
          border-radius: 15px;
          padding: 14px 16px;
          background: linear-gradient(
            100deg,
            var(--ob-purple-soft),
            var(--ob-surface)
          );
          color: var(--ob-text);
        }
        .key-icon {
          display: grid;
          width: 42px;
          height: 42px;
          place-items: center;
          border-radius: 12px;
          background: var(--ob-purple);
          color: #fff;
        }
        .copy {
          min-width: 0;
        }
        .copy strong {
          display: block;
          font-size: 15px;
          font-weight: 900;
        }
        .copy p {
          margin: 3px 0 0;
          color: var(--ob-muted);
          font-size: 12.5px;
          font-weight: 700;
          line-height: 1.4;
        }
        .code {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 9px;
          min-width: 156px;
          border: 1px solid
            color-mix(in srgb, var(--ob-purple) 45%, var(--ob-border));
          border-radius: 12px;
          padding: 10px 13px;
          background: var(--ob-surface-raised);
          color: var(--ob-purple);
          cursor: pointer;
        }
        .code span {
          font-size: 23px;
          font-weight: 950;
          letter-spacing: 0.16em;
        }
        small {
          grid-column: 2 / -1;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          color: var(--ob-muted);
          font-size: 11.5px;
          font-weight: 700;
        }
        .compact {
          margin: 0;
          border-width: 0;
          border-top-width: 1px;
          border-radius: 0;
          padding: 11px 14px;
        }
        .compact .key-icon {
          width: 35px;
          height: 35px;
          border-radius: 10px;
        }
        .compact .code {
          min-width: 138px;
          padding: 8px 10px;
        }
        .compact .code span {
          font-size: 19px;
        }
        @media (max-width: 640px) {
          .checkin-code {
            grid-template-columns: auto minmax(0, 1fr);
          }
          .code {
            grid-column: 1 / -1;
            width: 100%;
          }
          small {
            grid-column: 1 / -1;
          }
        }
      `}</style>
    </section>
  );
}

"use client";

// SETUP: mkdir -p "app/admin/review" && code "app/admin/review/DeskControls.tsx"
//
// Every button here is an explicit decision. Each one demands a reason, and the
// reason ends up in an immutable event or on the case record.

import { useState, useTransition } from "react";
import {
  ackFinding,
  closeFinding,
  takeCase,
  closeCase,
  retryCapture,
  retryTransfer,
  releasePayoutHold,
  issueRefund,
  closePreResetTransferFindings,
} from "../resolution-actions";

const GRAD = "linear-gradient(100deg,#F5C542,#C86FC9 55%,#7B2FF7)";
const PURPLE = "#6D28D9";

type Result = { ok: boolean; message: string };

export function PrototypeFindingsCleanup({ count }: { count: number }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);

  return (
    <div
      style={{
        margin: "0 0 18px",
        padding: "14px 16px",
        border: "1.5px solid #E5D9FA",
        borderRadius: 14,
        background: "#F8F4FF",
      }}
    >
      <strong style={{ display: "block", fontSize: 14.5, color: "#43217A" }}>
        Historical prototype transfers detected
      </strong>
      <p
        style={{
          margin: "4px 0 10px",
          color: "#6F6480",
          fontSize: 13,
          lineHeight: 1.45,
        }}
      >
        These may be Stripe test transfers retained after local prototype data
        was reset. This checks Stripe dates and dismisses only transfers proved
        to predate the latest reset; newer findings remain untouched.
      </p>
      <button
        type="button"
        disabled={pending || count === 0}
        onClick={() =>
          start(async () => setResult(await closePreResetTransferFindings()))
        }
        style={{
          border: "1.5px solid #6D28D9",
          borderRadius: 999,
          padding: "9px 16px",
          background: "#fff",
          color: "#6D28D9",
          font: "inherit",
          fontSize: 13,
          fontWeight: 900,
          cursor: pending ? "wait" : "pointer",
          opacity: pending ? 0.6 : 1,
        }}
      >
        {pending ? "Checking Stripe…" : `Clear pre-reset test findings (${count})`}
      </button>
      {result && (
        <p
          style={{
            margin: "10px 0 0",
            color: result.ok ? "#137B4E" : "#B0384F",
            fontSize: 13,
            fontWeight: 800,
          }}
        >
          {result.message}
        </p>
      )}
    </div>
  );
}

export default function DeskControls({
  kind,
  findingId,
  caseId,
  paymentId,
  payoutId,
  paymentStatus,
  payoutStatus,
  grossAmount,
  assigned,
  caseStatus,
  resolutionAmount,
  refundRemaining,
}: {
  kind: "finding" | "case";
  findingId?: string | null;
  caseId?: string | null;
  paymentId?: string | null;
  payoutId?: string | null;
  paymentStatus?: string | null;
  payoutStatus?: string | null;
  grossAmount?: number | null;
  assigned?: boolean;
  caseStatus?: string | null;
  resolutionAmount?: number | null;
  refundRemaining?: number | null;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  function run(fn: () => Promise<Result>) {
    start(async () => {
      try {
        setResult(await fn());
      } catch (e) {
        setResult({
          ok: false,
          message: e instanceof Error ? e.message : "Something went wrong",
        });
      }
    });
  }

  const needReason = () => {
    if (reason.trim()) return true;
    setResult({ ok: false, message: "Type a reason first." });
    return false;
  };

  const canCapture =
    !!paymentId && ["authorised", "capture_failed"].includes(paymentStatus ?? "");
  const canTransfer =
    !!payoutId && ["pending", "failed"].includes(payoutStatus ?? "");
  const canRelease = !!payoutId && payoutStatus === "held";
  const canRefund =
    !!caseId &&
    caseStatus === "resolved" &&
    Number(refundRemaining ?? 0) > 0 &&
    ["succeeded", "partially_refunded"].includes(paymentStatus ?? "");

  return (
    <div className="wrap">
      {/* ---- reason: required by every action ---- */}
      <input
        className="reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason — recorded against your account"
        aria-label="Reason"
      />

      <div className="row">
        {kind === "finding" && findingId && (
          <>
            <button
              className="ghost"
              disabled={pending}
              onClick={() => run(() => ackFinding(findingId))}
            >
              Acknowledge
            </button>
            <button
              className="ghost"
              disabled={pending}
              onClick={() =>
                needReason() && run(() => closeFinding(findingId, reason, false))
              }
            >
              Close
            </button>
            <button
              className="ghost"
              disabled={pending}
              onClick={() =>
                needReason() && run(() => closeFinding(findingId, reason, true))
              }
            >
              False positive
            </button>
          </>
        )}

        {kind === "case" && caseId && caseStatus !== "resolved" && (
          <>
            {!assigned && (
              <button
                className="ghost"
                disabled={pending}
                onClick={() => run(() => takeCase(caseId))}
              >
                Take this
              </button>
            )}
            <button
              className="primary"
              disabled={pending}
              onClick={() => setOpen(open === "close" ? null : "close")}
            >
              Close case…
            </button>
          </>
        )}

        {/* ---- money: only offered when the state allows it ---- */}
        {canCapture && paymentId && (
          <button
            className="money"
            disabled={pending}
            onClick={() =>
              needReason() && run(() => retryCapture(paymentId, reason))
            }
          >
            Retry capture
          </button>
        )}

        {canTransfer && payoutId && (
          <button
            className="money"
            disabled={pending}
            onClick={() =>
              needReason() && run(() => retryTransfer(payoutId, reason))
            }
          >
            {payoutStatus === "failed" ? "Retry transfer" : "Send transfer"}
          </button>
        )}

        {canRelease && payoutId && (
          <button
            className="ghost"
            disabled={pending}
            onClick={() =>
              needReason() && run(() => releasePayoutHold(payoutId, reason))
            }
          >
            Lift hold
          </button>
        )}

        {canRefund && (
          <button
            className="money"
            disabled={pending}
            onClick={() => setOpen(open === "refund" ? null : "refund")}
          >
            Refund…
          </button>
        )}
      </div>

      {/* ---- close a case ---- */}
      {open === "close" && caseId && (
        <div className="panel">
          <p className="ph">Close this case</p>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Amount agreed (optional, £)"
            inputMode="decimal"
          />
          <p className="hint">
            This is the total refund approval. Recording it does not move
            money; the resolved case will remain here until it is paid.
          </p>
          <button
            className="primary wide"
            disabled={pending}
            onClick={() =>
              needReason() &&
              run(() =>
                closeCase(
                  caseId,
                  reason,
                  "",
                  amount.trim() ? Number(amount) : undefined
                )
              )
            }
          >
            {pending ? "Closing…" : "Close case"}
          </button>
        </div>
      )}

      {/* ---- refund ---- */}
      {open === "refund" && caseId && (
        <div className="panel">
          <p className="ph">
            Refund against this case
            {grossAmount ? ` — £${Number(grossAmount).toFixed(2)} was charged` : ""}
          </p>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={`Amount to refund (£${Number(
              refundRemaining ?? resolutionAmount ?? 0
            ).toFixed(2)} remaining)`}
            inputMode="decimal"
          />
          <p className="hint">
            £{Number(resolutionAmount ?? 0).toFixed(2)} was approved. A partial
            refund can be issued more than once; each gets its own operation key.
          </p>
          <button
            className="money wide"
            disabled={pending || !amount.trim()}
            onClick={() =>
              needReason() &&
              run(() => issueRefund(caseId, Number(amount), reason))
            }
          >
            {pending ? "Refunding…" : `Refund £${amount || "0"}`}
          </button>
        </div>
      )}

      {result && (
        <p className={result.ok ? "flash ok" : "flash no"}>{result.message}</p>
      )}

      <style jsx>{`
        .wrap {
          margin-top: 14px;
          padding-top: 14px;
          border-top: 1px solid #f1f2f4;
        }
        .reason {
          width: 100%;
          box-sizing: border-box;
          border: 2px solid #edeff1;
          border-radius: 12px;
          padding: 10px 13px;
          font: inherit;
          font-size: 14px;
          font-weight: 600;
          color: #16202a;
          margin-bottom: 10px;
        }
        .reason:focus-visible {
          outline: none;
          border-color: ${PURPLE};
        }
        .row {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        button {
          border-radius: 999px;
          padding: 9px 16px;
          font: inherit;
          font-size: 13.5px;
          font-weight: 800;
          cursor: pointer;
          border: 2px solid transparent;
        }
        button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .ghost {
          background: #fff;
          border-color: #edeff1;
          color: #16202a;
        }
        .ghost:hover:not(:disabled) {
          border-color: ${PURPLE};
          color: ${PURPLE};
        }
        .primary {
          background: #16202a;
          color: #fff;
        }
        .money {
          background: ${GRAD};
          color: #fff;
        }
        .wide {
          width: 100%;
          margin-top: 4px;
        }
        .panel {
          background: #fbfaff;
          border: 2px solid #ece5fb;
          border-radius: 14px;
          padding: 14px 16px;
          margin-top: 10px;
        }
        .ph {
          font-size: 13px;
          font-weight: 900;
          margin: 0 0 10px;
          color: #16202a;
        }
        .panel input {
          width: 100%;
          box-sizing: border-box;
          border: 2px solid #edeff1;
          border-radius: 10px;
          padding: 9px 12px;
          font: inherit;
          font-size: 14px;
          font-weight: 700;
          margin-bottom: 6px;
        }
        .panel input:focus-visible {
          outline: none;
          border-color: ${PURPLE};
        }
        .hint {
          font-size: 12px;
          font-weight: 600;
          color: #a9afb7;
          margin: 0 0 10px;
        }
        .flash {
          margin: 12px 0 0;
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

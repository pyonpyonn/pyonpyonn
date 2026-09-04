"use server";

// SETUP: mkdir -p "app/admin" && code "app/admin/resolution-actions.ts"
//
// Every action here is deliberate, admin-authenticated, and audited.
//
// Two clients on purpose:
//   ssr()   — the signed-in admin. Used for the transition RPCs, which derive
//             the actor from auth.uid() and refuse anyone who isn't an admin.
//   admin   — service role. Used for closed bookkeeping fields and the narrow
//             system-only readiness/case RPCs.
//
// Nothing here decides on its own that money should move. An operator does.

import { revalidatePath } from "next/cache";
import Stripe from "stripe";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient as ssr } from "@/lib/supabase/server";
import {
  claimMoneyOperation,
  maybeReleasePayout,
  systemFinaliseMoneyOperation,
  transitionPayment,
  transitionPayout,
} from "@/lib/bookingState";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const admin = createServiceClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type Result = { ok: boolean; message: string };

/** Everything below requires a signed-in admin. */
async function requireAdmin() {
  const s = await ssr();
  const {
    data: { user },
  } = await s.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data: me, error: profileError } = await s
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) throw new Error(profileError.message);
  if (me?.role !== "admin") throw new Error("Admins only");
  return { s, userId: user.id };
}

/** Locked bookkeeping helpers; direct writes to money_operations are revoked. */
async function opSucceeded(opId: string, stripeObjectId: string) {
  await systemFinaliseMoneyOperation(admin, opId, "succeeded", {
    stripeObjectId,
  });
}

async function opFailed(opId: string, message: string) {
  await systemFinaliseMoneyOperation(admin, opId, "failed", {
    error: message,
  });
}

/**
 * We asked Stripe to do something and cannot establish whether it happened.
 * Never guess. `ambiguous` blocks further attempts until a human resolves it.
 */
async function opAmbiguous(
  opId: string,
  message: string,
  stripeObjectId?: string
) {
  await systemFinaliseMoneyOperation(admin, opId, "ambiguous", {
    error: message,
    stripeObjectId,
  });
}

function refreshAdmin() {
  revalidatePath("/admin");
  revalidatePath("/admin/review");
}

/**
 * Close only transfer findings whose Stripe object predates the most recent
 * deliberate prototype reset. Each closure still goes through close_finding,
 * so the signed-in admin and the evidence-based reason are recorded.
 */
export async function closePreResetTransferFindings(): Promise<Result> {
  const { s } = await requireAdmin();
  const { data: resetValue, error: resetError } = await admin.rpc(
    "latest_prototype_reset_at",
  );
  if (resetError) return { ok: false, message: resetError.message };
  if (!resetValue) {
    return { ok: false, message: "No prototype reset has been recorded." };
  }

  const resetAt = new Date(resetValue as string);
  if (Number.isNaN(resetAt.getTime())) {
    return { ok: false, message: "The prototype reset date is invalid." };
  }

  const { data: findings, error: findingsError } = await s
    .from("reconciliation_findings")
    .select("id, stripe_object_id")
    .eq("finding_type", "stripe_transfer_without_local_payout")
    .in("status", ["open", "acknowledged"]);
  if (findingsError) return { ok: false, message: findingsError.message };

  let closed = 0;
  let kept = 0;
  for (const finding of findings ?? []) {
    if (!finding.stripe_object_id?.startsWith("tr_")) {
      kept++;
      continue;
    }

    try {
      const transfer = await stripe.transfers.retrieve(
        finding.stripe_object_id,
      );
      if (transfer.created * 1000 >= resetAt.getTime()) {
        kept++;
        continue;
      }

      const { error } = await s.rpc("close_finding", {
        p_finding_id: finding.id,
        p_outcome:
          `False positive: Stripe test transfer predates the deliberate ` +
          `prototype reset at ${resetAt.toISOString()}; local activity was ` +
          `removed by that reset.`,
        p_false_positive: true,
      });
      if (error) return { ok: false, message: error.message };
      closed++;
    } catch (error) {
      kept++;
      console.error(
        `Could not classify reconciliation finding ${finding.id}:`,
        error,
      );
    }
  }

  refreshAdmin();
  return {
    ok: true,
    message:
      closed > 0
        ? `Cleared ${closed} pre-reset test finding${closed === 1 ? "" : "s"}.` +
          (kept ? ` Kept ${kept} newer or unprovable finding${kept === 1 ? "" : "s"}.` : "")
        : "No findings were old enough to clear. Newer findings were kept.",
  };
}

/* ==========================================================================
 * 1. Retry a capture that failed
 * ========================================================================== */
export async function retryCapture(
  paymentId: string,
  reason: string
): Promise<Result> {
  const { s, userId } = await requireAdmin();

  if (!reason?.trim()) return { ok: false, message: "Give a reason." };

  const { data: pay, error: paymentError } = await s
    .from("payments")
    .select("id, booking_id, status, gross_amount, stripe_payment_ref")
    .eq("id", paymentId)
    .maybeSingle();

  if (paymentError) return { ok: false, message: paymentError.message };
  if (!pay) return { ok: false, message: "Payment not found." };
  if (!pay.booking_id)
    return { ok: false, message: "Payment is not attached to a booking." };
  if (!pay.stripe_payment_ref)
    return { ok: false, message: "No Stripe reference on this payment." };
  if (!["authorised", "capture_failed"].includes(pay.status))
    return { ok: false, message: `Nothing to capture — status is ${pay.status}.` };

  // Durable identity. The same logical capture, however many attempts.
  const key = `capture:booking:${pay.booking_id}`;
  let claim;
  try {
    claim = await claimMoneyOperation(admin, {
      operationKey: key,
      operationType: "capture",
      bookingId: pay.booking_id,
      amount: Number(pay.gross_amount),
      requestedBy: userId,
    });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not claim capture",
    };
  }
  if (!claim?.should_run)
    return {
      ok: false,
      message: `Not run: ${claim?.status}${
        claim?.message ? ` — ${claim.message}` : ""
      }`,
    };

  const opId = claim.id as string;

  try {
    await transitionPayment(s, paymentId, "capturing", { reason });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Transition failed";
    await opFailed(opId, message);
    return { ok: false, message };
  }

  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.capture(
      pay.stripe_payment_ref,
      { metadata: { operation_key: key, booking_id: pay.booking_id } },
      { idempotencyKey: key }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Capture failed";

    // A declined card is a definite failure. A timeout is not — we may have
    // charged the customer and not heard back.
    const definite =
      e instanceof Stripe.errors.StripeCardError ||
      e instanceof Stripe.errors.StripeInvalidRequestError;

    if (definite) {
      await opFailed(opId, msg);
      await transitionPayment(s, paymentId, "capture_failed", { reason: msg });
      await admin.rpc("open_review_case", {
        p_booking_id: pay.booking_id,
        p_category: "payment_failure",
        p_priority: "high",
        p_blocks_payment: true,
        p_blocks_payout: true,
        p_notes: `Capture declined: ${msg}`,
      });
      return { ok: false, message: msg };
    }

    await opAmbiguous(opId, msg);
    return {
      ok: false,
      message:
        `Outcome unknown — marked ambiguous. Check Stripe for PaymentIntent ` +
        `${pay.stripe_payment_ref} before trying again. (${msg})`,
    };
  }

  if (pi.status !== "succeeded") {
    const message = `Stripe returned ${pi.status}`;
    await opFailed(opId, message);
    await transitionPayment(s, paymentId, "capture_failed", { reason: message });
    return { ok: false, message: `Capture did not succeed (${pi.status}).` };
  }

  try {
    await opSucceeded(opId, pi.id);
    await transitionPayment(s, paymentId, "succeeded", { reason });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Local update failed";
    await opAmbiguous(
      opId,
      `Stripe capture ${pi.id} succeeded but local finalisation failed: ${message}`,
      pi.id
    ).catch(() => undefined);
    return {
      ok: false,
      message: `Stripe captured the payment, but local finalisation needs review: ${message}`,
    };
  }

  let releaseNote = "";
  try {
    await maybeReleasePayout(admin, pay.booking_id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    releaseNote = ` Payout readiness needs attention: ${message}`;
  }

  refreshAdmin();
  return {
    ok: true,
    message: `Captured £${Number(pay.gross_amount).toFixed(2)}.${releaseNote}`,
  };
}

/* ==========================================================================
 * 2. Retry a provider transfer
 * ========================================================================== */
export async function retryTransfer(
  payoutId: string,
  reason: string
): Promise<Result> {
  const { s, userId } = await requireAdmin();

  if (!reason?.trim()) return { ok: false, message: "Give a reason." };

  const { data: po, error: payoutError } = await s
    .from("payouts")
    .select("id, booking_id, provider_id, amount, status")
    .eq("id", payoutId)
    .maybeSingle();

  if (payoutError) return { ok: false, message: payoutError.message };
  if (!po) return { ok: false, message: "Payout not found." };
  if (!po.booking_id || !po.provider_id)
    return { ok: false, message: "Payout is missing its booking or provider." };
  if (!["pending", "failed"].includes(po.status))
    return { ok: false, message: `Cannot send from status ${po.status}.` };

  const { data: prov, error: providerError } = await admin
    .from("providers")
    .select("stripe_account_id")
    .eq("id", po.provider_id)
    .maybeSingle();

  if (providerError) return { ok: false, message: providerError.message };

  const destination = prov?.stripe_account_id ?? process.env.PROVIDER_TEST_ACCOUNT;
  if (!destination)
    return { ok: false, message: "Provider has no Stripe account on file." };

  const key = `transfer:booking:${po.booking_id}:provider:${po.provider_id}`;
  let claim;
  try {
    claim = await claimMoneyOperation(admin, {
      operationKey: key,
      operationType: "transfer",
      bookingId: po.booking_id,
      amount: Number(po.amount),
      requestedBy: userId,
    });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not claim transfer",
    };
  }
  if (!claim?.should_run)
    return {
      ok: false,
      message: `Not run: ${claim?.status}${
        claim?.message ? ` — ${claim.message}` : ""
      }`,
    };

  const opId = claim.id as string;

  try {
    await transitionPayout(s, payoutId, "processing", { reason });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Transition failed";
    await opFailed(opId, message);
    return { ok: false, message };
  }

  let transfer: Stripe.Transfer;
  try {
    transfer = await stripe.transfers.create(
      {
        amount: Math.round(Number(po.amount) * 100),
        currency: "gbp",
        destination,
        // Durable handles. Stripe keeps metadata; idempotency keys expire.
        metadata: {
          operation_key: key,
          booking_id: po.booking_id ?? "",
          payout_id: payoutId,
        },
      },
      { idempotencyKey: key }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Transfer failed";
    const definite = e instanceof Stripe.errors.StripeInvalidRequestError;

    if (definite) {
      await opFailed(opId, msg);
      await transitionPayout(s, payoutId, "failed", { reason: msg });
      return { ok: false, message: msg };
    }

    await opAmbiguous(opId, msg);
    return {
      ok: false,
      message:
        `Outcome unknown — marked ambiguous. Search Stripe transfers for ` +
        `metadata.operation_key = ${key} before retrying. (${msg})`,
    };
  }

  try {
    await opSucceeded(opId, transfer.id);

    const { error: referenceError } = await admin
      .from("payouts")
      .update({ stripe_transfer_ref: transfer.id })
      .eq("id", payoutId);
    if (referenceError) throw new Error(referenceError.message);

    await transitionPayout(s, payoutId, "paid", { reason });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Local update failed";
    await opAmbiguous(
      opId,
      `Stripe transfer ${transfer.id} succeeded but local finalisation failed: ${message}`,
      transfer.id
    ).catch(() => undefined);
    return {
      ok: false,
      message: `Stripe sent the transfer, but local finalisation needs review: ${message}`,
    };
  }

  refreshAdmin();
  return { ok: true, message: `Sent £${Number(po.amount).toFixed(2)}.` };
}

/* ==========================================================================
 * 3. Lift a hold
 * ========================================================================== */
export async function releasePayoutHold(
  payoutId: string,
  reason: string
): Promise<Result> {
  const { s } = await requireAdmin();
  if (!reason?.trim()) return { ok: false, message: "Give a reason." };

  const { data: po, error: payoutError } = await s
    .from("payouts")
    .select("id, booking_id, status")
    .eq("id", payoutId)
    .maybeSingle();

  if (payoutError) return { ok: false, message: payoutError.message };
  if (!po) return { ok: false, message: "Payout not found." };

  // A hold exists because something blocked it. Don't lift it while that
  // something is still open.
  const { count, error: casesError } = await s
    .from("review_cases")
    .select("*", { count: "exact", head: true })
    .eq("booking_id", po.booking_id)
    .eq("blocks_payout", true)
    .neq("status", "resolved");

  if (casesError) return { ok: false, message: casesError.message };

  if ((count ?? 0) > 0)
    return {
      ok: false,
      message: "Resolve the blocking review case first.",
    };

  try {
    await transitionPayout(s, payoutId, "pending", { reason });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not lift hold",
    };
  }

  refreshAdmin();
  return { ok: true, message: "Hold lifted — payout is pending." };
}

/* ==========================================================================
 * 4. Refund against a resolved decision
 * ========================================================================== */
export async function issueRefund(
  caseId: string,
  amount: number,
  reason: string
): Promise<Result> {
  const { s, userId } = await requireAdmin();

  if (!reason?.trim()) return { ok: false, message: "Give a reason." };
  if (!Number.isFinite(amount) || !(amount > 0))
    return { ok: false, message: "Amount must be positive." };
  const amountPence = Math.round(amount * 100);
  const refundAmount = amountPence / 100;

  const { data: rc, error: caseError } = await s
    .from("review_cases")
    .select(
      "id, booking_id, status, resolution_amount, resolution_currency"
    )
    .eq("id", caseId)
    .maybeSingle();

  if (caseError) return { ok: false, message: caseError.message };
  if (!rc) return { ok: false, message: "Case not found." };
  if (rc.status !== "resolved")
    return { ok: false, message: "Resolve the case and approve an amount first." };
  if (rc.resolution_currency !== "gbp")
    return { ok: false, message: "Only GBP refunds are supported." };

  const approvedPence = Math.round(Number(rc.resolution_amount ?? 0) * 100);
  if (approvedPence <= 0)
    return { ok: false, message: "This case has no approved refund amount." };

  const { data: pay, error: paymentError } = await s
    .from("payments")
    .select("id, status, gross_amount, stripe_payment_ref")
    .eq("booking_id", rc.booking_id)
    .or("kind.is.null,kind.neq.tip")
    .order("created_at")
    .limit(1)
    .maybeSingle();

  if (paymentError) return { ok: false, message: paymentError.message };
  if (!pay) return { ok: false, message: "No payment on this booking." };
  if (!["succeeded", "partially_refunded"].includes(pay.status))
    return {
      ok: false,
      message: `Only a charged payment can be refunded (status ${pay.status}).`,
    };
  if (!pay.stripe_payment_ref)
    return { ok: false, message: "No Stripe reference on this payment." };
  if (refundAmount > Number(pay.gross_amount))
    return { ok: false, message: "Refund exceeds the amount charged." };

  const { data: priorOps, error: priorOpsError } = await admin
    .from("money_operations")
    .select("amount")
    .eq("operation_type", "refund")
    .eq("status", "succeeded")
    .like("operation_key", `refund:resolution:${caseId}:%`);
  if (priorOpsError) return { ok: false, message: priorOpsError.message };

  const refundedForCasePence = (priorOps ?? []).reduce(
    (sum, operation) => sum + Math.round(Number(operation.amount) * 100),
    0
  );
  const approvalRemaining = approvedPence - refundedForCasePence;
  if (amountPence > approvalRemaining)
    return {
      ok: false,
      message: `Refund exceeds the £${(approvalRemaining / 100).toFixed(
        2
      )} remaining approval.`,
    };

  let paymentIntent: Stripe.PaymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.retrieve(
      pay.stripe_payment_ref,
      { expand: ["latest_charge"] }
    );
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not read Stripe payment",
    };
  }

  const charge =
    typeof paymentIntent.latest_charge === "string"
      ? await stripe.charges.retrieve(paymentIntent.latest_charge)
      : paymentIntent.latest_charge;
  const receivedPence = paymentIntent.amount_received ?? paymentIntent.amount;
  const alreadyRefundedPence = charge?.amount_refunded ?? 0;
  if (amountPence > receivedPence - alreadyRefundedPence)
    return { ok: false, message: "Refund exceeds Stripe's remaining charge." };

  // A distinct key per refund, so a second partial refund is its own operation.
  const { data: seq, error: seqErr } = await s.rpc("next_refund_sequence", {
    p_case_id: caseId,
  });
  if (seqErr) return { ok: false, message: seqErr.message };

  const key = `refund:resolution:${caseId}:${seq}`;
  let claim;
  try {
    claim = await claimMoneyOperation(admin, {
      operationKey: key,
      operationType: "refund",
      bookingId: rc.booking_id,
      amount: refundAmount,
      requestedBy: userId,
    });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not claim refund",
    };
  }
  if (!claim?.should_run)
    return { ok: false, message: `Not run: ${claim?.status}` };

  const opId = claim.id as string;
  const previousStatus = pay.status as "succeeded" | "partially_refunded";

  try {
    await transitionPayment(s, pay.id, "refund_pending", {
      reason: `${reason} (case ${caseId}, seq ${seq})`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Transition failed";
    await opFailed(opId, message);
    return { ok: false, message };
  }

  let refund: Stripe.Refund;
  try {
    refund = await stripe.refunds.create(
      {
        payment_intent: pay.stripe_payment_ref,
        amount: amountPence,
        metadata: {
          operation_key: key,
          review_case_id: caseId,
          booking_id: rc.booking_id ?? "",
        },
      },
      { idempotencyKey: key }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Refund failed";
    const definite = e instanceof Stripe.errors.StripeInvalidRequestError;

    if (definite) {
      await opFailed(opId, msg);
      await transitionPayment(s, pay.id, previousStatus, {
        reason: `Refund failed: ${msg}`,
      });
      return { ok: false, message: msg };
    }

    await opAmbiguous(opId, msg);
    return {
      ok: false,
      message:
        `Outcome unknown — marked ambiguous. Check Stripe refunds for ` +
        `metadata.operation_key = ${key}. (${msg})`,
    };
  }

  if (refund.status !== "succeeded") {
    if (refund.status === "failed" || refund.status === "canceled") {
      const message = `Stripe refund ${refund.status}`;
      await opFailed(opId, message);
      await transitionPayment(s, pay.id, previousStatus, { reason: message });
      return { ok: false, message };
    }

    await opAmbiguous(
      opId,
      `Stripe refund ${refund.id} is ${refund.status}`,
      refund.id
    );
    return {
      ok: false,
      message: `Refund is ${refund.status}; payment remains under review.`,
    };
  }

  const fullyRefunded =
    alreadyRefundedPence + (refund.amount ?? amountPence) >= receivedPence;

  try {
    await opSucceeded(opId, refund.id);
    await transitionPayment(
      s,
      pay.id,
      fullyRefunded ? "refunded" : "partially_refunded",
      { reason }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Local update failed";
    await opAmbiguous(
      opId,
      `Stripe refund ${refund.id} succeeded but local finalisation failed: ${message}`,
      refund.id
    ).catch(() => undefined);
    return {
      ok: false,
      message: `Stripe refunded the customer, but local finalisation needs review: ${message}`,
    };
  }

  refreshAdmin();
  return {
    ok: true,
    message: `Refunded £${refundAmount.toFixed(2)}${
      fullyRefunded ? " in full" : " (partial)"
    }.`,
  };
}

/* ==========================================================================
 * 5. Case and finding paperwork
 * ========================================================================== */
export async function takeCase(caseId: string): Promise<Result> {
  const { s } = await requireAdmin();
  const { error } = await s.rpc("assign_review_case", { p_case_id: caseId });
  if (error) return { ok: false, message: error.message };
  refreshAdmin();
  return { ok: true, message: "Assigned to you." };
}

export async function closeCase(
  caseId: string,
  outcome: string,
  notes: string,
  amount?: number
): Promise<Result> {
  const { s } = await requireAdmin();
  if (!outcome?.trim()) return { ok: false, message: "Give an outcome." };
  if (amount !== undefined && (!Number.isFinite(amount) || amount < 0))
    return { ok: false, message: "Amount must be zero or positive." };

  const { data, error } = await s.rpc("resolve_review_case", {
    p_case_id: caseId,
    p_outcome: outcome,
    p_notes: notes || null,
    p_amount: amount ?? null,
    p_currency: "gbp",
  });
  if (error) return { ok: false, message: error.message };

  // Resolving a blocking case may make a held payout releasable — but only
  // through the readiness rules, never by writing a status here.
  const bookingId = (data as { booking_id?: string } | null)?.booking_id;
  const wasBlocking = (data as { was_blocking_payout?: boolean } | null)
    ?.was_blocking_payout;
  const blockedPayment = (data as { was_blocking_payment?: boolean } | null)
    ?.was_blocking_payment;

  let extra = "";
  if (bookingId && (wasBlocking || blockedPayment)) {
    const { data: po, error: payoutError } = await admin
      .from("payouts")
      .select("id, status")
      .eq("booking_id", bookingId)
      .maybeSingle();

    if (payoutError)
      return { ok: false, message: `Case closed, but payout check failed: ${payoutError.message}` };

    if (po?.status === "held") {
      extra =
        " The payout is still held — lift it explicitly once you're satisfied.";
    } else {
      try {
        await maybeReleasePayout(admin, bookingId);
        extra = " Payout readiness re-checked.";
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        extra = ` Payout readiness check needs attention: ${message}`;
      }
    }
  }

  refreshAdmin();
  return { ok: true, message: `Case closed.${extra}` };
}

export async function ackFinding(findingId: string): Promise<Result> {
  const { s } = await requireAdmin();
  const { error } = await s.rpc("acknowledge_finding", {
    p_finding_id: findingId,
  });
  if (error) return { ok: false, message: error.message };
  refreshAdmin();
  return { ok: true, message: "Acknowledged." };
}

export async function closeFinding(
  findingId: string,
  outcome: string,
  falsePositive = false
): Promise<Result> {
  const { s } = await requireAdmin();
  if (!outcome?.trim()) return { ok: false, message: "Say what was done." };

  const { error } = await s.rpc("close_finding", {
    p_finding_id: findingId,
    p_outcome: outcome,
    p_false_positive: falsePositive,
  });
  if (error) return { ok: false, message: error.message };
  refreshAdmin();
  return {
    ok: true,
    message: falsePositive ? "Marked a false positive." : "Finding closed.",
  };
}

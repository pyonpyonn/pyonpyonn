// SETUP: mkdir -p "app/api/cron/reconcile" && code "app/api/cron/reconcile/route.ts"
//
// Reconciliation. OBSERVES ONLY.
//
// This job never changes a booking, payment or payout. It compares Stripe with
// our own records and writes reconciliation_findings. Remediation is always an
// explicit, authenticated admin action that goes through the state machines.
//
// Run daily, after suspicious webhook failures, and manually from admin:
//   GET /api/cron/reconcile   with Authorization: Bearer CRON_SECRET
//   GET /api/cron/reconcile?key=CRON_SECRET
//   GET /api/cron/reconcile?key=CRON_SECRET&days=90     (wider window)
//   GET /api/cron/reconcile?key=CRON_SECRET&dry=1       (report, write nothing)

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/** How long something may sit mid-flight before we call it stuck. */
const STUCK_MINUTES = 30;
const DB_PAGE_SIZE = 500;
const MAX_DB_ROWS = 5000;
const STRIPE_PAGE_SIZE = 100;
const MAX_STRIPE_TRANSFERS = 5000;

/**
 * Ignore Stripe objects created before this point.
 *
 * Test-mode accounts accumulate history with no surviving local counterpart
 * when demo data is reset while Stripe retains its charges. Set
 * RECONCILE_SINCE to an ISO date—normally the go-live date—to exclude that
 * known test history without weakening reconciliation after the cutoff.
 */
function reconciliationEpoch() {
  // This project's test-history boundary. Vercel may override it later, but
  // reconciliation must never silently widen to old demo transfers merely
  // because an environment variable was omitted.
  const value = process.env.RECONCILE_SINCE?.trim() || "2026-08-05";

  const epoch = new Date(value);
  if (Number.isNaN(epoch.getTime())) {
    throw new Error("RECONCILE_SINCE must be a valid ISO date");
  }
  return epoch;
}

function beforeEpoch(createdUnix: number, epoch: Date | null) {
  return epoch !== null && createdUnix * 1000 < epoch.getTime();
}

async function effectiveReconciliationEpoch(configured: Date) {
  const { data, error } = await admin.rpc("latest_prototype_reset_at");
  throwOnQueryError("Reading the latest prototype reset", error);
  if (!data) return { epoch: configured, resetAt: null as Date | null };

  const resetAt = new Date(data as string);
  if (Number.isNaN(resetAt.getTime())) {
    throw new Error("latest_prototype_reset_at returned an invalid date");
  }
  return {
    epoch: resetAt > configured ? resetAt : configured,
    resetAt,
  };
}

type Severity = "info" | "warning" | "critical";

type Finding = {
  finding_type: string;
  severity: Severity;
  booking_id?: string | null;
  payment_id?: string | null;
  payout_id?: string | null;
  operation_id?: string | null;
  stripe_object_id?: string | null;
  expected?: unknown;
  actual?: unknown;
};

type PaymentRow = {
  id: string;
  booking_id: string | null;
  subscription_id: string | null;
  status: string;
  kind: string | null;
  gross_amount: number | string | null;
  stripe_payment_ref: string | null;
  status_changed_at: string | null;
  created_at: string;
};

type CompletedBookingRow = {
  id: string;
  subscription_id: string | null;
  scheduled_at: string;
};

type PayoutRow = {
  id: string;
  booking_id: string | null;
  provider_id: string | null;
  amount: number | string;
  status: string;
  stripe_transfer_ref: string | null;
  status_changed_at: string | null;
  created_at: string;
};

type MoneyOperationRow = {
  id: string;
  operation_key: string;
  operation_type: string;
  booking_id: string | null;
  status: string;
  stripe_object_id: string | null;
  attempt_count: number;
  started_at: string | null;
  last_error: string | null;
};

type ErrorWithCode = {
  code?: string;
  message?: string;
  statusCode?: number;
  raw?: { statusCode?: number };
};

function isStripeNotFound(error: unknown) {
  const e = error as ErrorWithCode;
  return e?.statusCode === 404 || e?.raw?.statusCode === 404;
}

function validUuid(value: string | null | undefined) {
  return value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value
    : null;
}

function throwOnQueryError(context: string, error: ErrorWithCode | null) {
  if (error)
    throw new Error(
      `${context}: ${error.message ?? error.code ?? "query failed"}`,
    );
}

async function readAll<T>(
  context: string,
  readPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: ErrorWithCode | null }>,
) {
  const rows: T[] = [];

  for (let from = 0; ; from += DB_PAGE_SIZE) {
    const { data, error } = await readPage(from, from + DB_PAGE_SIZE - 1);
    throwOnQueryError(context, error);
    const page = data ?? [];
    rows.push(...page);

    if (rows.length > MAX_DB_ROWS) {
      throw new Error(
        `${context}: more than ${MAX_DB_ROWS} rows in the window; rerun with fewer days`,
      );
    }
    if (page.length < DB_PAGE_SIZE) return rows;
  }
}

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const secret = process.env.CRON_SECRET;
  if (!secret || (key !== secret && bearer !== secret)) {
    return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  }

  const requestedDays = Number(req.nextUrl.searchParams.get("days") ?? 30);
  if (!Number.isFinite(requestedDays)) {
    return NextResponse.json(
      { error: "days must be a number between 1 and 365" },
      { status: 400 },
    );
  }
  const days = Math.min(365, Math.max(1, Math.trunc(requestedDays)));
  const dryRun = req.nextUrl.searchParams.get("dry") === "1";
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const findings: Finding[] = [];
  const notes: string[] = [];

  try {
    const configuredEpoch = reconciliationEpoch();
    const { epoch, resetAt } =
      await effectiveReconciliationEpoch(configuredEpoch);

    /* ==================================================================
     * 1. Every local payment, judged against Stripe's evidence
     * ================================================================== */
    const payments = await readAll<PaymentRow>("Reading payments", (from, to) =>
      admin
        .from("payments")
        .select(
          "id, booking_id, subscription_id, status, kind, gross_amount, stripe_payment_ref, status_changed_at, created_at",
        )
        .gte("created_at", since.toISOString())
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    );

    for (const p of payments) {
      // ---- stuck mid-capture ----
      const transient = ["capturing", "cancelling", "refund_pending"];
      if (
        transient.includes(p.status) &&
        p.status_changed_at &&
        Date.now() - new Date(p.status_changed_at).getTime() >
          STUCK_MINUTES * 60 * 1000
      ) {
        findings.push({
          finding_type:
            p.status === "capturing"
              ? "payment_stuck_capturing"
              : "operation_ambiguous",
          severity: "critical",
          booking_id: p.booking_id,
          payment_id: p.id,
          stripe_object_id: p.stripe_payment_ref,
          expected: {
            status:
              p.status === "capturing"
                ? "succeeded or capture_failed"
                : "the transient operation to finish",
          },
          actual: { status: p.status, since: p.status_changed_at },
        });
      }

      // Tips and subscription invoices are charged, not authorised — the
      // PaymentIntent comparison below assumes the hold-then-capture flow.
      if (!p.stripe_payment_ref || !p.stripe_payment_ref.startsWith("pi_")) {
        continue;
      }

      let pi: Stripe.PaymentIntent | null = null;
      try {
        pi = await stripe.paymentIntents.retrieve(p.stripe_payment_ref, {
          expand: ["latest_charge"],
        });
      } catch (error) {
        if (isStripeNotFound(error)) {
          findings.push({
            finding_type: "operation_ambiguous",
            severity: "critical",
            booking_id: p.booking_id,
            payment_id: p.id,
            stripe_object_id: p.stripe_payment_ref,
            expected: { exists: true },
            actual: {
              exists: false,
              note: "PaymentIntent not found at Stripe",
            },
          });
          continue;
        }
        throw error;
      }

      const received = pi.amount_received ?? 0;
      const charge =
        typeof pi.latest_charge === "string"
          ? await stripe.charges.retrieve(pi.latest_charge)
          : pi.latest_charge;
      const refunded = charge?.amount_refunded ?? 0;

      // Approved refund totals are decisions; Stripe's refunded amount is the
      // evidence. Reconciliation reports disagreement and never heals it.
      if (p.booking_id && p.status !== "refund_pending") {
        const { data: approvals, error: approvalsError } = await admin
          .from("review_cases")
          .select("id, resolution_amount, resolution_currency")
          .eq("booking_id", p.booking_id)
          .eq("status", "resolved")
          .eq("resolution_currency", "gbp")
          .gt("resolution_amount", 0);
        throwOnQueryError(
          `Reading refund approvals for payment ${p.id}`,
          approvalsError,
        );

        const approvedPence = (approvals ?? []).reduce(
          (sum, reviewCase) =>
            sum + Math.round(Number(reviewCase.resolution_amount) * 100),
          0,
        );

        if (approvedPence !== refunded) {
          findings.push({
            finding_type: "refund_amount_mismatch",
            severity: "critical",
            booking_id: p.booking_id,
            payment_id: p.id,
            stripe_object_id: pi.id,
            expected: {
              amount_refunded_pence: approvedPence,
              review_case_ids: (approvals ?? []).map(
                (reviewCase) => reviewCase.id,
              ),
            },
            actual: { amount_refunded_pence: refunded },
          });
        }
      }

      // ---- what does the evidence say the local status should be? ----
      let expected: string | null = null;

      if (pi.status === "canceled" && received === 0) {
        // Cancelling a requires_capture intent releases the authorisation and
        // leaves it canceled — reliable evidence that nothing was taken.
        expected = "cancelled";
      } else if (pi.status === "succeeded" && received > 0) {
        if (refunded === 0) expected = "succeeded";
        else if (refunded >= received) expected = "refunded";
        else expected = "partially_refunded";
      } else if (pi.status === "requires_capture") {
        expected = "authorised";
      } else if (
        pi.status === "requires_payment_method" ||
        pi.status === "requires_confirmation" ||
        pi.status === "requires_action"
      ) {
        expected = "created";
      }

      if (expected === null) {
        findings.push({
          finding_type: "operation_ambiguous",
          severity: "critical",
          booking_id: p.booking_id,
          payment_id: p.id,
          stripe_object_id: pi.id,
          expected: { status: "determinable" },
          actual: {
            stripe_status: pi.status,
            amount_received: received,
            amount_refunded: refunded,
            note: "Evidence is contradictory — needs a human",
          },
        });
        continue;
      }

      // In-flight local states are legitimately transient; don't cry wolf.
      if (p.status !== expected && !transient.includes(p.status)) {
        const type =
          expected === "succeeded"
            ? "stripe_captured_local_pending"
            : "operation_ambiguous";

        findings.push({
          finding_type: type,
          severity: "critical",
          booking_id: p.booking_id,
          payment_id: p.id,
          stripe_object_id: pi.id,
          expected: {
            status: expected,
            evidence: {
              stripe_status: pi.status,
              amount_received: received,
              amount_refunded: refunded,
            },
          },
          actual: { status: p.status },
        });
      }
    }

    /* ==================================================================
     * 2. Completed work whose money was never taken
     * ================================================================== */
    const completed = await readAll<CompletedBookingRow>(
      "Reading completed bookings",
      (from, to) =>
        admin
          .from("bookings")
          .select("id, subscription_id, scheduled_at")
          .eq("status", "completed")
          .gte("scheduled_at", since.toISOString())
          .order("scheduled_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
    );

    for (const b of completed) {
      const { data: pays, error: bookingPaymentsError } = await admin
        .from("payments")
        .select("id, status, kind")
        .eq("booking_id", b.id);
      throwOnQueryError(
        `Reading payments for booking ${b.id}`,
        bookingPaymentsError,
      );

      const jobPays = (pays ?? []).filter(
        (x) => (x.kind ?? "booking") !== "tip",
      );
      const succeededJobPay = jobPays.find((x) => x.status === "succeeded");

      // Membership visits are funded by the invoice, not per booking.
      if (!b.subscription_id) {
        if (!succeededJobPay) {
          findings.push({
            finding_type: "completed_booking_uncaptured_payment",
            severity: "critical",
            booking_id: b.id,
            payment_id: jobPays[0]?.id ?? null,
            expected: { payment: "at least one succeeded booking payment" },
            actual: {
              payments:
                jobPays.length > 0
                  ? jobPays.map((payment) => ({
                      id: payment.id,
                      status: payment.status,
                    }))
                  : "none",
            },
          });
        }
      } else {
        // Match maybe_release_payout: missing invoice periods fail closed.
        const { data: covering, error: coveringError } = await admin
          .from("payments")
          .select("id, status, period_start, period_end")
          .eq("subscription_id", b.subscription_id)
          .eq("kind", "subscription")
          .eq("status", "succeeded")
          .lte("period_start", b.scheduled_at)
          .gt("period_end", b.scheduled_at)
          .limit(1);
        throwOnQueryError(
          `Reading covering invoice for booking ${b.id}`,
          coveringError,
        );

        if (!covering?.length) {
          findings.push({
            finding_type: "completed_booking_uncaptured_payment",
            severity: "critical",
            booking_id: b.id,
            expected: {
              payment: "a succeeded membership invoice covering scheduled_at",
            },
            actual: { payment: "none" },
          });
        }
      }

      // ---- membership visit finished with nowhere for the money to go ----
      if (b.subscription_id) {
        const { count, error: payoutCountError } = await admin
          .from("payouts")
          .select("*", { count: "exact", head: true })
          .eq("booking_id", b.id);
        throwOnQueryError(
          `Counting payouts for booking ${b.id}`,
          payoutCountError,
        );

        if ((count ?? 0) === 0) {
          findings.push({
            finding_type: "membership_visit_without_payout",
            severity: "warning",
            booking_id: b.id,
            expected: { payout: "one payout row" },
            actual: { payout: "none" },
          });
        }
      }
    }

    /* ==================================================================
     * 3. Payouts against Stripe transfers
     * ================================================================== */
    const payouts = await readAll<PayoutRow>("Reading payouts", (from, to) =>
      admin
        .from("payouts")
        .select(
          "id, booking_id, provider_id, amount, status, stripe_transfer_ref, status_changed_at, created_at",
        )
        .gte("created_at", since.toISOString())
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    );

    for (const po of payouts) {
      if (
        po.status === "processing" &&
        po.status_changed_at &&
        Date.now() - new Date(po.status_changed_at).getTime() >
          STUCK_MINUTES * 60 * 1000
      ) {
        findings.push({
          finding_type: "payout_stuck_processing",
          severity: "critical",
          booking_id: po.booking_id,
          payout_id: po.id,
          stripe_object_id: po.stripe_transfer_ref,
          expected: { status: "paid or failed" },
          actual: { status: po.status, since: po.status_changed_at },
        });
      }

      if (po.status !== "paid") continue;

      // Marked paid locally — prove it.
      if (!po.stripe_transfer_ref) {
        findings.push({
          finding_type: "local_paid_without_stripe_transfer",
          severity: "critical",
          booking_id: po.booking_id,
          payout_id: po.id,
          expected: { stripe_transfer_ref: "present" },
          actual: { stripe_transfer_ref: null },
        });
        continue;
      }

      try {
        const tr = await stripe.transfers.retrieve(po.stripe_transfer_ref);
        const local = Math.round(Number(po.amount) * 100);

        if (tr.reversed || tr.amount_reversed > 0) {
          findings.push({
            finding_type: "operation_ambiguous",
            severity: "critical",
            booking_id: po.booking_id,
            payout_id: po.id,
            stripe_object_id: tr.id,
            expected: { status: "reversed" },
            actual: {
              status: po.status,
              stripe_reversed: tr.reversed,
              amount_reversed_pence: tr.amount_reversed,
            },
          });
        }

        if (tr.amount !== local) {
          findings.push({
            finding_type: "payout_amount_mismatch",
            severity: "critical",
            booking_id: po.booking_id,
            payout_id: po.id,
            stripe_object_id: tr.id,
            expected: { amount_pence: local },
            actual: { amount_pence: tr.amount },
          });
        }
      } catch (error) {
        if (isStripeNotFound(error)) {
          findings.push({
            finding_type: "local_paid_without_stripe_transfer",
            severity: "critical",
            booking_id: po.booking_id,
            payout_id: po.id,
            stripe_object_id: po.stripe_transfer_ref,
            expected: { exists: true },
            actual: { exists: false, note: "Transfer not found at Stripe" },
          });
          continue;
        }
        throw error;
      }
    }

    /* ==================================================================
     * 4. Stripe transfers with no local record
     * ------------------------------------------------------------------
     * Two funding models coexist, and they leave different traces:
     *
     *   Per-visit  — a destination charge. Stripe creates the transfer when
     *                the payment captures and sets source_transaction to the
     *                charge. No local payout row exists by design, so these
     *                reconcile against payments.
     *
     *   Membership — the platform collects, then explicitly creates a
     *                transfer. These must match a local payout row.
     * ================================================================== */
    const transfers: Stripe.Transfer[] = [];
    let startingAfter: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const page = await stripe.transfers.list({
        created: { gte: Math.floor(since.getTime() / 1000) },
        limit: STRIPE_PAGE_SIZE,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      transfers.push(...page.data);
      hasMore = page.has_more;
      startingAfter = page.data.at(-1)?.id;

      if (
        transfers.length > MAX_STRIPE_TRANSFERS ||
        (transfers.length === MAX_STRIPE_TRANSFERS && hasMore)
      ) {
        throw new Error(
          `More than ${MAX_STRIPE_TRANSFERS} Stripe transfers in the window; rerun with fewer days`,
        );
      }
      if (hasMore && !startingAfter) {
        throw new Error("Stripe transfer pagination returned no cursor");
      }
    }

    let destinationChargeTransfers = 0;
    let platformInitiatedTransfers = 0;
    let transfersSkippedBeforeEpoch = 0;

    for (const tr of transfers) {
      if (beforeEpoch(tr.created, epoch)) {
        transfersSkippedBeforeEpoch++;
        continue;
      }

      const sourceTransaction =
        typeof tr.source_transaction === "string"
          ? tr.source_transaction
          : (tr.source_transaction?.id ?? null);

      if (sourceTransaction) {
        destinationChargeTransfers++;

        let paymentIntentId: string | null = null;
        try {
          const charge = await stripe.charges.retrieve(sourceTransaction);
          paymentIntentId =
            typeof charge.payment_intent === "string"
              ? charge.payment_intent
              : (charge.payment_intent?.id ?? null);
        } catch (error) {
          if (!isStripeNotFound(error)) throw error;
        }

        if (!paymentIntentId) {
          findings.push({
            finding_type: "stripe_transfer_without_local_payout",
            severity: "warning",
            stripe_object_id: tr.id,
            expected: { local_record: "a payment behind this charge" },
            actual: {
              local_record: "none",
              source_transaction: sourceTransaction,
              amount_pence: tr.amount,
              stripe_created_at: new Date(tr.created * 1000).toISOString(),
              note: "Destination-charge transfer whose charge could not be read",
            },
          });
          continue;
        }

        const { data: payment, error: paymentLookupError } = await admin
          .from("payments")
          .select("id, booking_id, status")
          .eq("stripe_payment_ref", paymentIntentId)
          .maybeSingle();
        throwOnQueryError(
          `Looking up payment for destination-charge transfer ${tr.id}`,
          paymentLookupError,
        );

        if (!payment) {
          findings.push({
            finding_type: "stripe_transfer_without_local_payout",
            severity: "critical",
            stripe_object_id: tr.id,
            expected: { local_payment: `one row for ${paymentIntentId}` },
            actual: {
              local_payment: "none",
              source_transaction: sourceTransaction,
              amount_pence: tr.amount,
              stripe_created_at: new Date(tr.created * 1000).toISOString(),
              note: "Money reached a provider via a destination charge we have no record of",
            },
          });
        }

        // This is the per-visit model behaving correctly when a matching
        // payment exists. A payout row is neither required nor expected.
        continue;
      }

      platformInitiatedTransfers++;

      const { count, error: localTransferError } = await admin
        .from("payouts")
        .select("*", { count: "exact", head: true })
        .eq("stripe_transfer_ref", tr.id);
      throwOnQueryError(
        `Looking up local payout for transfer ${tr.id}`,
        localTransferError,
      );

      if ((count ?? 0) > 0) continue;

      // metadata.operation_key is the durable handle — Stripe keeps it, unlike
      // idempotency keys which may be pruned after ~24 hours.
      const opKey = tr.metadata?.operation_key ?? null;
      const bookingId = validUuid(tr.metadata?.booking_id);

      findings.push({
        finding_type: "stripe_transfer_without_local_payout",
        severity: "critical",
        booking_id: bookingId,
        stripe_object_id: tr.id,
        expected: { local_payout: "one row" },
        actual: {
          local_payout: "none",
          amount_pence: tr.amount,
          stripe_created_at: new Date(tr.created * 1000).toISOString(),
          destination:
            typeof tr.destination === "string" ? tr.destination : null,
          operation_key: opKey,
          note: opKey
            ? "We initiated this transfer but never recorded the payout"
            : "Platform-initiated transfer with no operation key — pre-dates the money_operations ledger?",
        },
      });
    }

    /* ==================================================================
     * 5. Duplicates and unprovable operations
     * ================================================================== */
    const ops = await readAll<MoneyOperationRow>(
      "Reading money operations",
      (from, to) =>
        admin
          .from("money_operations")
          .select(
            "id, operation_key, operation_type, booking_id, status, stripe_object_id, attempt_count, started_at, last_error, created_at",
          )
          .gte("created_at", since.toISOString())
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
    );

    const succeeded = new Map<string, string[]>();

    for (const op of ops) {
      if (op.status === "ambiguous") {
        findings.push({
          finding_type: "operation_ambiguous",
          severity: "critical",
          booking_id: op.booking_id,
          operation_id: op.id,
          stripe_object_id: op.stripe_object_id,
          expected: { status: "succeeded or failed" },
          actual: { status: "ambiguous", last_error: op.last_error },
        });
      }

      if (
        op.status === "processing" &&
        op.started_at &&
        Date.now() - new Date(op.started_at).getTime() >
          STUCK_MINUTES * 60 * 1000
      ) {
        findings.push({
          finding_type: "operation_ambiguous",
          severity: "critical",
          booking_id: op.booking_id,
          operation_id: op.id,
          stripe_object_id: op.stripe_object_id,
          expected: { status: "resolved by now" },
          actual: {
            status: "processing",
            since: op.started_at,
            attempts: op.attempt_count,
            note: "Outcome unknown — check Stripe by metadata.operation_key",
          },
        });
      }

      if (
        op.status === "succeeded" &&
        op.booking_id &&
        ["capture", "transfer"].includes(op.operation_type)
      ) {
        const k = `${op.operation_type}:${op.booking_id}`;
        succeeded.set(k, [...(succeeded.get(k) ?? []), op.id]);
      }
    }

    for (const [k, ids] of succeeded) {
      if (ids.length < 2) continue;
      const [type, bookingId] = k.split(":");
      findings.push({
        finding_type:
          type === "capture" ? "duplicate_capture" : "duplicate_transfer",
        severity: "critical",
        booking_id: bookingId,
        operation_id: ids[0],
        expected: { succeeded_operations: 1 },
        actual: { succeeded_operations: ids.length, ids },
      });
    }

    notes.push(
      `Ignoring Stripe objects created before ${epoch.toISOString()} ` +
        (resetAt && resetAt.getTime() === epoch.getTime()
          ? "(latest prototype reset)."
          : "(RECONCILE_SINCE or project default)."),
    );

    /* ==================================================================
     * 6. Record. Never remediate.
     * ================================================================== */
    let written = 0;
    if (!dryRun) {
      for (const f of findings) {
        // The partial unique index keeps an already-open finding from
        // being raised again every night.
        const { error } = await admin.from("reconciliation_findings").insert({
          finding_type: f.finding_type,
          severity: f.severity,
          booking_id: f.booking_id ?? null,
          payment_id: f.payment_id ?? null,
          payout_id: f.payout_id ?? null,
          operation_id: f.operation_id ?? null,
          stripe_object_id: f.stripe_object_id ?? null,
          expected: f.expected ?? null,
          actual: f.actual ?? null,
        });
        if (!error) {
          written++;
        } else if (error.code !== "23505") {
          throw new Error(
            `Writing reconciliation finding ${f.finding_type}: ${error.message}`,
          );
        }
      }
    }

    const bySeverity = findings.reduce<Record<string, number>>((acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1;
      return acc;
    }, {});

    const byType = findings.reduce<Record<string, number>>((acc, f) => {
      acc[f.finding_type] = (acc[f.finding_type] ?? 0) + 1;
      return acc;
    }, {});

    return NextResponse.json({
      ok: true,
      mode: dryRun ? "dry-run (nothing written)" : "recorded",
      window_days: days,
      checked: {
        payments: payments.length,
        completed_bookings: completed.length,
        payouts: payouts.length,
        stripe_transfers: transfers.length,
        transfers_from_destination_charges: destinationChargeTransfers,
        transfers_platform_initiated: platformInitiatedTransfers,
        transfers_skipped_before_epoch: transfersSkippedBeforeEpoch,
        operations: ops.length,
      },
      findings: findings.length,
      new_findings_written: written,
      by_severity: bySeverity,
      by_type: byType,
      notes,
      detail: dryRun ? findings : undefined,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Reconciliation failed";
    console.error("Reconciliation error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// SETUP: mkdir -p "lib" && code "lib/visitStatus.test.ts"
//
// Run with:  npx tsx --test lib/visitStatus.test.ts
//        or: node --test --experimental-strip-types lib/visitStatus.test.ts
//
// The projector is pure, so this covers every booking × payment × case
// combination without a database.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  projectVisitStatus,
  type VisitFacts,
  type NextActor,
  type MoneyState,
} from "./visitStatus";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const BOOKING_STATUSES = [
  "offered",
  "declined",
  "scheduled",
  "in_progress",
  "completed",
  "cancelled",
  "needs_review",
  "some_future_status", // must not throw
];

const PAYMENT_STATUSES = [
  null,
  "created",
  "authorised",
  "capturing",
  "succeeded",
  "capture_failed",
  "cancelling",
  "cancelled",
  "refund_pending",
  "partially_refunded",
  "refunded",
  "who_knows", // must not throw
];

type CaseShape =
  | "none"
  | "blocking_payment"
  | "blocking_payout"
  | "non_blocking"
  | "resolved";

const CASE_SHAPES: CaseShape[] = [
  "none",
  "blocking_payment",
  "blocking_payout",
  "non_blocking",
  "resolved",
];

const NOW = "2026-08-05T12:00:00.000Z";

function caseFor(shape: CaseShape): VisitFacts["reviewCase"] {
  switch (shape) {
    case "none":
      return null;
    case "blocking_payment":
      return {
        category: "payment_failure",
        status: "open",
        blocksPayment: true,
        blocksPayout: true,
        resolutionDueAt: "2026-08-08T12:00:00.000Z",
        resolved: false,
      };
    case "blocking_payout":
      return {
        category: "damage_or_injury",
        status: "acknowledged",
        blocksPayment: false,
        blocksPayout: true,
        resolutionDueAt: "2026-08-06T12:00:00.000Z",
        resolved: false,
      };
    case "non_blocking":
      return {
        category: "quality_complaint",
        status: "open",
        blocksPayment: false,
        blocksPayout: false,
        resolutionDueAt: "2026-08-19T12:00:00.000Z",
        resolved: false,
      };
    case "resolved":
      return {
        category: "quality_complaint",
        status: "resolved",
        blocksPayment: false,
        blocksPayout: false,
        resolutionDueAt: null,
        resolved: true,
      };
  }
}

function facts(over: Partial<VisitFacts> = {}): VisitFacts {
  return {
    bookingId: "b1",
    bookingStatus: "scheduled",
    scheduledAt: "2026-08-06T10:00:00.000Z",
    offerExpiresAt: "2026-08-06T08:00:00.000Z",
    durationMinutes: 120,
    serviceName: "Essential Clean",
    providerName: "Jane",
    arrivedAt: null,
    isMembershipVisit: false,
    packageId: "pkg1",
    postcode: "SW3 1AA",
    paymentStatus: "authorised",
    grossAmount: 69,
    refundedAmount: null,
    openOfferCount: 0,
    reviewCase: null,
    hasRated: false,
    now: NOW,
    ...over,
  };
}

const ACTORS: NextActor[] = ["client", "provider", "platform", "support"];
const MONEY_STATES: MoneyState[] = [
  "none",
  "authorised",
  "charging",
  "charged",
  "released",
  "partially_refunded",
  "refunded",
  "under_review",
];

/* ------------------------------------------------------------------ */
/* 1. Exhaustive: every combination must be safe and complete          */
/* ------------------------------------------------------------------ */

test("every booking × payment × case combination is well-formed", () => {
  let checked = 0;

  for (const bookingStatus of BOOKING_STATUSES) {
    for (const paymentStatus of PAYMENT_STATUSES) {
      for (const shape of CASE_SHAPES) {
        const f = facts({
          bookingStatus,
          paymentStatus,
          reviewCase: caseFor(shape),
          openOfferCount: bookingStatus === "offered" ? 3 : 0,
          arrivedAt:
            bookingStatus === "in_progress" ? "2026-08-05T11:00:00.000Z" : null,
        });

        const s = projectVisitStatus(f);
        const where = `${bookingStatus} / ${paymentStatus} / ${shape}`;
        checked++;

        // ---- always says something ----
        assert.ok(s.headline.length > 0, `no headline: ${where}`);
        assert.ok(s.detail.length > 0, `no detail: ${where}`);

        // ---- always names who acts next ----
        assert.ok(ACTORS.includes(s.nextActor), `bad actor: ${where}`);
        assert.ok(s.nextActorLabel.length > 0, `no actor label: ${where}`);
        assert.ok(s.nextActorDetail.length > 0, `no actor detail: ${where}`);

        // ---- always explains the money ----
        assert.ok(MONEY_STATES.includes(s.money.state), `bad money: ${where}`);
        assert.ok(s.money.label.length > 0, `no money label: ${where}`);
        assert.ok(
          s.money.explanation.length > 0,
          `no money explanation: ${where}`
        );

        // ---- always offers a way forward ----
        assert.ok(s.actions.length > 0, `no actions: ${where}`);
        assert.ok(
          s.actions.every((a) => a.label.length > 0),
          `unlabelled action: ${where}`
        );

        // ---- never leaks internals ----
        const blob = JSON.stringify(s).toLowerCase();
        for (const forbidden of [
          "resolution_notes",
          "internal",
          "assigned_to",
          "resolved_by",
          "stripe",
          "pi_",
          "operation_key",
        ]) {
          assert.ok(
            !blob.includes(forbidden),
            `leaked "${forbidden}" in: ${where}`
          );
        }

        // ---- deadlines are real dates when present ----
        if (s.deadline) {
          assert.ok(
            !Number.isNaN(new Date(s.deadline.at).getTime()),
            `bad deadline: ${where}`
          );
          assert.ok(s.deadline.label.length > 0, `no deadline label: ${where}`);
        }

        // ---- "if nobody accepts" only while nobody has ----
        if (bookingStatus === "offered" || bookingStatus === "declined") {
          const openCase =
            shape === "blocking_payment" ||
            shape === "blocking_payout" ||
            shape === "non_blocking";
          if (!openCase) {
            assert.ok(
              s.ifNobodyAccepts && s.ifNobodyAccepts.length > 0,
              `should explain the no-acceptance path: ${where}`
            );
          }
        } else {
          assert.equal(
            s.ifNobodyAccepts,
            null,
            `should not mention acceptance: ${where}`
          );
        }

        // ---- you cannot cancel or reschedule what has already happened ----
        if (["in_progress", "completed", "cancelled"].includes(bookingStatus)) {
          assert.ok(
            !s.actions.some((a) => a.kind === "cancel"),
            `offered cancel on ${where}`
          );
          assert.ok(
            !s.actions.some((a) => a.kind === "reschedule"),
            `offered reschedule on ${where}`
          );
        }

        // ---- rating only for a finished, unrated visit ----
        if (s.actions.some((a) => a.kind === "rate")) {
          assert.equal(bookingStatus, "completed", `rate offered on ${where}`);
          assert.equal(f.hasRated, false, `rate offered when rated: ${where}`);
        }
      }
    }
  }

  assert.equal(
    checked,
    BOOKING_STATUSES.length * PAYMENT_STATUSES.length * CASE_SHAPES.length
  );
});

/* ------------------------------------------------------------------ */
/* 2. An open blocking case speaks for the whole visit                 */
/* ------------------------------------------------------------------ */

test("a money-blocking case overrides the payment state", () => {
  const s = projectVisitStatus(
    facts({
      bookingStatus: "completed",
      paymentStatus: "succeeded", // would normally read "Charged"
      reviewCase: caseFor("blocking_payment"),
    })
  );

  assert.equal(s.money.state, "under_review");
  assert.equal(s.nextActor, "support");
  assert.ok(s.actions.some((a) => a.kind === "contact_support"));
  assert.ok(!s.actions.some((a) => a.kind === "rate"));
});

test("a payout-blocking case is the customer's business too, but not their problem", () => {
  const s = projectVisitStatus(
    facts({
      bookingStatus: "completed",
      paymentStatus: "succeeded",
      reviewCase: caseFor("blocking_payout"),
    })
  );

  assert.equal(s.nextActor, "support");
  assert.equal(s.tone, "alert"); // damage_or_injury
  // The charge itself stands — only the provider's payout is held.
  assert.equal(s.money.state, "charged");
  assert.ok(s.reviewCase);
  assert.equal(s.reviewCase?.resolved, false);
});

test("a resolved case does not hijack the visit", () => {
  const s = projectVisitStatus(
    facts({
      bookingStatus: "completed",
      paymentStatus: "succeeded",
      reviewCase: caseFor("resolved"),
      hasRated: false,
    })
  );

  assert.equal(s.headline, "Completed");
  assert.ok(s.actions.some((a) => a.kind === "rate"));
  assert.equal(s.reviewCase?.resolved, true);
});

/* ------------------------------------------------------------------ */
/* 3. The states a customer asks about most                            */
/* ------------------------------------------------------------------ */

test("waiting for a provider explains what happens if nobody accepts", () => {
  const s = projectVisitStatus(
    facts({ bookingStatus: "offered", openOfferCount: 4, paymentStatus: "authorised" })
  );

  assert.equal(s.nextActor, "provider");
  assert.match(s.detail, /4 available providers/);
  assert.match(s.ifNobodyAccepts!, /release the hold/i);
  assert.equal(s.money.state, "authorised");
  assert.ok(s.deadline);
});

test("held is described as held, not charged", () => {
  const s = projectVisitStatus(facts({ paymentStatus: "authorised" }));
  assert.equal(s.money.label, "Held, not charged");
  assert.match(s.money.explanation, /only charged once the visit is finished/i);
});

test("a released hold reassures rather than alarms", () => {
  const s = projectVisitStatus(
    facts({ bookingStatus: "cancelled", paymentStatus: "cancelled" })
  );
  assert.equal(s.money.state, "released");
  assert.equal(s.money.label, "You weren't charged");
  assert.ok(s.actions.some((a) => a.kind === "book_again"));
});

test("a failed capture tells the customer what to do", () => {
  const s = projectVisitStatus(
    facts({ bookingStatus: "completed", paymentStatus: "capture_failed" })
  );
  assert.equal(s.money.state, "under_review");
  assert.equal(s.money.label, "Payment failed");
  assert.ok(s.actions.some((a) => a.kind === "update_card"));
});

test("a partial refund states the amount", () => {
  const s = projectVisitStatus(
    facts({
      bookingStatus: "completed",
      paymentStatus: "partially_refunded",
      refundedAmount: 25,
    })
  );
  assert.equal(s.money.state, "partially_refunded");
  assert.match(s.money.explanation, /£25\.00/);
});

test("a membership visit does not claim money was held", () => {
  const s = projectVisitStatus(
    facts({
      bookingStatus: "scheduled",
      paymentStatus: null,
      isMembershipVisit: true,
    })
  );
  assert.equal(s.money.state, "none");
  assert.match(s.money.explanation, /covered by your membership/i);
});

test("in progress reports a finish time and asks nothing of the customer", () => {
  const s = projectVisitStatus(
    facts({
      bookingStatus: "in_progress",
      arrivedAt: "2026-08-05T11:00:00.000Z",
      durationMinutes: 120,
    })
  );
  assert.equal(s.tone, "live");
  assert.equal(s.nextActor, "provider");
  assert.ok(s.deadline);
  assert.equal(new Date(s.deadline!.at).toISOString(), "2026-08-05T13:00:00.000Z");
  assert.deepEqual(
    s.actions.map((a) => a.kind),
    ["wait"]
  );
});

test("a rated, completed visit needs nothing from anyone", () => {
  const s = projectVisitStatus(
    facts({
      bookingStatus: "completed",
      paymentStatus: "succeeded",
      hasRated: true,
    })
  );
  assert.equal(s.nextActor, "platform");
  assert.ok(!s.actions.some((a) => a.kind === "rate"));
  assert.ok(s.actions.some((a) => a.kind === "book_again"));
});

test("an unknown booking status fails safe", () => {
  const s = projectVisitStatus(facts({ bookingStatus: "teleported" }));
  assert.equal(s.nextActor, "support");
  assert.ok(s.actions.some((a) => a.kind === "contact_support"));
  assert.ok(s.headline.length > 0);
});

test("an unknown payment status does not claim the customer was charged", () => {
  const s = projectVisitStatus(facts({ paymentStatus: "quantum" }));
  assert.equal(s.money.state, "under_review");
  assert.ok(!/charged in full/i.test(s.money.explanation));
});

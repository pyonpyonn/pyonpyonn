// SETUP: mkdir -p "lib" && code "lib/visitStatus.ts"
//
// One place that decides what a customer is told about a visit.
//
// projectVisitStatus() is PURE — no database, no clock beyond what's passed in.
// That's what makes it exhaustively testable. getVisitStatus() just gathers the
// facts and hands them over. Pages render the result and decide nothing.

import type { SupabaseClient } from "@supabase/supabase-js";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type NextActor = "client" | "provider" | "platform" | "support";

export type MoneyState =
  | "none" // nothing taken or held yet
  | "authorised" // card held, not charged
  | "charging" // capture in flight
  | "charged" // captured
  | "released" // hold released, never charged
  | "partially_refunded"
  | "refunded"
  | "under_review"; // a case or a failure is blocking the money

export type ActionKind =
  | "wait"
  | "cancel"
  | "reschedule"
  | "rate"
  | "tip"
  | "contact_support"
  | "book_again"
  | "update_card";

export type Action = {
  kind: ActionKind;
  label: string;
  href?: string;
  primary?: boolean;
};

export type Tone = "neutral" | "good" | "live" | "warning" | "alert";

export type VisitStatus = {
  headline: string;
  detail: string;
  tone: Tone;

  nextActor: NextActor;
  nextActorLabel: string;
  nextActorDetail: string;

  money: {
    state: MoneyState;
    label: string;
    explanation: string;
    amount: number | null;
    refunded: number | null;
  };

  /** Only set while nobody has accepted yet. */
  ifNobodyAccepts: string | null;

  deadline: { at: string; label: string } | null;

  actions: Action[];

  /** Safe to show. Internal notes are never included. */
  reviewCase: {
    category: string;
    summary: string;
    status: string;
    resolved: boolean;
  } | null;
};

/** Everything the projector needs. Nothing it doesn't. */
export type VisitFacts = {
  bookingId: string;
  bookingStatus: string;
  scheduledAt: string | null;
  offerExpiresAt: string | null;
  durationMinutes: number | null;
  serviceName: string | null;
  providerName: string | null;
  arrivedAt: string | null;
  isMembershipVisit: boolean;
  packageId: string | null;
  postcode: string | null;

  paymentStatus: string | null;
  grossAmount: number | null;
  refundedAmount: number | null;

  /** Providers who currently have an open offer. */
  openOfferCount: number;

  /** Unresolved case, if any. Notes are deliberately absent. */
  reviewCase: {
    category: string;
    status: string;
    blocksPayment: boolean;
    blocksPayout: boolean;
    resolutionDueAt: string | null;
    resolved: boolean;
  } | null;

  hasRated: boolean;
  now: string;
};

/* ------------------------------------------------------------------ */
/* Money                                                               */
/* ------------------------------------------------------------------ */

const CASE_SUMMARY: Record<string, string> = {
  worker_no_show:
    "Your provider didn't arrive. We're reviewing what happened and what happens with payment.",
  client_unavailable:
    "Your provider couldn't get access. We're reviewing what happens next.",
  late_cancellation: "This visit was cancelled close to the start time.",
  work_stopped: "The visit was stopped part-way through. We're looking into it.",
  unsafe_property:
    "Your provider raised a safety concern and stopped work. Our team is reviewing it.",
  damage_or_injury:
    "Something was reported as damaged or someone was hurt. Our team is handling this directly.",
  quality_complaint: "You told us the work wasn't up to standard. We're on it.",
  payment_failure:
    "Your payment didn't go through. We'll be in touch about settling it.",
  payout_failure: "An internal payment issue. Nothing for you to do.",
  other: "Our team is reviewing this visit.",
};

function projectMoney(f: VisitFacts): VisitStatus["money"] {
  const amount = f.grossAmount ?? null;
  const refunded = f.refundedAmount ?? null;

  // A case that blocks the money overrides whatever the payment says.
  if (f.reviewCase && !f.reviewCase.resolved && f.reviewCase.blocksPayment) {
    return {
      state: "under_review",
      label: "Under review",
      explanation:
        "We've paused anything to do with payment on this visit while our team looks into it. Nothing further will be taken.",
      amount,
      refunded,
    };
  }

  switch (f.paymentStatus) {
    case null:
    case "created":
      return {
        state: "none",
        label: "Nothing taken",
        explanation: f.isMembershipVisit
          ? "This visit is covered by your membership."
          : "No money has been taken or held yet.",
        amount,
        refunded,
      };

    case "authorised":
      return {
        state: "authorised",
        label: "Held, not charged",
        explanation:
          "Your card is held to secure the booking. You're only charged once the visit is finished.",
        amount,
        refunded,
      };

    case "capturing":
      return {
        state: "charging",
        label: "Charging now",
        explanation: "Your payment for this visit is being processed.",
        amount,
        refunded,
      };

    case "succeeded":
      return {
        state: "charged",
        label: "Charged",
        explanation: "Payment has been captured for this visit.",
        amount,
        refunded,
      };

    case "capture_failed":
      return {
        state: "under_review",
        label: "Payment failed",
        explanation:
          "We couldn't take payment for this visit. Our team will be in touch — please check your card details.",
        amount,
        refunded,
      };

    case "cancelling":
      return {
        state: "released",
        label: "Releasing the hold",
        explanation:
          "We're releasing the hold on your card. It can take a few days to clear, depending on your bank.",
        amount,
        refunded,
      };

    case "cancelled":
      return {
        state: "released",
        label: "You weren't charged",
        explanation:
          "The hold on your card has been released. Depending on your bank it may take a few days to disappear.",
        amount,
        refunded,
      };

    case "refund_pending":
      return {
        state: "under_review",
        label: "Refund on its way",
        explanation:
          "We've approved a refund and it's being processed. It usually reaches your account within five working days.",
        amount,
        refunded,
      };

    case "partially_refunded":
      return {
        state: "partially_refunded",
        label: "Partly refunded",
        explanation: refunded
          ? `We've refunded £${refunded.toFixed(2)} of this visit.`
          : "Part of this visit has been refunded.",
        amount,
        refunded,
      };

    case "refunded":
      return {
        state: "refunded",
        label: "Refunded",
        explanation:
          "This visit has been refunded in full. Allow a few working days for it to reach your account.",
        amount,
        refunded,
      };

    default:
      return {
        state: "under_review",
        label: "Being checked",
        explanation:
          "We're confirming the payment status on this visit. Our team will update you.",
        amount,
        refunded,
      };
  }
}

/* ------------------------------------------------------------------ */
/* The projection                                                      */
/* ------------------------------------------------------------------ */

const ACTOR_LABEL: Record<NextActor, string> = {
  client: "You",
  provider: "Your provider",
  platform: "Opulence Bliss",
  support: "Our support team",
};

function friendlyTime(iso: string | null, now: string): string {
  if (!iso) return "shortly";
  const d = new Date(iso);
  const today = new Date(now);
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  if (sameDay) return `today at ${time}`;
  return `${d.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  })} at ${time}`;
}

export function projectVisitStatus(f: VisitFacts): VisitStatus {
  const money = projectMoney(f);
  const service = f.serviceName ?? "your visit";
  const actions: Action[] = [];

  const openCase = f.reviewCase && !f.reviewCase.resolved ? f.reviewCase : null;

  const reviewCase = f.reviewCase
    ? {
        category: f.reviewCase.category,
        summary:
          CASE_SUMMARY[f.reviewCase.category] ?? CASE_SUMMARY.other,
        status: f.reviewCase.resolved ? "resolved" : "being handled",
        resolved: f.reviewCase.resolved,
      }
    : null;

  /* ---- an open case speaks for the whole visit ---- */
  if (openCase) {
    actions.push({
      kind: "contact_support",
      label: "Contact support",
      href: "/account/updates",
      primary: true,
    });

    return {
      headline: "We're looking into this visit",
      detail:
        (CASE_SUMMARY[openCase.category] ?? CASE_SUMMARY.other) +
        " You don't need to do anything right now — we'll come back to you.",
      tone: openCase.category === "damage_or_injury" ? "alert" : "warning",
      nextActor: "support",
      nextActorLabel: ACTOR_LABEL.support,
      nextActorDetail: "Our team is reviewing what happened.",
      money,
      ifNobodyAccepts: null,
      deadline: openCase.resolutionDueAt
        ? {
            at: openCase.resolutionDueAt,
            label: `We aim to update you by ${friendlyTime(
              openCase.resolutionDueAt,
              f.now
            )}`,
          }
        : null,
      actions,
      reviewCase,
    };
  }

  /* ---- otherwise, the booking's own state ---- */
  switch (f.bookingStatus) {
    case "offered":
    case "declined": {
      actions.push(
        { kind: "wait", label: "We'll let you know", primary: true },
        { kind: "cancel", label: "Cancel booking" },
        { kind: "reschedule", label: "Modify booking" }
      );

      return {
        headline: "Finding your provider",
        detail: `We're offering ${service} to ${
          f.openOfferCount > 0
            ? `${f.openOfferCount} available providers`
            : "matching providers"
        } one at a time. If one doesn't answer, the next provider gets a turn automatically.`,
        tone: "neutral",
        nextActor: "provider",
        nextActorLabel: ACTOR_LABEL.provider,
        nextActorDetail: "A provider needs to accept the job.",
        money,
        ifNobodyAccepts:
          "If nobody accepts, we cancel the booking automatically and release the hold on your card. You won't be charged, and we'll let you know so you can pick another time.",
        deadline: f.offerExpiresAt
          ? {
              at: f.offerExpiresAt,
              label: `We'll confirm by ${friendlyTime(f.offerExpiresAt, f.now)}`,
            }
          : null,
        actions,
        reviewCase,
      };
    }

    case "scheduled": {
      actions.push(
        { kind: "wait", label: "Nothing to do", primary: true },
        { kind: "reschedule", label: "Modify booking" },
        { kind: "cancel", label: "Cancel booking" }
      );

      return {
        headline: "Confirmed",
        detail: `${
          f.providerName ?? "Your provider"
        } is confirmed for ${service}. They'll check in when they arrive.`,
        tone: "good",
        nextActor: "provider",
        nextActorLabel: ACTOR_LABEL.provider,
        nextActorDetail: `Arriving ${friendlyTime(f.scheduledAt, f.now)}.`,
        money,
        ifNobodyAccepts: null,
        deadline: f.scheduledAt
          ? {
              at: f.scheduledAt,
              label: `Arriving ${friendlyTime(f.scheduledAt, f.now)}`,
            }
          : null,
        actions,
        reviewCase,
      };
    }

    case "in_progress": {
      const finish =
        f.arrivedAt && f.durationMinutes
          ? new Date(
              new Date(f.arrivedAt).getTime() + f.durationMinutes * 60000
            ).toISOString()
          : null;

      actions.push({ kind: "wait", label: "In progress", primary: true });

      return {
        headline: "Happening now",
        detail: `${
          f.providerName ?? "Your provider"
        } has arrived and is working. You'll be charged once they finish.`,
        tone: "live",
        nextActor: "provider",
        nextActorLabel: ACTOR_LABEL.provider,
        nextActorDetail: "They'll check out when the work is done.",
        money,
        ifNobodyAccepts: null,
        deadline: finish
          ? {
              at: finish,
              label: `Due to finish around ${friendlyTime(finish, f.now)}`,
            }
          : null,
        actions,
        reviewCase,
      };
    }

    case "completed": {
      if (!f.hasRated) {
        actions.push({
          kind: "rate",
          label: "Rate this visit",
          primary: true,
        });
      }
      if (money.state === "charged" || money.state === "none") {
        actions.push({ kind: "tip", label: "Add a tip" });
      }
      if (money.state === "under_review" && f.paymentStatus === "capture_failed") {
        actions.push({
          kind: "update_card",
          label: "Sort out payment",
          href: "/account",
          primary: true,
        });
      }
      actions.push({
        kind: "book_again",
        label: "Book again",
        href: `/book?service=${f.packageId ?? ""}&pc=${f.postcode ?? ""}`,
      });
      actions.push({
        kind: "contact_support",
        label: "Something wrong?",
        href: "/account/updates",
      });

      return {
        headline: "Completed",
        detail: f.hasRated
          ? `${service} is done. Thanks for rating it.`
          : `${service} is done. A quick rating helps other customers and rewards good providers.`,
        tone: "good",
        nextActor: f.hasRated ? "platform" : "client",
        nextActorLabel: f.hasRated ? ACTOR_LABEL.platform : ACTOR_LABEL.client,
        nextActorDetail: f.hasRated
          ? "Nothing outstanding on this visit."
          : "Rate your visit when you have a moment.",
        money,
        ifNobodyAccepts: null,
        deadline: null,
        actions,
        reviewCase,
      };
    }

    case "cancelled": {
      actions.push({
        kind: "book_again",
        label: "Book another time",
        href: `/book?service=${f.packageId ?? ""}&pc=${f.postcode ?? ""}`,
        primary: true,
      });
      actions.push({
        kind: "contact_support",
        label: "Ask about this",
        href: "/account/updates",
      });

      return {
        headline: "Cancelled",
        detail:
          money.state === "released"
            ? "This visit was cancelled and the hold was released. You weren't charged."
            : money.state === "refunded"
              ? "This visit was cancelled and your payment was refunded."
              : "This visit was cancelled.",
        tone: "neutral",
        nextActor: "client",
        nextActorLabel: ACTOR_LABEL.client,
        nextActorDetail: "Book another time whenever suits you.",
        money,
        ifNobodyAccepts: null,
        deadline: null,
        actions,
        reviewCase,
      };
    }

    case "needs_review": {
      // The booking is flagged but no case row reached us — still tell them
      // something true rather than showing a raw status.
      actions.push({
        kind: "contact_support",
        label: "Contact support",
        href: "/account/updates",
        primary: true,
      });

      return {
        headline: "We're looking into this visit",
        detail:
          "Something didn't go to plan and our team is reviewing it. You don't need to do anything right now.",
        tone: "warning",
        nextActor: "support",
        nextActorLabel: ACTOR_LABEL.support,
        nextActorDetail: "Our team is reviewing what happened.",
        money,
        ifNobodyAccepts: null,
        deadline: null,
        actions,
        reviewCase,
      };
    }

    default: {
      actions.push({
        kind: "contact_support",
        label: "Contact support",
        href: "/account/updates",
        primary: true,
      });

      return {
        headline: "Checking on this visit",
        detail:
          "We're confirming the details of this booking. If it doesn't update shortly, please get in touch.",
        tone: "warning",
        nextActor: "support",
        nextActorLabel: ACTOR_LABEL.support,
        nextActorDetail: "Our team will confirm the details.",
        money,
        ifNobodyAccepts: null,
        deadline: null,
        actions,
        reviewCase,
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Loader                                                              */
/* ------------------------------------------------------------------ */

function unavailableVisitStatus(bookingId: string): VisitStatus {
  return projectVisitStatus({
    bookingId,
    bookingStatus: "status_unavailable",
    scheduledAt: null,
    offerExpiresAt: null,
    durationMinutes: null,
    serviceName: null,
    providerName: null,
    arrivedAt: null,
    isMembershipVisit: false,
    packageId: null,
    postcode: null,
    paymentStatus: "status_unavailable",
    grossAmount: null,
    refundedAmount: null,
    openOfferCount: 0,
    reviewCase: null,
    hasRated: false,
    now: new Date().toISOString(),
  });
}

/**
 * Gather the facts for one booking and project them. RLS decides what the
 * caller may read, so this is safe to call with the signed-in user's client.
 *
 * Internal case notes are never selected — not filtered out later, never read.
 * A narrow SECURITY DEFINER function exposes only ownership-checked safe facts,
 * because participants intentionally cannot SELECT review_cases directly.
 */
export async function getVisitStatus(
  supabase: SupabaseClient,
  bookingId: string
): Promise<VisitStatus | null> {
  const { data: b, error: bookingError } = await supabase
    .from("bookings")
    .select(
      `id, status, scheduled_at, offer_expires_at, address, package_id,
       subscription_id,
       packages(name, duration_minutes),
       providers(display_name),
       check_ins(arrived_at)`
    )
    .eq("id", bookingId)
    .maybeSingle();

  if (bookingError) return unavailableVisitStatus(bookingId);
  if (!b) return null;

  const one = <T,>(v: T | T[] | null | undefined): T | null =>
    !v ? null : Array.isArray(v) ? v[0] ?? null : v;

  const pkg = one(b.packages as never) as {
    name: string;
    duration_minutes: number | null;
  } | null;
  const prv = one(b.providers as never) as { display_name: string | null } | null;
  const ci = one(b.check_ins as never) as { arrived_at: string | null } | null;

  const [paymentResult, privateResult, ratingResult] = await Promise.all([
    supabase
      .from("payments")
      .select("status, gross_amount")
      .eq("booking_id", bookingId)
      .or("kind.is.null,kind.neq.tip")
      .order("created_at")
      .limit(1)
      .maybeSingle(),
    supabase.rpc("get_client_visit_status_facts", {
      p_booking_id: bookingId,
    }),
    supabase
      .from("reviews")
      .select("*", { count: "exact", head: true })
      .eq("booking_id", bookingId)
      .eq("reviewer", "client"),
  ]);

  if (paymentResult.error || privateResult.error || ratingResult.error) {
    return unavailableVisitStatus(bookingId);
  }

  const pay = paymentResult.data;
  const privateRows = privateResult.data as
    | {
        open_offer_count: number | string;
        review_category: string | null;
        review_status: string | null;
        blocks_payment: boolean | null;
        blocks_payout: boolean | null;
        resolution_due_at: string | null;
        refunded_amount: number | string | null;
      }[]
    | null;
  const safe = privateRows?.[0] ?? null;
  const refundedAmount = Number(safe?.refunded_amount ?? 0);

  return projectVisitStatus({
    bookingId: b.id,
    bookingStatus: String(b.status),
    scheduledAt: b.scheduled_at,
    offerExpiresAt: b.offer_expires_at ?? null,
    durationMinutes: pkg?.duration_minutes ?? null,
    serviceName: pkg?.name ?? null,
    providerName: prv?.display_name ?? null,
    arrivedAt: ci?.arrived_at ?? null,
    isMembershipVisit: !!b.subscription_id,
    packageId: b.package_id ?? null,
    postcode: b.address ?? null,

    paymentStatus: pay?.status ?? null,
    grossAmount: pay?.gross_amount ? Number(pay.gross_amount) : null,
    refundedAmount: refundedAmount > 0 ? refundedAmount : null,

    openOfferCount: Number(safe?.open_offer_count ?? 0),

    reviewCase: safe?.review_category && safe.review_status
      ? {
          category: safe.review_category,
          status: safe.review_status,
          blocksPayment: !!safe.blocks_payment,
          blocksPayout: !!safe.blocks_payout,
          resolutionDueAt: safe.resolution_due_at,
          resolved: safe.review_status === "resolved",
        }
      : null,

    hasRated: (ratingResult.count ?? 0) > 0,
    now: new Date().toISOString(),
  });
}

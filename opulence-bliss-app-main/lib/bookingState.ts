import type { SupabaseClient } from "@supabase/supabase-js";

export type ActorKind = "customer" | "provider" | "admin" | "system";
export type BookingStatus =
  | "offered"
  | "declined"
  | "scheduled"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "needs_review";
export type PaymentStatus =
  | "created"
  | "authorised"
  | "capturing"
  | "succeeded"
  | "capture_failed"
  | "cancelling"
  | "cancelled"
  | "refund_pending"
  | "partially_refunded"
  | "refunded";
export type PayoutStatus =
  | "not_ready"
  | "pending"
  | "processing"
  | "paid"
  | "failed"
  | "held"
  | "reversed";
export type MoneyOperationOutcome = "succeeded" | "failed" | "ambiguous";

type TransitionResult = {
  changed: boolean;
  from?: string;
  status: string;
  provider_id?: string | null;
};

export type RescheduleResult = {
  changed: boolean;
  from?: string;
  scheduled_at: string;
  provider_id?: string | null;
};

export type RescheduleWindow = {
  can_reschedule: boolean;
  cutoff_at?: string;
  lockout_hours?: number;
  min_notice_hours?: number;
  reason?: string | null;
};

export type BookingModificationResult = {
  changed: boolean;
  scheduled_at: string;
  package_id: string;
  time_changed?: boolean;
  service_changed?: boolean;
  visit_notes_changed?: boolean;
};

async function rpc<T>(
  client: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export function transitionBooking(
  client: SupabaseClient,
  bookingId: string,
  toStatus: BookingStatus,
  options: { reason?: string | null; meta?: Record<string, unknown> } = {},
) {
  return rpc<TransitionResult>(client, "transition_booking", {
    p_booking_id: bookingId,
    p_to_status: toStatus,
    p_reason: options.reason ?? null,
    p_meta: options.meta ?? {},
  });
}

export function systemTransitionBooking(
  admin: SupabaseClient,
  bookingId: string,
  toStatus: BookingStatus,
  reason: string,
  meta: Record<string, unknown> = {},
) {
  return rpc<TransitionResult>(admin, "system_transition_booking", {
    p_booking_id: bookingId,
    p_to_status: toStatus,
    p_reason: reason,
    p_meta: meta,
  });
}

export function rescheduleBookingState(
  client: SupabaseClient,
  bookingId: string,
  newSlot: string,
  options: { reason?: string | null; meta?: Record<string, unknown> } = {},
) {
  return rpc<RescheduleResult>(client, "reschedule_booking", {
    p_booking_id: bookingId,
    p_new_slot: newSlot,
    p_reason: options.reason ?? null,
    p_meta: options.meta ?? {},
  });
}

export function systemRescheduleBooking(
  admin: SupabaseClient,
  bookingId: string,
  newSlot: string,
  reason: string,
  meta: Record<string, unknown> = {},
) {
  return rpc<RescheduleResult>(admin, "system_reschedule_booking", {
    p_booking_id: bookingId,
    p_new_slot: newSlot,
    p_reason: reason,
    p_meta: meta,
  });
}

export function getRescheduleWindow(client: SupabaseClient, bookingId: string) {
  return rpc<RescheduleWindow>(client, "reschedule_window", {
    p_booking_id: bookingId,
  });
}

export function modifyCustomerBookingState(
  client: SupabaseClient,
  input: {
    bookingId: string;
    newSlot?: string | null;
    packageId?: string | null;
    householdNotes?: string | null;
    updateNotes?: boolean;
    reason: string;
    meta?: Record<string, unknown>;
  },
) {
  return rpc<BookingModificationResult>(client, "modify_customer_booking", {
    p_booking_id: input.bookingId,
    p_new_slot: input.newSlot ?? null,
    p_package_id: input.packageId ?? null,
    p_household_notes: input.householdNotes ?? null,
    p_update_notes: input.updateNotes ?? false,
    p_reason: input.reason,
    p_meta: input.meta ?? {},
  });
}

export function transitionPayment(
  client: SupabaseClient,
  paymentId: string,
  toStatus: PaymentStatus,
  options: { reason?: string | null; meta?: Record<string, unknown> } = {},
) {
  return rpc<TransitionResult>(client, "transition_payment", {
    p_payment_id: paymentId,
    p_to_status: toStatus,
    p_reason: options.reason ?? null,
    p_meta: options.meta ?? {},
  });
}

export function systemTransitionPayment(
  admin: SupabaseClient,
  paymentId: string,
  toStatus: PaymentStatus,
  options: { reason?: string | null; meta?: Record<string, unknown> } = {},
) {
  return rpc<TransitionResult>(admin, "system_transition_payment", {
    p_payment_id: paymentId,
    p_to_status: toStatus,
    p_reason: options.reason ?? null,
    p_meta: options.meta ?? {},
  });
}

export function transitionPayout(
  client: SupabaseClient,
  payoutId: string,
  toStatus: PayoutStatus,
  options: { reason?: string | null; meta?: Record<string, unknown> } = {},
) {
  return rpc<TransitionResult>(client, "transition_payout", {
    p_payout_id: payoutId,
    p_to_status: toStatus,
    p_reason: options.reason ?? null,
    p_meta: options.meta ?? {},
  });
}

export function systemTransitionPayout(
  admin: SupabaseClient,
  payoutId: string,
  toStatus: PayoutStatus,
  options: { reason?: string | null; meta?: Record<string, unknown> } = {},
) {
  return rpc<TransitionResult>(admin, "system_transition_payout", {
    p_payout_id: payoutId,
    p_to_status: toStatus,
    p_reason: options.reason ?? null,
    p_meta: options.meta ?? {},
  });
}

export function maybeReleasePayout(admin: SupabaseClient, bookingId: string) {
  return rpc<{ released: boolean; payout_id?: string; reason?: string }>(
    admin,
    "maybe_release_payout",
    { p_booking_id: bookingId },
  );
}

export function claimMoneyOperation(
  admin: SupabaseClient,
  input: {
    operationKey: string;
    operationType: "capture" | "transfer" | "refund" | "release";
    bookingId: string;
    amount: number;
    requestedBy?: string | null;
  },
) {
  return rpc<{
    should_run: boolean;
    status: string;
    id: string;
    attempt?: number;
    stripe_object_id?: string | null;
    message?: string;
  }>(admin, "claim_money_operation", {
    p_operation_key: input.operationKey,
    p_operation_type: input.operationType,
    p_booking_id: input.bookingId,
    p_amount: input.amount,
    p_requested_by: input.requestedBy ?? null,
  });
}

export function systemFinaliseMoneyOperation(
  admin: SupabaseClient,
  operationId: string,
  outcome: MoneyOperationOutcome,
  options: { stripeObjectId?: string | null; error?: string | null } = {},
) {
  return rpc<{ changed: boolean; from?: string; status: MoneyOperationOutcome }>(
    admin,
    "system_finalise_operation",
    {
      p_operation_id: operationId,
      p_outcome: outcome,
      p_stripe_id: options.stripeObjectId ?? null,
      p_error: options.error ?? null,
    },
  );
}

export function resolveAmbiguousMoneyOperation(
  client: SupabaseClient,
  operationId: string,
  outcome: Exclude<MoneyOperationOutcome, "ambiguous">,
  evidence: string,
  stripeObjectId?: string | null,
) {
  return rpc<{ changed: boolean; from?: string; status: MoneyOperationOutcome }>(
    client,
    "resolve_ambiguous_operation",
    {
      p_operation_id: operationId,
      p_outcome: outcome,
      p_stripe_id: stripeObjectId ?? null,
      p_evidence: evidence,
    },
  );
}

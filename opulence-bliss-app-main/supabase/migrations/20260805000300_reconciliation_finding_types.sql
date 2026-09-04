-- Reconciliation distinguishes payout amount mismatches from refund evidence.
-- Refund mismatches compare Stripe refunds with an approved review resolution;
-- payout mismatches compare a transfer's amount with the local payout row.

alter table reconciliation_findings
  drop constraint if exists recon_type_check;

alter table reconciliation_findings
  add constraint recon_type_check
  check (finding_type in (
    'completed_booking_uncaptured_payment',
    'stripe_captured_local_pending',
    'stripe_transfer_without_local_payout',
    'local_paid_without_stripe_transfer',
    'duplicate_transfer',
    'duplicate_capture',
    'refund_amount_mismatch',
    'payout_amount_mismatch',
    'payment_stuck_capturing',
    'payout_stuck_processing',
    'operation_ambiguous',
    'membership_visit_without_payout'
  ));

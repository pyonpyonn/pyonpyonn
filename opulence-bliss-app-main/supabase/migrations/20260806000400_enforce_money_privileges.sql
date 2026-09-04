-- ============================================================================
-- 0009 — Make the payment and payout status revokes effective
-- ============================================================================
-- A table-level UPDATE grant includes every column and therefore defeats a
-- narrower column-level REVOKE. Remove the broad grants first, then return only
-- the bookkeeping columns the service-role application code still writes.

revoke update on payments from anon, authenticated, service_role;
revoke update on payouts  from anon, authenticated, service_role;

grant update (
  stripe_payment_ref,
  split_breakdown,
  period_start,
  period_end
) on payments to service_role;

grant update (
  stripe_transfer_ref,
  amount,
  note
) on payouts to service_role;

-- Fail the migration if a future/default grant makes either status writable
-- again during this transaction.
do $verify$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if has_column_privilege(v_role, 'public.payments', 'status', 'UPDATE') then
      raise exception '%.payments.status remains directly writable', v_role;
    end if;
    if has_column_privilege(v_role, 'public.payouts', 'status', 'UPDATE') then
      raise exception '%.payouts.status remains directly writable', v_role;
    end if;
  end loop;
end $verify$;

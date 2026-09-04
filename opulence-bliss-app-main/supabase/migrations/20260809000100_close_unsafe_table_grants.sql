-- ============================================================================
-- Close mutation grants that have no application caller
-- ============================================================================
-- TRUNCATE bypasses RLS and row-level immutability triggers. None of the
-- application paths use it. Event deletion is likewise never legitimate, and
-- money_operations rows are created only by claim_money_operation().

revoke truncate on
  bookings,
  payments,
  payouts,
  review_cases,
  booking_events,
  payment_events,
  payout_events,
  review_case_events,
  money_operations
from anon, authenticated, service_role;

revoke delete on
  booking_events,
  payment_events,
  payout_events,
  review_case_events,
  money_operations
from anon, authenticated, service_role;

-- These roles have no legitimate deletion path. Authenticated DELETE remains
-- temporarily for the admin-only, test-mode reset tools.
revoke delete on bookings, payments, payouts from anon, service_role;

-- New operation rows converge through the locked claim RPC; application code
-- never inserts them directly.
revoke insert on money_operations from anon, authenticated, service_role;

do $assert$
declare
  v_role text;
  v_table text;
  v_bad text[] := '{}';
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    foreach v_table in array array[
      'bookings', 'payments', 'payouts', 'review_cases',
      'booking_events', 'payment_events', 'payout_events',
      'review_case_events', 'money_operations'
    ] loop
      if has_table_privilege(v_role, format('public.%I', v_table), 'TRUNCATE') then
        v_bad := v_bad || format('%s can truncate %s', v_role, v_table);
      end if;
    end loop;

    foreach v_table in array array[
      'booking_events', 'payment_events', 'payout_events',
      'review_case_events', 'money_operations'
    ] loop
      if has_table_privilege(v_role, format('public.%I', v_table), 'DELETE') then
        v_bad := v_bad || format('%s can delete %s', v_role, v_table);
      end if;
    end loop;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception 'unsafe grant closure failed: %', array_to_string(v_bad, '; ');
  end if;
end $assert$;

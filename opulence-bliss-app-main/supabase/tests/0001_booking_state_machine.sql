-- ============================================================================
-- 0001 — tests
-- ============================================================================
-- Run AFTER 0001-booking-state-machine.sql, in the Supabase SQL Editor.
-- Every check raises on failure; a clean run prints "ALL TESTS PASSED".
--
-- These run as the SQL Editor's privileged role, so they test the POLICY and
-- the FUNCTION logic. Role-derivation and column-level grants are proved
-- separately in section B (browser) and section C (two sessions).
-- ============================================================================

begin;

do $$
declare
  v_customer uuid;
  v_provider uuid;
  v_prov_row uuid;
  v_pkg      uuid;
  v_booking  uuid;
  v_res      jsonb;
  v_err      text;
  v_count    int;
begin
  raise notice '--- setting up a throwaway booking ---';

  select id into v_customer from profiles where role = 'customer' limit 1;
  select p.id, pr.id into v_provider, v_prov_row
    from profiles p join providers pr on pr.profile_id = p.id
   where p.role = 'provider' limit 1;
  select id into v_pkg from packages where active limit 1;

  if v_customer is null or v_provider is null or v_pkg is null then
    raise exception 'need at least one customer, one provider and one package to test';
  end if;

  insert into bookings (customer_id, package_id, scheduled_at, status, address)
  values (v_customer, v_pkg, now() + interval '2 hours', 'offered', 'SW3 1AA')
  returning id into v_booking;

  insert into booking_offers (booking_id, provider_id, status)
  values (v_booking, v_prov_row, 'open');

  -- ==========================================================================
  raise notice 'T1 — a customer cannot check a booking in';
  -- ==========================================================================
  begin
    v_res := _apply_booking_transition(
      v_booking, 'in_progress', v_customer, 'customer', null, '{}'::jsonb);
    raise exception 'T1 FAILED: customer was allowed to start work';
  exception
    when check_violation then
      raise notice '   ok — rejected as unpermitted';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'T1 FAILED%' then raise; end if;
      raise notice '   ok — rejected (%)', v_err;
  end;

  -- ==========================================================================
  raise notice 'T2 — an invalid jump (offered → completed) is refused';
  -- ==========================================================================
  begin
    v_res := _apply_booking_transition(
      v_booking, 'completed', v_provider, 'provider', null, '{}'::jsonb);
    raise exception 'T2 FAILED: illegal jump was allowed';
  exception
    when check_violation then raise notice '   ok — no such transition';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'T2 FAILED%' then raise; end if;
      raise notice '   ok — rejected (%)', v_err;
  end;

  -- ==========================================================================
  raise notice 'T3 — accepting an offer claims the job and closes the rest';
  -- ==========================================================================
  v_res := _apply_booking_transition(
    v_booking, 'scheduled', v_provider, 'provider', null, '{}'::jsonb);

  if (v_res->>'changed')::boolean is not true then
    raise exception 'T3 FAILED: accept did not change state (%)', v_res;
  end if;

  select count(*) into v_count from bookings
   where id = v_booking and provider_id = v_prov_row and status = 'scheduled';
  if v_count <> 1 then
    raise exception 'T3 FAILED: booking not claimed by the accepting provider';
  end if;

  select count(*) into v_count from booking_offers
   where booking_id = v_booking and provider_id = v_prov_row and status = 'accepted';
  if v_count <> 1 then
    raise exception 'T3 FAILED: winning offer not marked accepted';
  end if;
  raise notice '   ok — claimed, offer accepted';

  -- ==========================================================================
  raise notice 'T4 — a second accept is now impossible (offer no longer open)';
  -- ==========================================================================
  begin
    v_res := _apply_booking_transition(
      v_booking, 'scheduled', v_provider, 'provider', null, '{}'::jsonb);
    -- same status → no-op, which is fine; only a *state change* would be wrong
    if (v_res->>'changed')::boolean then
      raise exception 'T4 FAILED: booking was accepted twice';
    end if;
    raise notice '   ok — second accept is a no-op, not a change';
  exception
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'T4 FAILED%' then raise; end if;
      raise notice '   ok — rejected (%)', v_err;
  end;

  -- ==========================================================================
  raise notice 'T5 — a reason is required where policy says so';
  -- ==========================================================================
  begin
    v_res := _apply_booking_transition(
      v_booking, 'cancelled', v_provider, 'provider', null, '{}'::jsonb);
    raise exception 'T5 FAILED: provider cancelled without a reason';
  exception
    when check_violation then raise notice '   ok — reason demanded';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'T5 FAILED%' then raise; end if;
      raise notice '   ok — rejected (%)', v_err;
  end;

  -- ==========================================================================
  raise notice 'T6 — a provider who is not assigned cannot act';
  -- ==========================================================================
  begin
    v_res := _apply_booking_transition(
      v_booking, 'in_progress', v_customer, 'provider', null, '{}'::jsonb);
    raise exception 'T6 FAILED: a non-assigned actor started the job';
  exception
    when insufficient_privilege then raise notice '   ok — assignment enforced';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'T6 FAILED%' then raise; end if;
      raise notice '   ok — rejected (%)', v_err;
  end;

  -- ==========================================================================
  raise notice 'T7 — a no-op transition is idempotent, not an error';
  -- ==========================================================================
  v_res := _apply_booking_transition(
    v_booking, 'scheduled', v_provider, 'provider', null, '{}'::jsonb);
  if (v_res->>'changed')::boolean then
    raise exception 'T7 FAILED: repeat transition reported a change';
  end if;
  raise notice '   ok';

  -- ==========================================================================
  raise notice 'T8 — every change left an event behind';
  -- ==========================================================================
  select count(*) into v_count from booking_events where booking_id = v_booking;
  if v_count < 1 then
    raise exception 'T8 FAILED: no events recorded';
  end if;
  raise notice '   ok — % event(s)', v_count;

  -- ==========================================================================
  raise notice 'T9 — events cannot be rewritten or deleted';
  -- ==========================================================================
  begin
    update booking_events set reason = 'tampered' where booking_id = v_booking;
    raise exception 'T9 FAILED: an event was updated';
  exception
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'T9 FAILED%' then raise; end if;
      raise notice '   ok — update blocked (%)', v_err;
  end;

  begin
    delete from booking_events where booking_id = v_booking;
    raise exception 'T9 FAILED: an event was deleted';
  exception
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'T9 FAILED%' then raise; end if;
      raise notice '   ok — delete blocked (%)', v_err;
  end;

  -- ==========================================================================
  raise notice 'T10 — system may cancel, but must give a reason';
  -- ==========================================================================
  begin
    v_res := _apply_booking_transition(
      v_booking, 'cancelled', null, 'system', null, '{}'::jsonb);
    raise exception 'T10 FAILED: system cancelled with no reason';
  exception
    when check_violation then raise notice '   ok — reason demanded of system too';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'T10 FAILED%' then raise; end if;
      raise notice '   ok — rejected (%)', v_err;
  end;

  -- ==========================================================================
  raise notice 'T11 — money operations converge on a single row';
  -- ==========================================================================
  v_res := claim_money_operation(
    'test:capture:booking:' || v_booking, 'capture', v_booking, 69.00, null);
  if (v_res->>'should_run')::boolean is not true then
    raise exception 'T11 FAILED: first claim refused to run (%)', v_res;
  end if;

  -- a second claim while the first is in flight must NOT run
  v_res := claim_money_operation(
    'test:capture:booking:' || v_booking, 'capture', v_booking, 69.00, null);
  if (v_res->>'should_run')::boolean then
    raise exception 'T11 FAILED: two concurrent claims both allowed to run';
  end if;

  select count(*) into v_count from money_operations
   where operation_key = 'test:capture:booking:' || v_booking;
  if v_count <> 1 then
    raise exception 'T11 FAILED: % operation rows for one key', v_count;
  end if;
  raise notice '   ok — one row, one runner';

  raise notice 'ALL TESTS PASSED — rolling test data back';
end $$;

rollback;


-- ============================================================================
-- B. Prove the column revocation from the app (not from the SQL Editor)
-- ============================================================================
-- The SQL Editor runs privileged, so it can still write status. To prove the
-- revocation works, run this in the BROWSER CONSOLE while logged in as the
-- client, and confirm it errors:
--
--   const { createClient } = window.supabase ?? {};
--   // or simply, in any page that already has the browser client:
--   await supabase.from('bookings')
--     .update({ status: 'completed' })
--     .eq('id', '<a booking id you own>');
--
-- Expected: an error mentioning permission for column "status".
-- If it succeeds, the REVOKE did not apply — check for a second grant to
-- `authenticated` elsewhere in your schema.


-- ============================================================================
-- C. Prove concurrent acceptance serialises (two sessions)
-- ============================================================================
-- Needs two separate SQL Editor tabs. Replace <BOOKING> and the two provider
-- profile ids, both with an OPEN offer on that booking.
--
-- Session 1:
--   begin;
--   select _apply_booking_transition(
--     '<BOOKING>', 'scheduled', '<PROVIDER_A_PROFILE_ID>', 'provider', null, '{}');
--   -- leave the transaction OPEN
--
-- Session 2 (will block on the row lock):
--   begin;
--   select _apply_booking_transition(
--     '<BOOKING>', 'scheduled', '<PROVIDER_B_PROFILE_ID>', 'provider', null, '{}');
--
-- Session 1:
--   commit;
--
-- Session 2 then unblocks and must NOT win: it either reports
-- changed=false (already scheduled) or raises. Confirm afterwards:
--
--   select provider_id, status from bookings where id = '<BOOKING>';
--   select count(*) from booking_offers
--    where booking_id = '<BOOKING>' and status = 'accepted';   -- must be 1

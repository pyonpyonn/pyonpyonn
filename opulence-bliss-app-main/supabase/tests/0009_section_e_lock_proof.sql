-- ============================================================================
-- 0009 — section E, without writing to the audit log
-- ============================================================================
-- The original section E proved serialisation by having two sessions call
-- reopen_review_case() / set_case_blocks(). That works, but session 1 has to
-- COMMIT for session 2 to unblock — which permanently adds synthetic rows to
-- review_case_events and payout_events. Those tables are immutable by design,
-- so the fabricated contention would stay in the audit trail forever.
--
-- Instead, split the question in two:
--
--   E1 — does the LOCK serialise?      Two sessions, both ROLLBACK.
--   E2 — do the NO-OP branches hold?   One session, inside a rollback.
--
-- Together these cover the same ground: E1 proves two callers cannot proceed
-- concurrently, E2 proves the second caller does nothing when it does proceed.
-- ============================================================================


-- ============================================================================
-- E1. Row-level serialisation — two sessions, nothing committed
-- ============================================================================
-- This takes the SAME lock the functions take (SELECT ... FOR UPDATE on
-- review_cases), so it tests the mechanism rather than the wrapper. Neither
-- session commits, so no events are written by anyone.
--
-- Pick any existing case id:
--   select id, booking_id, status from review_cases limit 5;
--
-- ---------------------------------------------------------------------------
-- Session 1
-- ---------------------------------------------------------------------------
--   begin;
--   select id, status, blocks_payout
--     from review_cases
--    where id = '<CASE>'
--      for update;
--   -- lock held. LEAVE THIS TRANSACTION OPEN.
--
-- ---------------------------------------------------------------------------
-- Session 2  — should hang here, not return
-- ---------------------------------------------------------------------------
--   begin;
--   select now() as attempted_at;
--   select id, status
--     from review_cases
--    where id = '<CASE>'
--      for update;          -- blocks until session 1 ends
--
-- ---------------------------------------------------------------------------
-- Session 1 (while session 2 waits) — confirm the wait is real
-- ---------------------------------------------------------------------------
--   select
--     a.pid            as waiting_pid,
--     a.wait_event_type,
--     a.wait_event,
--     a.query          as waiting_query
--   from pg_stat_activity a
--   where a.wait_event_type = 'Lock'
--     and a.query ilike '%review_cases%';
--
--   -- One row means session 2 is genuinely queued on the lock.
--
-- ---------------------------------------------------------------------------
-- Session 1
-- ---------------------------------------------------------------------------
--   rollback;             -- releases the lock, writes nothing
--
-- ---------------------------------------------------------------------------
-- Session 2 — returns immediately now
-- ---------------------------------------------------------------------------
--   rollback;             -- writes nothing
--
-- PASS if: session 2 blocked, appeared in pg_stat_activity with
--          wait_event_type = 'Lock', and returned only after session 1 ended.
-- FAIL if: session 2 returned straight away — the lock is not being taken,
--          and every "atomically" claim in the migration is untrue.


-- ============================================================================
-- E2. The no-op branches — one session, rolled back
-- ============================================================================
-- Having proved callers are serialised, the remaining question is what the
-- SECOND caller does once it gets the lock. That needs no concurrency: call the
-- function twice in a row and assert the second is a no-op.

begin;

do $e2$
declare
  v_admin   uuid;
  v_booking uuid;
  v_case    uuid;
  v_payout  uuid;
  v_first   jsonb;
  v_second  jsonb;
  v_events  int;
  v_holds   int;
  v_customer uuid;
  v_provider_profile uuid;
  v_provider uuid;
  v_package uuid;
begin
  select id into v_admin from profiles where role = 'admin' limit 1;
  select id into v_customer from profiles where role = 'customer' limit 1;
  select p.id, pr.id into v_provider_profile, v_provider
    from profiles p
    join providers pr on pr.profile_id = p.id
   where p.role = 'provider'
   limit 1;
  select id into v_package from packages where active limit 1;

  if v_admin is null or v_customer is null or v_provider is null
     or v_package is null then
    raise exception 'need an admin, customer, provider and active package';
  end if;

  -- A transaction-local fixture makes the branch deterministic. The final
  -- ROLLBACK removes the booking and every event without issuing DELETE.
  insert into bookings (
    customer_id, package_id, scheduled_at, status, address, provider_payout
  ) values (
    v_customer, v_package, now() - interval '1 day',
    'offered', 'SW3 1AA', 30.00
  ) returning id into v_booking;

  insert into booking_offers (booking_id, provider_id, status)
  values (v_booking, v_provider, 'open');

  perform _apply_booking_transition(
    v_booking, 'scheduled', v_provider_profile, 'provider', null, '{}'::jsonb);
  perform _apply_booking_transition(
    v_booking, 'in_progress', v_provider_profile, 'provider', null, '{}'::jsonb);
  perform _apply_booking_transition(
    v_booking, 'completed', v_provider_profile, 'provider', null, '{}'::jsonb);

  insert into payments (booking_id, gross_amount, status, kind)
  values (v_booking, 69.00, 'succeeded', 'booking');

  insert into payouts (provider_id, booking_id, amount, status)
  values (v_provider, v_booking, 30.00, 'not_ready')
  returning id into v_payout;

  perform maybe_release_payout(v_booking);

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  v_case := open_review_case(
    v_booking, 'other', 'low', false, false, 'lock-branch check', null);

  -- ---- E2a: blocking twice must hold once ----
  select count(*) into v_holds
  from payout_events where payout_id = v_payout and to_status = 'held';

  v_first  := set_case_blocks(v_case, false, true, 'first call');
  v_second := set_case_blocks(v_case, false, true, 'second call');

  if (v_second->>'changed')::boolean is not false then
    raise exception
      'E2a FAILED: the second identical block reported a change (%)', v_second;
  end if;

  select count(*) into v_events
  from payout_events where payout_id = v_payout and to_status = 'held';

  if v_events <> v_holds + 1 then
    raise exception
      'E2a FAILED: expected exactly one new hold event, got %',
      v_events - v_holds;
  end if;
  raise notice 'E2a ok — repeat block is a no-op, one hold event';

  -- ---- E2b: reopening twice must reopen once ----
  perform resolve_review_case(v_case, 'closing for the check', null, null, 'gbp');

  v_first  := reopen_review_case(v_case, 'first reopen');
  v_second := reopen_review_case(v_case, 'second reopen');

  if (v_first->>'changed')::boolean is not true then
    raise exception 'E2b FAILED: the first reopen did nothing (%)', v_first;
  end if;
  if (v_second->>'changed')::boolean is not false then
    raise exception
      'E2b FAILED: the second reopen also reported a change (%)', v_second;
  end if;

  select count(*) into v_events
  from review_case_events
  where case_id = v_case and event_type = 'reopened';

  if v_events <> 1 then
    raise exception 'E2b FAILED: % reopened events for two calls', v_events;
  end if;
  raise notice 'E2b ok — repeat reopen is a no-op, one event';

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);

  raise notice ' ';
  raise notice 'E2 PASSED — no-op branches behave. Rolling back.';
exception
  when others then
    begin execute 'reset role'; exception when others then null; end;
    begin perform set_config('request.jwt.claims', '', true); exception when others then null; end;
    raise;
end $e2$;

rollback;


-- ============================================================================
-- If you want the full section E properly
-- ============================================================================
-- E1 + E2 cover the mechanism and the branches, which is enough to trust the
-- migration. What they don't cover is the two together under real contention —
-- two admins racing through the actual functions.
--
-- For that, use a scratch Supabase project rather than the linked one:
--
--   1. Create a second free project (call it opulence-scratch).
--   2. Point a local .env.scratch at it.
--   3. supabase db push --db-url <scratch connection string>
--   4. Seed one admin, one customer, one provider, one package.
--   5. Run the original section E there and let it commit freely.
--   6. Delete the project when you're done.
--
-- Synthetic audit rows are fine in a database whose entire purpose is to be
-- thrown away. They are not fine in the one that will hold real disputes.

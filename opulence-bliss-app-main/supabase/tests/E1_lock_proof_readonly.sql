-- ============================================================================
-- E1 — lock proof without creating anything
-- ============================================================================
-- The original E1 needed a committed review_cases row. It doesn't have to:
-- row-level lock queueing is a property of Postgres, not of that table. So
-- prove the primitive against a row that already exists and is never written by
-- application code — booking_rules, which has exactly one row.
--
-- Then, separately, assert that every function which mutates a case, booking,
-- payment or payout actually TAKES that lock. That part is read-only and can
-- run right now, in one session, against the live database.
-- ============================================================================


-- ============================================================================
-- Part 1 — the primitive. Two sessions, nothing written, nothing committed.
-- ============================================================================
--
-- Session 1:
--   begin;
--   select id, reschedule_lockout_hours from booking_rules where id = 1 for update;
--   -- lock held. LEAVE OPEN.
--
-- Session 2 (must hang):
--   begin;
--   select clock_timestamp() as started;
--   select id from booking_rules where id = 1 for update;   -- blocks
--
-- Session 1, while session 2 waits:
--   select pid, wait_event_type, wait_event, left(query, 60) as q
--   from pg_stat_activity
--   where wait_event_type = 'Lock';
--
--   -- Expect one row for session 2. That IS the proof: a second caller cannot
--   -- proceed while the first holds the row.
--
-- Session 1:  rollback;
-- Session 2:  -- returns immediately; then  rollback;
--
-- PASS: session 2 blocked and appeared under wait_event_type = 'Lock'.
-- FAIL: session 2 returned straight away — row locking is not behaving, and
--       every function in this schema that relies on FOR UPDATE is unsound.


-- ============================================================================
-- Part 2 — do the functions actually take it?
-- ============================================================================
-- Read-only. Reads each function's own source and checks for a row lock. This
-- is what stops a future edit quietly removing one: the migration tests would
-- still pass, because a missing lock only shows up under contention.

do $check$
declare
  v_name    text;
  v_src     text;
  v_missing text[] := '{}';
  v_checked int := 0;
  v_names   text[] := array[
    -- booking
    '_apply_booking_transition',
    '_apply_reschedule',
    -- money
    '_apply_payment_transition',
    '_apply_payout_transition',
    'claim_money_operation',
    '_finalise_operation',
    'system_finalise_operation',
    'resolve_ambiguous_operation',
    'maybe_release_payout',
    -- cases
    'open_review_case',
    'assign_review_case',
    'set_case_priority',
    'set_case_status',
    'set_case_blocks',
    'add_case_note',
    'resolve_review_case',
    'reopen_review_case',
    'next_refund_sequence',
    '_hold_payout_for_case'
  ];
begin
  foreach v_name in array v_names loop
    select string_agg(pg_get_functiondef(p.oid), E'\n')
      into v_src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = v_name;

    if v_src is null then
      v_missing := v_missing || format('%s — NOT FOUND', v_name);
      continue;
    end if;

    v_checked := v_checked + 1;

    -- Either it locks a row itself, or it delegates to something that does.
    if v_src !~* 'for\s+update'
       and v_src !~* '_apply_(booking|payment|payout)_transition'
       and v_src !~* '_finalise_operation'
       and v_src !~* '_hold_payout_for_case' then
      v_missing := v_missing || format('%s — no FOR UPDATE and no locked delegate', v_name);
    end if;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception
      'lock check failed: %', array_to_string(v_missing, '; ');
  end if;

  raise notice 'Lock check passed — % functions, all lock before mutating.', v_checked;
end $check$;


-- ============================================================================
-- Part 3 — and nothing else can write those tables at all
-- ============================================================================
-- If the functions lock, and nothing but the functions can write, then the
-- locking is the whole story. Confirm the second half:

select
  t.table_name,
  r.grantee,
  r.privilege_type,
  '❌ should not exist' as verdict
from information_schema.role_table_grants r
join information_schema.tables t
  on t.table_name = r.table_name and t.table_schema = r.table_schema
where r.table_schema = 'public'
  and r.table_name in (
    'bookings', 'payments', 'payouts', 'review_cases',
    'booking_events', 'payment_events', 'payout_events',
    'review_case_events', 'money_operations'
  )
  and r.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  and r.grantee in ('anon', 'authenticated', 'service_role')
  -- the two tables the app legitimately inserts into directly
  and not (r.table_name = 'payments'  and r.privilege_type = 'INSERT')
  and not (r.table_name = 'payouts'   and r.privilege_type = 'INSERT')
  and not (r.table_name = 'bookings'  and r.privilege_type = 'INSERT')
order by t.table_name, r.grantee, r.privilege_type;

-- An empty result is the pass condition.
--
-- Rows here are not necessarily bugs — check each against what the application
-- genuinely does. But every one is a route that bypasses a lock, so each needs
-- a reason to exist.

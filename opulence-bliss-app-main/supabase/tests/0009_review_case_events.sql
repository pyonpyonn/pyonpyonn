-- ============================================================================
-- 0009 — tests (review case events and locked operations)
-- ============================================================================
-- Runs in ONE transaction and ROLLS BACK. Needs an admin, a second admin, a
-- customer, a provider with a providers row, and an active package.
--
-- The second admin is only needed for the assignment test; that one skips
-- itself if there isn't one. Everything else always runs.
-- ============================================================================

begin;

create temp table t9 (k text primary key, v uuid) on commit drop;
grant select, insert on t9 to authenticated;

-- ---------------------------------------------------------------------------
-- Setup
-- ---------------------------------------------------------------------------
do $setup$
declare
  v_admin    uuid;
  v_admin2   uuid;
  v_customer uuid;
  v_provider uuid;
  v_prov_row uuid;
  v_pkg      uuid;
  v_booking  uuid;
  v_payout   uuid;
  v_case     uuid;
begin
  select id into v_admin from profiles where role = 'admin' order by created_at limit 1;
  select id into v_admin2 from profiles
   where role = 'admin' and id <> v_admin order by created_at limit 1;
  select id into v_customer from profiles where role = 'customer' limit 1;
  select p.id, pr.id into v_provider, v_prov_row
    from profiles p join providers pr on pr.profile_id = p.id
   where p.role = 'provider' limit 1;
  select id into v_pkg from packages where active limit 1;

  if v_admin is null or v_customer is null or v_provider is null or v_pkg is null then
    raise exception 'need an admin, a customer, a provider and an active package';
  end if;

  -- A completed, funded booking with a payout waiting to be released.
  insert into bookings (customer_id, package_id, scheduled_at, status, address,
                        provider_payout)
  values (v_customer, v_pkg, now() - interval '1 day', 'offered', 'SW3 1AA', 30.00)
  returning id into v_booking;

  insert into booking_offers (booking_id, provider_id, status)
  values (v_booking, v_prov_row, 'open');

  perform _apply_booking_transition(v_booking, 'scheduled',   v_provider, 'provider', null, '{}'::jsonb);
  perform _apply_booking_transition(v_booking, 'in_progress', v_provider, 'provider', null, '{}'::jsonb);
  perform _apply_booking_transition(v_booking, 'completed',   v_provider, 'provider', null, '{}'::jsonb);

  insert into payments (booking_id, gross_amount, status, kind)
  values (v_booking, 69.00, 'succeeded', 'booking');

  insert into payouts (provider_id, booking_id, amount, status)
  values (v_prov_row, v_booking, 30.00, 'not_ready')
  returning id into v_payout;

  perform maybe_release_payout(v_booking);   -- nothing blocks it yet → pending

  insert into t9 values
    ('admin', v_admin), ('customer', v_customer), ('provider', v_provider),
    ('booking', v_booking), ('payout', v_payout);
  if v_admin2 is not null then
    insert into t9 values ('admin2', v_admin2);
  end if;

  raise notice 'setup done — booking %, payout %', v_booking, v_payout;
end $setup$;


-- ===========================================================================
-- A. Nobody but an admin can touch a case
-- ===========================================================================
do $spoof$
declare
  v_customer uuid;
  v_provider uuid;
  v_booking  uuid;
  v_case     uuid;
  v_err      text;
  v_n        int;
begin
  raise notice '=== A. spoof resistance ===';

  select v into v_customer from t9 where k = 'customer';
  select v into v_provider from t9 where k = 'provider';
  select v into v_booking  from t9 where k = 'booking';

  -- A customer MAY raise a case on their own booking.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  v_case := open_review_case(
    v_booking, 'quality_complaint', 'normal', false, false,
    'The bathroom was missed', null);

  execute 'reset role';

  if v_case is null then
    raise exception 'A0 FAILED: a customer could not raise a case on their own booking';
  end if;
  if not exists (
    select 1 from review_case_events
     where case_id = v_case
       and event_type = 'opened'
       and actor_id = v_customer
       and actor_kind = 'customer'
  ) then
    raise exception 'A0 FAILED: participant-raised event was misattributed';
  end if;
  insert into t9 values ('case', v_case);
  raise notice '   ok — customer raised a case, attributed as customer';

  -- ...but may not run any desk operation on it.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  begin
    perform set_case_priority(v_case, 'urgent', 'because I said so');
    execute 'reset role';
    raise exception 'A1 FAILED: a customer changed a case priority';
  exception
    when insufficient_privilege then raise notice '   ok — priority refused';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'A1 FAILED%' then execute 'reset role'; raise; end if;
      raise notice '   ok — priority refused (%)', v_err;
  end;

  begin
    perform set_case_blocks(v_case, true, true, 'hold their money');
    execute 'reset role';
    raise exception 'A2 FAILED: a customer set the blocking flags';
  exception
    when insufficient_privilege then raise notice '   ok — blocks refused';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'A2 FAILED%' then execute 'reset role'; raise; end if;
      raise notice '   ok — blocks refused (%)', v_err;
  end;

  begin
    perform resolve_review_case(v_case, 'in my favour', null, 69.00, 'gbp');
    execute 'reset role';
    raise exception 'A3 FAILED: a customer resolved their own case';
  exception
    when insufficient_privilege then raise notice '   ok — resolve refused';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'A3 FAILED%' then execute 'reset role'; raise; end if;
      raise notice '   ok — resolve refused (%)', v_err;
  end;

  begin
    v_n := next_refund_sequence(v_case);
    execute 'reset role';
    raise exception 'A4 FAILED: a customer claimed a refund sequence';
  exception
    when insufficient_privilege then raise notice '   ok — refund sequence refused';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'A4 FAILED%' then execute 'reset role'; raise; end if;
      raise notice '   ok — refund sequence refused (%)', v_err;
  end;

  -- Direct writes are gone for everyone.
  begin
    update review_cases set blocks_payout = true where id = v_case;
    execute 'reset role';
    raise exception 'A5 FAILED: a direct UPDATE on review_cases succeeded';
  exception
    when insufficient_privilege then raise notice '   ok — direct write revoked';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'A5 FAILED%' then execute 'reset role'; raise; end if;
      raise notice '   ok — direct write blocked (%)', v_err;
  end;

  -- A provider on the booking may raise a case, but not on someone else's.
  execute 'reset role';
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_provider, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  begin
    perform add_case_note(v_case, 'sneaking a note in');
    execute 'reset role';
    raise exception 'A6 FAILED: a provider added a desk note';
  exception
    when insufficient_privilege then raise notice '   ok — provider note refused';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'A6 FAILED%' then execute 'reset role'; raise; end if;
      raise notice '   ok — provider note refused (%)', v_err;
  end;

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
exception
  when others then
    begin execute 'reset role'; exception when others then null; end;
    begin perform set_config('request.jwt.claims', '', true); exception when others then null; end;
    raise;
end $spoof$;


-- ===========================================================================
-- B. Blocking flags move money; unblocking does not
-- ===========================================================================
do $blocks$
declare
  v_admin  uuid;
  v_case   uuid;
  v_payout uuid;
  v_res    jsonb;
  v_status text;
  v_count  int;
begin
  raise notice '=== B. blocking flags ===';

  select v into v_admin  from t9 where k = 'admin';
  select v into v_case   from t9 where k = 'case';
  select v into v_payout from t9 where k = 'payout';

  select status into v_status from payouts where id = v_payout;
  if v_status <> 'pending' then
    raise exception 'B0 FAILED: expected a pending payout to start with, got %', v_status;
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  -- ---- B1: a reason is required ----
  begin
    perform set_case_blocks(v_case, false, true, null);
    execute 'reset role';
    raise exception 'B1 FAILED: blocks changed with no reason';
  exception
    when check_violation then raise notice '   ok — reason demanded';
    when others then
      declare v_err text;
      begin
        get stacked diagnostics v_err = message_text;
        if v_err like 'B1 FAILED%' then execute 'reset role'; raise; end if;
        raise notice '   ok — refused (%)', v_err;
      end;
  end;

  -- ---- B2: turning blocks_payout ON holds the money, in one transaction ----
  v_res := set_case_blocks(v_case, false, true, 'Client alleges damage');

  select status into v_status from payouts where id = v_payout;
  if v_status <> 'held' then
    raise exception 'B2 FAILED: payout is % after blocking, expected held', v_status;
  end if;
  if (v_res->'payout_hold'->>'held')::boolean is not true then
    raise exception 'B2 FAILED: hold not reported (%)', v_res;
  end if;
  raise notice '   ok — payout held atomically';

  -- ---- B3: a second case must not produce a duplicate hold ----
  declare
    v_case2 uuid;
    v_before int;
    v_after  int;
    v_booking uuid;
  begin
    select v into v_booking from t9 where k = 'booking';

    select count(*) into v_before from payout_events where payout_id = v_payout;

    v_case2 := open_review_case(
      v_booking, 'worker_no_show', 'urgent', true, true,
      'Conflicting account from the client', null);

    select count(*) into v_after from payout_events where payout_id = v_payout;

    if v_after <> v_before then
      raise exception
        'B3 FAILED: a second blocking case added % payout event(s)',
        v_after - v_before;
    end if;

    select status into v_status from payouts where id = v_payout;
    if v_status <> 'held' then
      raise exception 'B3 FAILED: payout left at % after a second case', v_status;
    end if;
    raise notice '   ok — second case, still one hold';

    insert into t9 values ('case2', v_case2);
  end;

  -- ---- B4: removing the block does NOT release the money ----
  v_res := set_case_blocks(v_case, false, false, 'Damage claim withdrawn');

  select status into v_status from payouts where id = v_payout;
  if v_status <> 'held' then
    raise exception
      'B4 FAILED: payout became % when a block was removed — release must be '
      'a separate decision', v_status;
  end if;
  if v_res->>'note' is null then
    raise exception 'B4 FAILED: the caller was not told the hold stays';
  end if;
  raise notice '   ok — hold survives unblocking';

  -- ---- B5: it is all on the record ----
  select count(*) into v_count
  from review_case_events
  where case_id = v_case and event_type = 'blocks_changed'
    and actor_id = v_admin and reason is not null;

  if v_count < 2 then
    raise exception 'B5 FAILED: expected two blocks_changed events, found %', v_count;
  end if;
  raise notice '   ok — % blocks_changed events, attributed', v_count;

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
exception
  when others then
    begin execute 'reset role'; exception when others then null; end;
    begin perform set_config('request.jwt.claims', '', true); exception when others then null; end;
    raise;
end $blocks$;


-- ===========================================================================
-- C. Resolve, reopen, notes, sequence
-- ===========================================================================
do $lifecycle$
declare
  v_admin   uuid;
  v_case    uuid;
  v_case2   uuid;
  v_booking uuid;
  v_res     jsonb;
  v_before  jsonb;
  v_count   int;
  v_a       int;
  v_b       int;
  v_err     text;
begin
  raise notice '=== C. lifecycle ===';

  select v into v_admin   from t9 where k = 'admin';
  select v into v_case    from t9 where k = 'case';
  select v into v_case2   from t9 where k = 'case2';
  select v into v_booking from t9 where k = 'booking';

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  -- ---- C1: notes append, and are events not columns ----
  perform add_case_note(v_case, 'Spoke to the client on the phone.');
  perform add_case_note(v_case, 'Provider sent photographs.');

  select count(*) into v_count
  from review_case_events
  where case_id = v_case and event_type = 'note_added';

  if v_count < 2 then
    raise exception 'C1 FAILED: expected at least two notes, found %', v_count;
  end if;

  if exists (
    select 1 from review_cases
     where id = v_case and resolution_notes = 'Provider sent photographs.'
  ) then
    raise exception 'C1 FAILED: a note was written to the legacy column';
  end if;
  raise notice '   ok — % notes, none in the legacy column', v_count;

  -- ---- C2: priority recomputes from opened_at, not from now ----
  declare
    v_due_before timestamptz;
    v_due_after  timestamptz;
    v_opened     timestamptz;
  begin
    select resolution_due_at, opened_at into v_due_before, v_opened
      from review_cases where id = v_case;

    perform set_case_priority(v_case, 'urgent', 'Client escalated');

    select resolution_due_at into v_due_after from review_cases where id = v_case;

    if v_due_after >= v_due_before then
      raise exception 'C2 FAILED: urgent did not shorten the deadline';
    end if;
    if v_due_after <> v_opened + interval '1 day' then
      raise exception
        'C2 FAILED: deadline runs from the wrong clock (% vs %)',
        v_due_after, v_opened + interval '1 day';
    end if;
    raise notice '   ok — SLA recomputed from opened_at';
  end;

  -- ---- C3: resolve, then the resolution is preserved on reopen ----
  perform resolve_review_case(
    v_case, 'No fault found', 'Photos reviewed with both parties', 15.00, 'gbp');

  if not exists (
    select 1 from review_cases
     where id = v_case and status = 'resolved' and resolved_by = v_admin
       and resolution_amount = 15.00
  ) then
    raise exception 'C3 FAILED: resolution not recorded properly';
  end if;
  raise notice '   ok — resolved and attributed';

  -- ---- C4: reopening is refused while another case blocks the category? ----
  -- (case2 is a different category, so this one should succeed)
  v_res := reopen_review_case(v_case, 'Client provided new evidence');
  if (v_res->>'changed')::boolean is not true then
    raise exception 'C4 FAILED: could not reopen (%)', v_res;
  end if;

  if exists (
    select 1 from review_cases
     where id = v_case
       and (resolution is not null or resolved_at is not null
            or resolved_by is not null or resolution_amount is not null)
  ) then
    raise exception 'C4 FAILED: resolution fields not cleared on reopen';
  end if;

  select before into v_before
  from review_case_events
  where case_id = v_case and event_type = 'reopened'
  order by created_at desc limit 1;

  if v_before is null
     or v_before->>'resolution' <> 'No fault found'
     or (v_before->>'resolution_amount')::numeric <> 15.00
     or v_before->>'resolved_by' is null then
    raise exception
      'C4 FAILED: the previous resolution was not preserved in the event (%)',
      v_before;
  end if;
  raise notice '   ok — reopened, prior resolution preserved in history';

  -- ---- C5: reopening must fail if the category is already occupied ----
  declare
    v_dup uuid;
  begin
    -- resolve, then open a NEW case of the same category, then try to reopen
    perform resolve_review_case(v_case, 'Closed again', null, null, 'gbp');

    v_dup := open_review_case(
      v_booking, 'quality_complaint', 'normal', false, false,
      'A fresh complaint about the same visit', null);

    if v_dup = v_case then
      raise exception 'C5 SETUP FAILED: expected a new case, got the old one';
    end if;

    begin
      perform reopen_review_case(v_case, 'trying to reopen the old one');
      execute 'reset role';
      raise exception
        'C5 FAILED: reopened a case while another unresolved one shares the category';
    exception
      when unique_violation then
        raise notice '   ok — reopen refused, category already occupied';
      when others then
        get stacked diagnostics v_err = message_text;
        if v_err like 'C5 FAILED%' then execute 'reset role'; raise; end if;
        raise notice '   ok — reopen refused (%)', v_err;
    end;
  end;

  -- ---- C6: refund sequence only moves through its function ----
  perform resolve_review_case(
    v_case2, 'Customer refund approved', null, 10.00, 'gbp');
  v_a := next_refund_sequence(v_case2);
  v_b := next_refund_sequence(v_case2);

  if v_b <> v_a + 1 then
    raise exception 'C6 FAILED: sequence not monotonic (%, %)', v_a, v_b;
  end if;

  select count(*) into v_count
  from review_case_events
  where case_id = v_case2 and event_type = 'refund_sequence_issued';
  if v_count <> 2 then
    raise exception 'C6 FAILED: expected two sequence events, found %', v_count;
  end if;

  begin
    update review_cases set refund_sequence = 0 where id = v_case2;
    execute 'reset role';
    raise exception 'C6 FAILED: reset the refund counter directly';
  exception
    when insufficient_privilege then
      raise notice '   ok — counter is function-only';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'C6 FAILED%' then execute 'reset role'; raise; end if;
      raise notice '   ok — direct counter write blocked (%)', v_err;
  end;

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);

  -- ---- C7: events cannot be rewritten or deleted ----
  begin
    update review_case_events set reason = 'tampered' where case_id = v_case;
    raise exception 'C7 FAILED: a case event was updated';
  exception
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'C7 FAILED%' then raise; end if;
      raise notice '   ok — event update blocked';
  end;

  begin
    delete from review_case_events where case_id = v_case;
    raise exception 'C7 FAILED: a case event was deleted';
  exception
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'C7 FAILED%' then raise; end if;
      raise notice '   ok — event delete blocked';
  end;

  raise notice ' ';
  raise notice 'ALL 0009 TESTS PASSED';
exception
  when others then
    begin execute 'reset role'; exception when others then null; end;
    begin perform set_config('request.jwt.claims', '', true); exception when others then null; end;
    raise;
end $lifecycle$;


-- ===========================================================================
-- D. Assignment can only go to an admin
-- ===========================================================================
do $assign$
declare
  v_admin    uuid;
  v_admin2   uuid;
  v_customer uuid;
  v_case     uuid;
  v_res      jsonb;
  v_err      text;
  v_owner    uuid;
  v_booking  uuid;
begin
  raise notice '=== D. assignment ===';

  select v into v_admin    from t9 where k = 'admin';
  select v into v_customer from t9 where k = 'customer';
  select v into v_booking  from t9 where k = 'booking';
  select v into v_admin2   from t9 where k = 'admin2';

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  v_case := open_review_case(
    v_booking, 'other', 'normal', false, false,
    'Assignment test case', null);

  -- D1: cannot park a case on a customer
  begin
    v_res := assign_review_case(v_case, v_customer);
    execute 'reset role';
    raise exception 'D1 FAILED: a case was assigned to a customer';
  exception
    when check_violation then raise notice '   ok — customers cannot own cases';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'D1 FAILED%' then execute 'reset role'; raise; end if;
      raise notice '   ok — refused (%)', v_err;
  end;

  -- D2: assigning to nobody means assigning to me — derived, not passed
  v_res := assign_review_case(v_case, null);
  select assigned_to into v_owner from review_cases where id = v_case;
  if v_owner is distinct from v_admin then
    raise exception 'D2 FAILED: assigned to % rather than the caller %',
      v_owner, v_admin;
  end if;
  raise notice '   ok — assigned to the authenticated admin';

  -- D3: handing it to another admin, if there is one
  if v_admin2 is null then
    raise notice '   SKIPPED — needs a second admin to test hand-off';
  else
    v_res := assign_review_case(v_case, v_admin2);
    select assigned_to into v_owner from review_cases where id = v_case;
    if v_owner is distinct from v_admin2 then
      raise exception 'D3 FAILED: hand-off did not take';
    end if;

    -- the EVENT still names who did it, not who received it
    if not exists (
      select 1 from review_case_events
       where case_id = v_case and event_type = 'assigned'
         and actor_id = v_admin
         and after->>'assigned_to' = v_admin2::text
    ) then
      raise exception 'D3 FAILED: the event did not attribute the hand-off correctly';
    end if;
    raise notice '   ok — handed over, attributed to the acting admin';
  end if;

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
exception
  when others then
    begin execute 'reset role'; exception when others then null; end;
    begin perform set_config('request.jwt.claims', '', true); exception when others then null; end;
    raise;
end $assign$;

rollback;


-- ============================================================================
-- E. Concurrency, across two sessions
-- ============================================================================
-- Row locking cannot be proved in one session. Two SQL Editor tabs can.
-- Replace <CASE>, <BOOKING> and <ADMIN>.
--
-- E1 — two admins reopening the same case
--
--   Session 1:
--     begin;
--     select set_config('request.jwt.claims',
--       json_build_object('sub','<ADMIN>','role','authenticated')::text, true);
--     set local role authenticated;
--     select reopen_review_case('<CASE>', 'first');
--     -- leave OPEN
--
--   Session 2 (blocks on the lock):
--     begin;
--     select set_config('request.jwt.claims',
--       json_build_object('sub','<ADMIN>','role','authenticated')::text, true);
--     set local role authenticated;
--     select reopen_review_case('<CASE>', 'second');
--
--   Session 1: commit;
--
--   Session 2 unblocks and must report changed = false ("already open").
--   Then confirm exactly one 'reopened' event exists:
--     select count(*) from review_case_events
--      where case_id = '<CASE>' and event_type = 'reopened';
--
-- E2 — two admins blocking the same booking at once
--
--   Same shape, both calling:
--     select set_case_blocks('<CASE>', false, true, 'concurrent');
--   on two DIFFERENT cases against the SAME booking.
--
--   Afterwards the payout must be 'held' with exactly ONE hold event:
--     select count(*) from payout_events pe
--      join payouts p on p.id = pe.payout_id
--     where p.booking_id = '<BOOKING>' and pe.to_status = 'held';
--
--   More than one means _hold_payout_for_case is not serialising.

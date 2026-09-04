-- ============================================================================
-- 0004/0005 — refund sequence and held-payout tests
-- ============================================================================
-- Runs in one transaction and rolls back. Requires an admin, customer,
-- provider and active package.

begin;

create temp table t4 (k text primary key, v uuid) on commit drop;

do $setup$
declare
  v_admin       uuid;
  v_customer    uuid;
  v_provider    uuid;
  v_provider_row uuid;
  v_package     uuid;
  v_booking     uuid;
  v_payout      uuid;
  v_hold_case   uuid;
  v_refund_case uuid;
begin
  select id into v_admin from profiles where role = 'admin' limit 1;
  select id into v_customer from profiles where role = 'customer' limit 1;
  select p.id, pr.id into v_provider, v_provider_row
    from profiles p
    join providers pr on pr.profile_id = p.id
   where p.role = 'provider'
   limit 1;
  select id into v_package from packages where active limit 1;

  if v_admin is null or v_customer is null or v_provider is null
     or v_provider_row is null or v_package is null then
    raise exception
      'tests need an admin, customer, provider and active package';
  end if;

  insert into bookings
    (customer_id, package_id, scheduled_at, status, address, provider_payout)
  values
    (v_customer, v_package, now() + interval '1 hour', 'offered',
     'SW3 1AA', 30.00)
  returning id into v_booking;

  insert into booking_offers (booking_id, provider_id, status)
  values (v_booking, v_provider_row, 'open');

  perform _apply_booking_transition(
    v_booking, 'scheduled', v_provider, 'provider', null, '{}'::jsonb);
  perform _apply_booking_transition(
    v_booking, 'in_progress', v_provider, 'provider', null, '{}'::jsonb);
  perform _apply_booking_transition(
    v_booking, 'completed', v_provider, 'provider', null, '{}'::jsonb);

  insert into payments
    (booking_id, gross_amount, status, kind, stripe_payment_ref)
  values (v_booking, 69.00, 'succeeded', 'booking', 'pi_test_0004_hold');

  insert into payouts (provider_id, booking_id, amount, status)
  values (v_provider_row, v_booking, 30.00, 'not_ready')
  returning id into v_payout;

  insert into review_cases
    (booking_id, category, priority, blocks_payment, blocks_payout,
     response_due_at, resolution_due_at)
  values
    (v_booking, 'damage_or_injury', 'urgent', false, true,
     now() + interval '1 hour', now() + interval '1 day')
  returning id into v_hold_case;

  -- Sequence tests need a distinct, already-resolved refund approval. The hold
  -- case must remain open until the payout assertions have run.
  insert into review_cases
    (booking_id, category, priority, status, blocks_payment, blocks_payout,
     resolution, resolution_amount, resolution_currency, resolved_at,
     resolved_by)
  values
    (v_booking, 'quality_complaint', 'high', 'resolved', false, false,
     'Partial refund approved', 10.00, 'gbp', now(), v_admin)
  returning id into v_refund_case;

  perform maybe_release_payout(v_booking);

  insert into t4 values
    ('admin', v_admin),
    ('customer', v_customer),
    ('booking', v_booking),
    ('payout', v_payout),
    ('hold_case', v_hold_case),
    ('refund_case', v_refund_case);
end $setup$;


-- A. Sequences are distinct and monotonic; callers must be admins.
do $seq$
declare
  v_admin    uuid;
  v_customer uuid;
  v_case     uuid;
  v_a        int;
  v_b        int;
  v_c        int;
  v_stored   int;
  v_error    text;
begin
  select v into v_admin from t4 where k = 'admin';
  select v into v_customer from t4 where k = 'customer';
  select v into v_case from t4 where k = 'refund_case';

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  v_a := next_refund_sequence(v_case);
  v_b := next_refund_sequence(v_case);
  v_c := next_refund_sequence(v_case);

  execute 'reset role';
  perform set_config('request.jwt.claims', '{}'::text, true);

  if v_a = v_b or v_b = v_c or v_a = v_c then
    raise exception 'A1 FAILED: duplicate sequence (%, %, %)', v_a, v_b, v_c;
  end if;
  if not (v_b = v_a + 1 and v_c = v_b + 1) then
    raise exception 'A1 FAILED: non-monotonic sequence (%, %, %)', v_a, v_b, v_c;
  end if;

  select refund_sequence into v_stored from review_cases where id = v_case;
  if v_stored <> v_c or v_stored <> 3 then
    raise exception 'A2 FAILED: stored counter %, latest %', v_stored, v_c;
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_customer, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  begin
    perform next_refund_sequence(v_case);
    raise exception 'A3 FAILED: customer claimed a refund sequence';
  exception
    when insufficient_privilege then null;
    when others then
      get stacked diagnostics v_error = message_text;
      if v_error like 'A3 FAILED%' then raise; end if;
      raise;
  end;

  execute 'reset role';
  perform set_config('request.jwt.claims', '{}'::text, true);
exception
  when others then
    begin execute 'reset role'; exception when others then null; end;
    perform set_config('request.jwt.claims', '{}'::text, true);
    raise;
end $seq$;


-- B/D. Holds survive readiness and resolution, and cannot be bypassed.
do $hold$
declare
  v_admin   uuid;
  v_case    uuid;
  v_payout  uuid;
  v_booking uuid;
  v_status  text;
  v_result  jsonb;
  v_error   text;
begin
  select v into v_admin from t4 where k = 'admin';
  select v into v_case from t4 where k = 'hold_case';
  select v into v_payout from t4 where k = 'payout';
  select v into v_booking from t4 where k = 'booking';

  -- B0: the blocking case held the payout in the first place.
  select status into v_status from payouts where id = v_payout;
  if v_status <> 'held' then
    raise exception 'B0 FAILED: expected held before resolution, got %', v_status;
  end if;

  -- B1: readiness never changes an existing hold.
  v_result := maybe_release_payout(v_booking);
  select status into v_status from payouts where id = v_payout;
  if (v_result->>'released')::boolean or v_status <> 'held' then
    raise exception 'B1 FAILED: readiness released held payout (% / %)',
      v_result, v_status;
  end if;

  -- D1: no second system path can bypass the unresolved blocking case.
  begin
    perform system_transition_payout(
      v_payout, 'pending', 'Attempted bypass', '{}'::jsonb);
    raise exception 'D1 FAILED: direct transition lifted a blocked payout';
  exception
    when check_violation then null;
    when others then
      get stacked diagnostics v_error = message_text;
      if v_error like 'D1 FAILED%' then raise; end if;
      raise;
  end;

  select status into v_status from payouts where id = v_payout;
  if v_status <> 'held' then
    raise exception 'D2 FAILED: rejected bypass changed status to %', v_status;
  end if;

  -- B2/B3: resolution records the admin but does not move the payout.
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  perform resolve_review_case(
    v_case,
    'Provider not at fault; no deduction',
    'Photos reviewed',
    null,
    'gbp'
  );

  execute 'reset role';
  perform set_config('request.jwt.claims', '{}'::text, true);

  select status into v_status from payouts where id = v_payout;
  if v_status <> 'held' then
    raise exception 'B2 FAILED: resolution changed payout to %', v_status;
  end if;

  if not exists (
    select 1 from review_cases
     where id = v_case and status = 'resolved' and resolved_by = v_admin
  ) then
    raise exception 'B3 FAILED: resolution was not attributed to the admin';
  end if;

  -- B4: only after resolution can the hold be lifted deliberately.
  perform system_transition_payout(
    v_payout,
    'pending',
    'Case resolved in the provider''s favour',
    '{}'::jsonb
  );

  select status into v_status from payouts where id = v_payout;
  if v_status <> 'pending' then
    raise exception 'B4 FAILED: hold remained % after explicit release', v_status;
  end if;
exception
  when others then
    begin execute 'reset role'; exception when others then null; end;
    perform set_config('request.jwt.claims', '{}'::text, true);
    raise;
end $hold$;

rollback;

-- Real contention requires two sessions: hold one transaction open after
-- next_refund_sequence(case_id), call it from a second authenticated-admin
-- transaction, then commit the first. The second must return n + 1.

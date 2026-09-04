-- 0004 — admin resolution tests. Runs in one transaction and rolls back.

begin;

create temp table t_admin_resolution_ids (
  k text primary key,
  v uuid not null
) on commit drop;

do $$
declare
  v_admin    uuid;
  v_customer uuid;
  v_package  uuid;
  v_booking  uuid;
  v_case     uuid;
  v_case2    uuid;
  v_finding  uuid;
begin
  select id into v_admin from profiles where role = 'admin' limit 1;
  select id into v_customer from profiles where role = 'customer' limit 1;
  select id into v_package from packages where active limit 1;

  if v_admin is null or v_customer is null or v_package is null then
    raise exception '0004 tests need one admin, customer and active package';
  end if;

  insert into bookings
    (customer_id, package_id, scheduled_at, status, address)
  values
    (v_customer, v_package, now() + interval '1 day', 'offered', 'SW3 1AA')
  returning id into v_booking;

  insert into payments
    (booking_id, kind, gross_amount, status, stripe_payment_ref)
  values
    (v_booking, 'booking', 100, 'succeeded', 'pi_0004_test');

  insert into review_cases
    (booking_id, category, priority, blocks_payment, blocks_payout)
  values
    (v_booking, 'quality_complaint', 'high', true, true)
  returning id into v_case;

  insert into review_cases
    (booking_id, category, priority)
  values
    (v_booking, 'other', 'normal')
  returning id into v_case2;

  insert into reconciliation_findings
    (finding_type, severity, booking_id, expected, actual)
  values
    ('refund_amount_mismatch', 'critical', v_booking,
     '{"amount_refunded_pence":2500}', '{"amount_refunded_pence":0}')
  returning id into v_finding;

  insert into t_admin_resolution_ids values
    ('admin', v_admin), ('customer', v_customer), ('booking', v_booking),
    ('case', v_case), ('case2', v_case2), ('finding', v_finding);
end $$;

-- Real authenticated-admin path: actor identity comes from auth.uid().
do $$
declare
  v_admin   uuid;
  v_case    uuid;
  v_case2   uuid;
  v_finding uuid;
  v_seq     int;
  v_count   int;
  v_error   text;
begin
  select v into v_admin from t_admin_resolution_ids where k = 'admin';
  select v into v_case from t_admin_resolution_ids where k = 'case';
  select v into v_case2 from t_admin_resolution_ids where k = 'case2';
  select v into v_finding from t_admin_resolution_ids where k = 'finding';

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  perform assign_review_case(v_case, null);
  perform resolve_review_case(v_case, 'Approve a partial refund', null, 25, 'gbp');
  v_seq := next_refund_sequence(v_case);
  if v_seq <> 1 then
    raise exception '0004 FAILED: first refund sequence was %', v_seq;
  end if;

  perform acknowledge_finding(v_finding);
  perform close_finding(v_finding, 'Matched to the approved case', false);

  select count(*) into v_count from admin_review_queue where id = v_case;
  if v_count <> 1 then
    raise exception '0004 FAILED: authenticated admin could not read queue';
  end if;

  begin
    perform resolve_review_case(v_case2, 'Too much', null, 101, 'gbp');
    raise exception '0004 FAILED: resolution exceeded the charge';
  exception
    when check_violation then null;
    when others then
      get stacked diagnostics v_error = message_text;
      if v_error like '0004 FAILED%' then raise; end if;
      raise;
  end;

  execute 'reset role';
  perform set_config('request.jwt.claims', '{}'::text, true);
exception
  when others then
    begin execute 'reset role'; exception when others then null; end;
    perform set_config('request.jwt.claims', '{}'::text, true);
    raise;
end $$;

do $$
declare
  v_case      uuid;
  v_finding   uuid;
  v_status    text;
  v_amount    numeric;
  v_remaining numeric;
  v_count     int;
  v_error     text;
begin
  select v into v_case from t_admin_resolution_ids where k = 'case';
  select v into v_finding from t_admin_resolution_ids where k = 'finding';

  select status, resolution_amount
    into v_status, v_amount
  from review_cases where id = v_case;
  if v_status <> 'resolved' or v_amount <> 25 then
    raise exception '0004 FAILED: case ended % with amount %', v_status, v_amount;
  end if;

  select count(*) into v_count
  from review_case_events where case_id = v_case;
  if v_count <> 3 then
    raise exception '0004 FAILED: expected 3 case events, found %', v_count;
  end if;

  select count(*) into v_count
  from reconciliation_finding_events where finding_id = v_finding;
  if v_count <> 2 then
    raise exception '0004 FAILED: expected 2 finding events, found %', v_count;
  end if;

  select refund_remaining into v_remaining
  from admin_review_queue where id = v_case;
  if v_remaining <> 25 then
    raise exception '0004 FAILED: view refund remaining was %', v_remaining;
  end if;

  begin
    update review_case_events set meta = '{}' where case_id = v_case;
    raise exception '0004 FAILED: case event was mutable';
  exception
    when others then
      get stacked diagnostics v_error = message_text;
      if v_error like '0004 FAILED%' then raise; end if;
  end;

  begin
    delete from reconciliation_finding_events where finding_id = v_finding;
    raise exception '0004 FAILED: finding event was deletable';
  exception
    when others then
      get stacked diagnostics v_error = message_text;
      if v_error like '0004 FAILED%' then raise; end if;
  end;
end $$;

-- A customer cannot invoke the admin functions or read an admin queue row.
do $$
declare
  v_customer uuid;
  v_case     uuid;
  v_count    int;
  v_error    text;
begin
  select v into v_customer from t_admin_resolution_ids where k = 'customer';
  select v into v_case from t_admin_resolution_ids where k = 'case';

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_customer, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  begin
    perform assign_review_case(v_case, null);
    raise exception '0004 FAILED: customer assigned an admin case';
  exception
    when insufficient_privilege then null;
    when others then
      get stacked diagnostics v_error = message_text;
      if v_error like '0004 FAILED%' then raise; end if;
      raise;
  end;

  begin
    select count(*) into v_count from admin_review_queue where id = v_case;
    if v_count <> 0 then
      raise exception '0004 FAILED: customer read the admin queue';
    end if;
  exception
    when insufficient_privilege then null; -- denial is also safe
  end;

  execute 'reset role';
  perform set_config('request.jwt.claims', '{}'::text, true);
exception
  when others then
    begin execute 'reset role'; exception when others then null; end;
    perform set_config('request.jwt.claims', '{}'::text, true);
    raise;
end $$;

rollback;

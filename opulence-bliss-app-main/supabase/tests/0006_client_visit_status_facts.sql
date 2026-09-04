-- 0006 — safe customer visit-status facts. Rolls back completely.

begin;

create temp table t6 (k text primary key, v uuid not null) on commit drop;

do $setup$
declare
  v_customer uuid;
  v_outsider uuid;
  v_package uuid;
  v_booking uuid;
begin
  select id into v_customer from profiles where role = 'customer' limit 1;
  v_outsider := gen_random_uuid();
  select id into v_package from packages where active limit 1;

  if v_customer is null or v_package is null then
    raise exception '0006 tests need one customer and one active package';
  end if;

  insert into bookings
    (customer_id, package_id, scheduled_at, status, address)
  values
    (v_customer, v_package, now() + interval '1 day', 'offered', 'SW3 1AA')
  returning id into v_booking;

  insert into review_cases
    (booking_id, category, priority, blocks_payment, blocks_payout,
     resolution_due_at, resolution_notes)
  values
    (v_booking, 'quality_complaint', 'high', true, false,
     now() + interval '3 days', 'must never be exposed');

  insert into t6 values
    ('customer', v_customer), ('outsider', v_outsider), ('booking', v_booking);
end $setup$;

do $customer$
declare
  v_customer uuid;
  v_booking uuid;
  v_row record;
begin
  select v into v_customer from t6 where k = 'customer';
  select v into v_booking from t6 where k = 'booking';

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_customer, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  select * into v_row from get_client_visit_status_facts(v_booking);

  if v_row.review_category <> 'quality_complaint'
     or v_row.review_status <> 'open'
     or not v_row.blocks_payment
     or v_row.blocks_payout then
    raise exception '0006 FAILED: customer received incorrect safe facts';
  end if;

  execute 'reset role';
  perform set_config('request.jwt.claims', '{}'::text, true);
exception
  when others then
    begin execute 'reset role'; exception when others then null; end;
    perform set_config('request.jwt.claims', '{}'::text, true);
    raise;
end $customer$;

do $outsider$
declare
  v_outsider uuid;
  v_booking uuid;
  v_error text;
begin
  select v into v_outsider from t6 where k = 'outsider';
  select v into v_booking from t6 where k = 'booking';

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_outsider, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  begin
    perform get_client_visit_status_facts(v_booking);
    raise exception '0006 FAILED: outsider read another customer''s facts';
  exception
    when insufficient_privilege then null;
    when others then
      get stacked diagnostics v_error = message_text;
      if v_error like '0006 FAILED%' then raise; end if;
      raise;
  end;

  execute 'reset role';
  perform set_config('request.jwt.claims', '{}'::text, true);
exception
  when others then
    begin execute 'reset role'; exception when others then null; end;
    perform set_config('request.jwt.claims', '{}'::text, true);
    raise;
end $outsider$;

rollback;

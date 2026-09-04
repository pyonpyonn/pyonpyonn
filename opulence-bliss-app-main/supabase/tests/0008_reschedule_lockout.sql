-- ============================================================================
-- 0008 — tests (reschedule lockout)
-- ============================================================================
-- Runs in ONE transaction and ROLLS BACK. Needs a customer, a provider (with a
-- providers row) and an admin profile, plus one active package.
-- ============================================================================

begin;

create temp table t8 (k text primary key, v uuid) on commit drop;

-- ---------------------------------------------------------------------------
-- Setup
-- ---------------------------------------------------------------------------
do $setup$
declare
  v_admin    uuid;
  v_customer uuid;
  v_provider uuid;
  v_prov_row uuid;
  v_pkg      uuid;
  v_far      uuid;   -- visit well outside the lockout
  v_near     uuid;   -- visit inside the lockout
  v_done     uuid;   -- already completed
begin
  select id into v_admin    from profiles where role = 'admin'    limit 1;
  select id into v_customer from profiles where role = 'customer' limit 1;
  select p.id, pr.id into v_provider, v_prov_row
    from profiles p join providers pr on pr.profile_id = p.id
   where p.role = 'provider' limit 1;
  select id into v_pkg from packages where active limit 1;

  if v_admin is null or v_customer is null or v_provider is null or v_pkg is null then
    raise exception 'need an admin, a customer, a provider and an active package';
  end if;

  -- Make sure we're testing against the documented 48 hours.
  update booking_rules
     set reschedule_lockout_hours = 48, min_notice_hours = 2
   where id = 1;

  -- 10 days out: comfortably reschedulable
  insert into bookings (customer_id, package_id, scheduled_at, status, address)
  values (v_customer, v_pkg, now() + interval '10 days', 'scheduled', 'SW3 1AA')
  returning id into v_far;

  -- 12 hours out: inside the 48-hour lockout
  insert into bookings (customer_id, package_id, scheduled_at, status, address)
  values (v_customer, v_pkg, now() + interval '12 hours', 'scheduled', 'SW3 1AA')
  returning id into v_near;

  -- finished: cannot move at all
  insert into bookings (customer_id, package_id, scheduled_at, status, address)
  values (v_customer, v_pkg, now() - interval '2 days', 'completed', 'SW3 1AA')
  returning id into v_done;

  update bookings set provider_id = v_prov_row where id in (v_far, v_near);

  insert into t8 values
    ('admin', v_admin), ('customer', v_customer), ('provider', v_provider),
    ('far', v_far), ('near', v_near), ('done', v_done);

  raise notice 'setup done — far %, near %', v_far, v_near;
end $setup$;


-- ===========================================================================
-- A. The customer's experience of the rule
-- ===========================================================================
do $cust$
declare
  v_customer uuid;
  v_far      uuid;
  v_near     uuid;
  v_done     uuid;
  v_res      jsonb;
  v_when     timestamptz;
  v_err      text;
begin
  raise notice '=== A. customer ===';

  select v into v_customer from t8 where k = 'customer';
  select v into v_far      from t8 where k = 'far';
  select v into v_near     from t8 where k = 'near';
  select v into v_done     from t8 where k = 'done';

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  -- ---- A1: outside the window, allowed ----
  v_res := reschedule_booking(v_far, now() + interval '12 days', null, '{}'::jsonb);
  if (v_res->>'changed')::boolean is not true then
    raise exception 'A1 FAILED: could not reschedule a visit 10 days out (%)', v_res;
  end if;

  select scheduled_at into v_when from bookings where id = v_far;
  if v_when < now() + interval '11 days' then
    raise exception 'A1 FAILED: time did not move (%)', v_when;
  end if;
  raise notice '   ok — moved freely outside the lockout';

  -- ---- A2: inside the window, refused ----
  begin
    v_res := reschedule_booking(v_near, now() + interval '5 days', null, '{}'::jsonb);
    execute 'reset role';
    raise exception 'A2 FAILED: rescheduled inside the 48-hour lockout';
  exception
    when check_violation then
      raise notice '   ok — refused inside the lockout';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'A2 FAILED%' then execute 'reset role'; raise; end if;
      raise notice '   ok — refused (%)', v_err;
  end;

  -- ---- A3: the refusal did not quietly change anything ----
  select scheduled_at into v_when from bookings where id = v_near;
  if v_when > now() + interval '1 day' then
    raise exception 'A3 FAILED: near booking moved despite the refusal (%)', v_when;
  end if;
  raise notice '   ok — nothing changed';

  -- ---- A4: the new time must still respect minimum notice ----
  begin
    v_res := reschedule_booking(v_far, now() + interval '30 minutes', null, '{}'::jsonb);
    execute 'reset role';
    raise exception 'A4 FAILED: accepted a slot 30 minutes away';
  exception
    when check_violation then raise notice '   ok — minimum notice enforced';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'A4 FAILED%' then execute 'reset role'; raise; end if;
      raise notice '   ok — refused (%)', v_err;
  end;

  -- ---- A5: a finished visit cannot move ----
  begin
    v_res := reschedule_booking(v_done, now() + interval '9 days', null, '{}'::jsonb);
    execute 'reset role';
    raise exception 'A5 FAILED: rescheduled a completed visit';
  exception
    when check_violation then raise notice '   ok — completed visits are fixed';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'A5 FAILED%' then execute 'reset role'; raise; end if;
      raise notice '   ok — refused (%)', v_err;
  end;

  -- ---- A6: the interface can be told the truth ----
  v_res := reschedule_window(v_far);
  if (v_res->>'can_reschedule')::boolean is not true then
    raise exception 'A6 FAILED: window says no for a visit 12 days out (%)', v_res;
  end if;
  if (v_res->>'lockout_hours')::int <> 48 then
    raise exception 'A6 FAILED: window reported % hours', v_res->>'lockout_hours';
  end if;

  v_res := reschedule_window(v_near);
  if (v_res->>'can_reschedule')::boolean is not false then
    raise exception 'A6 FAILED: window says yes inside the lockout (%)', v_res;
  end if;
  raise notice '   ok — window agrees with the enforcement';

  -- ---- A7: direct writes are shut off ----
  begin
    update bookings set scheduled_at = now() + interval '20 days' where id = v_far;
    execute 'reset role';
    raise exception 'A7 FAILED: wrote scheduled_at directly';
  exception
    when insufficient_privilege then
      raise notice '   ok — direct write revoked';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'A7 FAILED%' then execute 'reset role'; raise; end if;
      raise notice '   ok — direct write blocked (%)', v_err;
  end;

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
exception
  when others then
    begin execute 'reset role'; exception when others then null; end;
    begin perform set_config('request.jwt.claims', '', true); exception when others then null; end;
    raise;
end $cust$;


-- ===========================================================================
-- B. Providers cannot reschedule; admins can override
-- ===========================================================================
do $others$
declare
  v_provider uuid;
  v_admin    uuid;
  v_near     uuid;
  v_res      jsonb;
  v_err      text;
  v_count    int;
begin
  raise notice '=== B. provider and admin ===';

  select v into v_provider from t8 where k = 'provider';
  select v into v_admin    from t8 where k = 'admin';
  select v into v_near     from t8 where k = 'near';

  -- ---- B1: a provider must withdraw, not reschedule ----
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_provider, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  begin
    v_res := reschedule_booking(v_near, now() + interval '6 days', 'suits me better', '{}'::jsonb);
    execute 'reset role';
    raise exception 'B1 FAILED: a provider rescheduled a customer''s visit';
  exception
    when check_violation then raise notice '   ok — provider redirected to withdrawal';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'B1 FAILED%' then execute 'reset role'; raise; end if;
      raise notice '   ok — refused (%)', v_err;
  end;

  execute 'reset role';

  -- ---- B2: an admin needs a reason to override ----
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  begin
    v_res := reschedule_booking(v_near, now() + interval '6 days', null, '{}'::jsonb);
    execute 'reset role';
    raise exception 'B2 FAILED: admin overrode the lockout with no reason';
  exception
    when check_violation then raise notice '   ok — reason demanded of admins';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'B2 FAILED%' then execute 'reset role'; raise; end if;
      raise notice '   ok — refused (%)', v_err;
  end;

  -- ---- B3: with a reason, the override works ----
  v_res := reschedule_booking(
    v_near, now() + interval '6 days',
    'Customer rang in — provider agreed to the new time', '{}'::jsonb);

  if (v_res->>'changed')::boolean is not true then
    raise exception 'B3 FAILED: admin override did not take (%)', v_res;
  end if;
  raise notice '   ok — admin override applied';

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);

  -- ---- B4: and it is on the record, flagged as an override ----
  select count(*) into v_count
  from booking_events
  where booking_id = v_near
    and meta->>'event' = 'rescheduled'
    and (meta->>'overrode_lockout')::boolean is true
    and actor_id = v_admin
    and reason is not null;

  if v_count <> 1 then
    raise exception
      'B4 FAILED: expected one flagged override event, found %', v_count;
  end if;
  raise notice '   ok — override recorded with a reason and an author';

  -- ---- B5: the ordinary reschedule was recorded too, not flagged ----
  select count(*) into v_count
  from booking_events be
  join t8 t on t.k = 'far' and t.v = be.booking_id
  where be.meta->>'event' = 'rescheduled'
    and (be.meta->>'overrode_lockout')::boolean is false;

  if v_count < 1 then
    raise exception 'B5 FAILED: the in-window reschedule was not recorded';
  end if;
  raise notice '   ok — normal reschedule recorded, not flagged';

  raise notice ' ';
  raise notice 'ALL 0008 TESTS PASSED';
exception
  when others then
    begin execute 'reset role'; exception when others then null; end;
    begin perform set_config('request.jwt.claims', '', true); exception when others then null; end;
    raise;
end $others$;

-- ============================================================================
-- C. The rule is data, so prove it can be changed
-- ============================================================================
-- The client may not want 48 hours. Confirm the same function immediately
-- follows a changed rule without an application deployment.
do $config$
declare
  v_customer uuid;
  v_pkg      uuid;
  v_booking  uuid;
  v_res      jsonb;
begin
  select v into v_customer from t8 where k = 'customer';
  select id into v_pkg from packages where active limit 1;

  update booking_rules
     set reschedule_lockout_hours = 4, updated_at = now()
   where id = 1;

  insert into bookings (customer_id, package_id, scheduled_at, status, address)
  values (v_customer, v_pkg, now() + interval '12 hours', 'scheduled', 'SW3 1AA')
  returning id into v_booking;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_customer, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  v_res := reschedule_window(v_booking);
  if (v_res->>'can_reschedule')::boolean is not true
     or (v_res->>'lockout_hours')::int <> 4 then
    raise exception 'C1 FAILED: configurable window did not follow the rule (%)',
      v_res;
  end if;

  execute 'reset role';
  perform set_config('request.jwt.claims', '{}'::text, true);
  raise notice '   ok — changing the data changed the enforced window';
exception
  when others then
    begin execute 'reset role'; exception when others then null; end;
    perform set_config('request.jwt.claims', '{}'::text, true);
    raise;
end $config$;

rollback;

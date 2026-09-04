-- 0007 — re-broadcast and participant exception tests. Rolls back.

begin;

create temp table t7 (k text primary key, v uuid not null) on commit drop;

do $setup$
declare
  v_customer uuid;
  v_provider_profile uuid;
  v_other_profile uuid;
  v_provider uuid;
  v_other_provider uuid;
  v_package uuid;
  v_rebroadcast uuid;
  v_no_show uuid;
  v_early uuid;
begin
  select id into v_customer from profiles where role = 'customer' limit 1;
  select p.id, pr.id into v_provider_profile, v_provider
    from profiles p join providers pr on pr.profile_id = p.id
   where p.role = 'provider' order by p.id limit 1;
  select p.id, pr.id into v_other_profile, v_other_provider
    from profiles p join providers pr on pr.profile_id = p.id
   where p.role = 'provider' and p.id <> v_provider_profile
   order by p.id limit 1;
  select id into v_package from packages where active limit 1;

  if v_customer is null or v_provider is null or v_other_provider is null
     or v_package is null then
    raise exception '0007 tests need a customer, two providers and a package';
  end if;

  insert into bookings
    (customer_id, package_id, scheduled_at, status, address, offer_expires_at)
  values
    (v_customer, v_package, now() + interval '2 hours', 'offered', 'SW3 1AA',
     now() + interval '1 hour')
  returning id into v_rebroadcast;

  insert into booking_offers (booking_id, provider_id, status)
  values
    (v_rebroadcast, v_provider, 'open'),
    (v_rebroadcast, v_other_provider, 'open');

  perform _apply_booking_transition(
    v_rebroadcast, 'scheduled', v_provider_profile, 'provider', null, '{}'::jsonb
  );
  -- Simulate a stale open row from another offer delivery.
  update booking_offers
     set status = 'open'
   where booking_id = v_rebroadcast and provider_id = v_other_provider;

  insert into payments
    (booking_id, kind, gross_amount, status, stripe_payment_ref)
  values
    (v_rebroadcast, 'booking', 69, 'authorised', 'pi_test_0007_rebroadcast');

  insert into bookings
    (customer_id, package_id, scheduled_at, status, address)
  values
    (v_customer, v_package, now() - interval '30 minutes', 'offered', 'SW3 1AA')
  returning id into v_no_show;
  insert into booking_offers (booking_id, provider_id, status)
  values (v_no_show, v_provider, 'open');
  perform _apply_booking_transition(
    v_no_show, 'scheduled', v_provider_profile, 'provider', null, '{}'::jsonb
  );

  insert into bookings
    (customer_id, package_id, scheduled_at, status, address)
  values
    (v_customer, v_package, now() + interval '2 hours', 'offered', 'SW3 1AA')
  returning id into v_early;
  insert into booking_offers (booking_id, provider_id, status)
  values (v_early, v_provider, 'open');
  perform _apply_booking_transition(
    v_early, 'scheduled', v_provider_profile, 'provider', null, '{}'::jsonb
  );

  insert into t7 values
    ('customer', v_customer),
    ('provider_profile', v_provider_profile),
    ('other_profile', v_other_profile),
    ('provider', v_provider),
    ('other_provider', v_other_provider),
    ('rebroadcast', v_rebroadcast),
    ('no_show', v_no_show),
    ('early', v_early);
end $setup$;

do $rebroadcast$
declare
  v_actor uuid;
  v_other_actor uuid;
  v_provider uuid;
  v_other_provider uuid;
  v_booking uuid;
  v_expiry timestamptz := now() + interval '45 minutes';
  v_status text;
  v_assigned uuid;
  v_offer text;
  v_payment text;
  v_error text;
begin
  select v into v_actor from t7 where k = 'provider_profile';
  select v into v_other_actor from t7 where k = 'other_profile';
  select v into v_provider from t7 where k = 'provider';
  select v into v_other_provider from t7 where k = 'other_provider';
  select v into v_booking from t7 where k = 'rebroadcast';

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_actor, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';
  perform transition_booking(
    v_booking,
    'offered',
    'Provider cannot attend',
    jsonb_build_object('offer_expires_at', v_expiry)
  );
  execute 'reset role';
  perform set_config('request.jwt.claims', '{}'::text, true);

  select status::text, provider_id, offer_expires_at
    into v_status, v_assigned, v_expiry
    from bookings where id = v_booking;
  if v_status <> 'offered' or v_assigned is not null then
    raise exception '0007 A1 FAILED: booking was % / provider %',
      v_status, v_assigned;
  end if;

  select status into v_offer from booking_offers
   where booking_id = v_booking and provider_id = v_provider;
  if v_offer <> 'declined' then
    raise exception '0007 A2 FAILED: leaving offer is %', v_offer;
  end if;
  select status into v_offer from booking_offers
   where booking_id = v_booking and provider_id = v_other_provider;
  if v_offer <> 'lost' then
    raise exception '0007 A3 FAILED: stale offer is %', v_offer;
  end if;

  select status into v_payment from payments where booking_id = v_booking;
  if v_payment <> 'authorised' then
    raise exception '0007 A4 FAILED: payment changed to %', v_payment;
  end if;

  -- An unrelated provider cannot turn an already-offered booking into a
  -- successful-looking no-op.
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_other_actor, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';
  begin
    perform transition_booking(v_booking, 'offered');
    raise exception '0007 A5 FAILED: unrelated provider received a no-op';
  exception
    when insufficient_privilege then null;
    when others then
      get stacked diagnostics v_error = message_text;
      if v_error like '0007 A5 FAILED%' then raise; end if;
      raise;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '{}'::text, true);
exception
  when others then
    begin execute 'reset role'; exception when others then null; end;
    perform set_config('request.jwt.claims', '{}'::text, true);
    raise;
end $rebroadcast$;

do $exception$
declare
  v_customer uuid;
  v_no_show uuid;
  v_early uuid;
  v_new_slot timestamptz := now() + interval '3 days';
  v_status text;
  v_provider uuid;
  v_error text;
begin
  select v into v_customer from t7 where k = 'customer';
  select v into v_no_show from t7 where k = 'no_show';
  select v into v_early from t7 where k = 'early';

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_customer, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  -- The database itself refuses an early no-show.
  begin
    perform report_booking_exception(
      v_early, 'worker_no_show', 'Too early', 'Too early', '{}'::jsonb
    );
    raise exception '0007 B1 FAILED: early no-show was accepted';
  exception
    when check_violation then null;
    when others then
      get stacked diagnostics v_error = message_text;
      if v_error like '0007 B1 FAILED%' then raise; end if;
      raise;
  end;

  -- Existing customer rescheduling still updates the slot and reopens the
  -- accepted provider offer.
  perform transition_booking(
    v_early,
    'offered',
    'Customer selected another time',
    jsonb_build_object('scheduled_at', v_new_slot)
  );

  select status::text, provider_id into v_status, v_provider
    from bookings where id = v_early;
  if v_status <> 'offered' or v_provider is not null then
    raise exception '0007 B2 FAILED: reschedule ended % / provider %',
      v_status, v_provider;
  end if;
  if not exists (
    select 1 from bookings
     where id = v_early and scheduled_at = v_new_slot
  ) then
    raise exception '0007 B3 FAILED: reschedule did not update the slot';
  end if;

  -- Transition and blocking case are committed atomically.
  perform report_booking_exception(
    v_no_show,
    'worker_no_show',
    'Customer reports no arrival',
    'Customer waited past the grace period',
    '{}'::jsonb
  );

  -- Participant RLS intentionally hides review_cases (including internal
  -- notes), so inspect the atomic result as the migration owner.
  execute 'reset role';
  perform set_config('request.jwt.claims', '{}'::text, true);

  if not exists (
    select 1 from bookings where id = v_no_show and status = 'needs_review'
  ) then
    raise exception '0007 B4 FAILED: booking did not enter review';
  end if;
  if not exists (
    select 1 from review_cases
     where booking_id = v_no_show
       and category = 'worker_no_show'
       and status <> 'resolved'
       and blocks_payment
       and blocks_payout
       and created_by = v_customer
  ) then
    raise exception '0007 B5 FAILED: blocking case missing or misattributed';
  end if;

  -- Generic participant transitions cannot bypass atomic case creation.
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_customer, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';
  begin
    perform transition_booking(v_no_show, 'needs_review', 'direct bypass');
    raise exception '0007 B6 FAILED: direct review transition was accepted';
  exception
    when check_violation then null;
    when others then
      get stacked diagnostics v_error = message_text;
      if v_error like '0007 B6 FAILED%' then raise; end if;
      raise;
  end;

  -- A system sweeper cannot cancel through the open blocking case.
  -- Run this assertion as the migration owner: authenticated callers cannot
  -- execute the private transition core directly, by design.
  execute 'reset role';
  perform set_config('request.jwt.claims', '{}'::text, true);
  begin
    perform _apply_booking_transition(
      v_no_show, 'cancelled', null, 'system', 'expiry', '{}'::jsonb
    );
    raise exception '0007 B7 FAILED: system cancelled through blocking case';
  exception
    when check_violation then null;
    when others then
      get stacked diagnostics v_error = message_text;
      if v_error like '0007 B7 FAILED%' then raise; end if;
      raise;
  end;

  execute 'reset role';
  perform set_config('request.jwt.claims', '{}'::text, true);
exception
  when others then
    begin execute 'reset role'; exception when others then null; end;
    perform set_config('request.jwt.claims', '{}'::text, true);
    raise;
end $exception$;

rollback;

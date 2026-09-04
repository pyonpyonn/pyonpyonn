-- Sequential offer cadence/advance and OTP check-in integration.
-- Safe on a linked project: every synthetic row is rolled back.

begin;

do $test$
declare
  v_customer uuid;
  v_package uuid;
  v_provider_ids uuid[];
  v_provider_profile uuid;
  v_booking uuid;
  v_otp_booking uuid;
  v_result jsonb;
  v_delivery jsonb;
  v_open_count integer;
  v_first_provider uuid;
  v_second_provider uuid;
begin
  select id into v_customer
    from public.profiles
   where role = 'customer'
   limit 1;

  select id into v_package from public.packages limit 1;

  select array_agg(id order by id) into v_provider_ids
    from (select id from public.providers order by id limit 2) candidates;

  if v_customer is null or v_package is null
     or coalesce(array_length(v_provider_ids, 1), 0) < 2 then
    raise exception '0012 needs one customer, one package and two providers';
  end if;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  insert into public.bookings
    (customer_id, package_id, scheduled_at, status, address, offer_expires_at)
  values
    (v_customer, v_package, now() + interval '8 days', 'offered', 'SW3 1AA',
     now() + interval '7 days 22 hours')
  returning id into v_booking;

  v_result := public.system_seed_booking_offer_queue(v_booking, v_provider_ids);
  if (v_result->>'cadence_minutes')::integer <> 60 then
    raise exception 'expected 60-minute cadence, got %', v_result;
  end if;

  v_result := public.system_rotate_booking_offer(v_booking);
  if v_result->>'action' <> 'activated'
     or (v_result->>'cadence_minutes')::integer <> 60 then
    raise exception 'first provider was not activated correctly: %', v_result;
  end if;

  select count(*)
    into v_open_count
    from public.booking_offers
   where booking_id = v_booking and status = 'open';

  if v_open_count <> 1 then
    raise exception 'expected exactly one open offer, found %', v_open_count;
  end if;

  select provider_id into v_first_provider
    from public.booking_offers
   where booking_id = v_booking and status = 'open';

  update public.booking_offers
     set status = 'declined'
   where booking_id = v_booking and provider_id = v_first_provider;

  v_result := public.system_rotate_booking_offer(v_booking);
  if v_result->>'action' <> 'activated' then
    raise exception 'decline did not advance immediately: %', v_result;
  end if;

  select provider_id into v_second_provider
    from public.booking_offers
   where booking_id = v_booking and status = 'open';

  if v_second_provider is null or v_second_provider = v_first_provider then
    raise exception 'rotation did not move to a different provider';
  end if;

  select p.profile_id into v_provider_profile
    from public.providers p
    join public.profiles profile on profile.id = p.profile_id
   where profile.role = 'provider'
   limit 1;

  if v_provider_profile is null then
    raise exception '0012 needs a provider profile for OTP verification';
  end if;

  insert into public.bookings
    (customer_id, provider_id, package_id, scheduled_at, status, address,
     offer_expires_at)
  select
    v_customer, p.id, v_package, now(), 'scheduled', 'SW3 1AA', now() + interval '1 hour'
    from public.providers p
   where p.profile_id = v_provider_profile
  returning id into v_otp_booking;

  v_result := public.request_checkin_challenge(
    v_otp_booking, v_provider_profile, 51.4900, -0.1600, 25
  );
  v_delivery := public.system_get_checkin_code((v_result->>'challenge_id')::uuid);

  if coalesce(v_delivery->>'code', '') !~ '^[0-9]{6}$' then
    raise exception 'OTP delivery did not return six digits: %', v_delivery;
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'authenticated', 'sub', v_customer)::text,
    true
  );

  v_result := public.customer_checkin_code(v_otp_booking);
  if coalesce((v_result->>'active')::boolean, false) is not true
     or v_result->>'code' is distinct from v_delivery->>'code' then
    raise exception 'customer could not see the active booking OTP: %', v_result;
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'authenticated', 'sub', v_provider_profile)::text,
    true
  );

  v_result := public.verify_checkin_challenge(v_otp_booking, v_delivery->>'code');
  if coalesce((v_result->>'ok')::boolean, false) is not true then
    raise exception 'valid OTP did not check in: %', v_result;
  end if;

  if not exists (
    select 1 from public.bookings
     where id = v_otp_booking and status::text = 'in_progress'
  ) or not exists (
    select 1 from public.check_ins
     where booking_id = v_otp_booking and geofence_pass is true
  ) then
    raise exception 'OTP did not atomically transition and record check-in';
  end if;
end
$test$;

rollback;

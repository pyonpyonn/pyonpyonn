-- Keep OTP verification in the development check-in path and expose an active
-- code only to the customer who owns the booking.

alter table public.check_in_challenges
  add column if not exists geofence_pass boolean not null default true;

create or replace function public.request_checkin_challenge(
  p_booking_id uuid,
  p_provider_profile_id uuid,
  p_gps_lat numeric,
  p_gps_lng numeric,
  p_distance_metres integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_provider_id uuid;
  v_booking public.bookings;
  v_challenge public.check_in_challenges;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = 'insufficient_privilege';
  end if;

  select id into v_provider_id
    from public.providers
   where profile_id = p_provider_profile_id;

  if v_provider_id is null then
    raise exception 'provider account required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_booking
    from public.bookings
   where id = p_booking_id
   for update;

  if not found
     or v_booking.provider_id is distinct from v_provider_id
     or v_booking.status::text <> 'scheduled' then
    raise exception 'this booking is not ready for your check-in'
      using errcode = 'check_violation';
  end if;

  for v_challenge in
    select *
      from public.check_in_challenges
     where booking_id = p_booking_id
       and status = 'pending'
       and expires_at <= now()
     for update
  loop
    update public.check_in_challenges
       set status = 'expired'
     where id = v_challenge.id;
    insert into public.check_in_challenge_events
      (challenge_id, booking_id, event_type, actor_kind, meta)
    values
      (v_challenge.id, p_booking_id, 'expired', 'system', '{}'::jsonb);
  end loop;

  select * into v_challenge
    from public.check_in_challenges
   where booking_id = p_booking_id
     and status = 'pending'
   order by requested_at desc
   limit 1
   for update;

  if found then
    return jsonb_build_object(
      'challenge_id', v_challenge.id,
      'expires_at', v_challenge.expires_at,
      'newly_created', false
    );
  end if;

  select * into v_challenge
    from public.check_in_challenges
   where booking_id = p_booking_id
     and status = 'locked'
     and expires_at > now()
   order by requested_at desc
   limit 1
   for update;

  if found then
    return jsonb_build_object(
      'challenge_id', v_challenge.id,
      'expires_at', v_challenge.expires_at,
      'newly_created', false,
      'locked', true
    );
  end if;

  insert into public.check_in_challenges
    (booking_id, provider_id, gps_lat, gps_lng, distance_metres,
     geofence_pass, expires_at)
  values
    (p_booking_id, v_provider_id, p_gps_lat, p_gps_lng, p_distance_metres,
     coalesce(p_distance_metres <= 500, false), now() + interval '10 minutes')
  returning * into v_challenge;

  insert into public.check_in_challenge_events
    (challenge_id, booking_id, event_type, actor_id, actor_kind, meta)
  values
    (v_challenge.id, p_booking_id, 'requested', p_provider_profile_id, 'provider',
     jsonb_build_object(
       'distance_metres', p_distance_metres,
       'geofence_pass', v_challenge.geofence_pass
     ));

  return jsonb_build_object(
    'challenge_id', v_challenge.id,
    'expires_at', v_challenge.expires_at,
    'newly_created', true
  );
end
$fn$;

revoke all on function public.request_checkin_challenge(uuid, uuid, numeric, numeric, integer)
  from public, anon, authenticated;
grant execute on function public.request_checkin_challenge(uuid, uuid, numeric, numeric, integer)
  to service_role;

create or replace function public.verify_checkin_challenge(
  p_booking_id uuid,
  p_code text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_provider_id uuid;
  v_booking public.bookings;
  v_challenge public.check_in_challenges;
  v_remaining integer;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  select id into v_provider_id
    from public.providers
   where profile_id = v_uid;

  select * into v_booking
    from public.bookings
   where id = p_booking_id
   for update;

  if not found
     or v_provider_id is null
     or v_booking.provider_id is distinct from v_provider_id
     or v_booking.status::text <> 'scheduled' then
    return jsonb_build_object('ok', false, 'reason', 'This booking cannot be checked in.');
  end if;

  select * into v_challenge
    from public.check_in_challenges
   where booking_id = p_booking_id
     and provider_id = v_provider_id
     and status = 'pending'
   order by requested_at desc
   limit 1
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'Request a new code from the client.');
  end if;

  if v_challenge.expires_at <= now() then
    update public.check_in_challenges set status = 'expired' where id = v_challenge.id;
    insert into public.check_in_challenge_events
      (challenge_id, booking_id, event_type, actor_kind, meta)
    values
      (v_challenge.id, p_booking_id, 'expired', 'system', '{}'::jsonb);
    return jsonb_build_object('ok', false, 'reason', 'That code expired. Request a new one.');
  end if;

  if coalesce(trim(p_code), '') !~ '^[0-9]{6}$'
     or trim(p_code) <> public._checkin_otp(v_challenge.secret_seed) then
    v_remaining := greatest(v_challenge.attempts_remaining - 1, 0);
    update public.check_in_challenges
       set attempts_remaining = v_remaining,
           status = case when v_remaining = 0 then 'locked' else 'pending' end
     where id = v_challenge.id;

    insert into public.check_in_challenge_events
      (challenge_id, booking_id, event_type, actor_id, actor_kind, meta)
    values
      (v_challenge.id, p_booking_id,
       case when v_remaining = 0 then 'locked' else 'attempt_failed' end,
       v_uid, 'provider', jsonb_build_object('attempts_remaining', v_remaining));

    return jsonb_build_object(
      'ok', false,
      'reason', case
                  when v_remaining = 0 then 'Too many incorrect attempts. Request a new code.'
                  else format('Incorrect code. %s attempt%s left.', v_remaining,
                              case when v_remaining = 1 then '' else 's' end)
                end,
      'attempts_remaining', v_remaining
    );
  end if;

  perform public.transition_booking(
    p_booking_id,
    'in_progress',
    null,
    jsonb_build_object(
      'geofence_pass', v_challenge.geofence_pass,
      'distance_metres', v_challenge.distance_metres,
      'otp_verified', true,
      'challenge_id', v_challenge.id
    )
  );

  insert into public.check_ins
    (booking_id, arrived_at, gps_lat, gps_lng, geofence_pass)
  values
    (p_booking_id, now(), v_challenge.gps_lat, v_challenge.gps_lng,
     v_challenge.geofence_pass);

  update public.check_in_challenges
     set status = 'verified', verified_at = now()
   where id = v_challenge.id;

  insert into public.check_in_challenge_events
    (challenge_id, booking_id, event_type, actor_id, actor_kind, meta)
  values
    (v_challenge.id, p_booking_id, 'verified', v_uid, 'provider',
     jsonb_build_object(
       'distance_metres', v_challenge.distance_metres,
       'geofence_pass', v_challenge.geofence_pass
     ));

  return jsonb_build_object('ok', true, 'reason', 'Code confirmed — job started.');
end
$fn$;

revoke all on function public.verify_checkin_challenge(uuid, text)
  from public, anon;
grant execute on function public.verify_checkin_challenge(uuid, text)
  to authenticated;

create or replace function public.customer_checkin_code(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_booking public.bookings;
  v_challenge public.check_in_challenges;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  select * into v_booking
    from public.bookings
   where id = p_booking_id;

  if not found or v_booking.customer_id is distinct from v_uid then
    raise exception 'this is not your booking' using errcode = 'insufficient_privilege';
  end if;

  select * into v_challenge
    from public.check_in_challenges
   where booking_id = p_booking_id
     and status = 'pending'
     and expires_at > now()
   order by requested_at desc
   limit 1;

  if not found then
    return jsonb_build_object('active', false);
  end if;

  return jsonb_build_object(
    'active', true,
    'code', public._checkin_otp(v_challenge.secret_seed),
    'expires_at', v_challenge.expires_at,
    'requested_at', v_challenge.requested_at
  );
end
$fn$;

revoke all on function public.customer_checkin_code(uuid)
  from public, anon, service_role;
grant execute on function public.customer_checkin_code(uuid)
  to authenticated;


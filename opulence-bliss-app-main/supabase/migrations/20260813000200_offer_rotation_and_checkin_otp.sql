-- Sequential provider offers and GPS-gated client OTP check-in.
--
-- Offer cadence:
--   7+ days before the visit  -> 60 minutes per provider
--   3-7 days before the visit -> 30 minutes per provider
--   under 3 days              -> 15 minutes per provider
--
-- The scheduler may run every five minutes. The per-offer respond_by value is
-- authoritative, so a frequent scheduler does not shorten a provider's turn.

-- ============================================================================
-- 1. One private queue per booking
-- ============================================================================

create table if not exists public.booking_offer_runs (
  booking_id       uuid primary key references public.bookings(id) on delete cascade,
  cadence_minutes  integer not null check (cadence_minutes in (15, 30, 60)),
  started_at       timestamptz not null default now(),
  exhausted_at     timestamptz,
  created_at       timestamptz not null default now()
);

create table if not exists public.booking_offer_queue (
  id               uuid primary key default gen_random_uuid(),
  booking_id       uuid not null references public.bookings(id) on delete cascade,
  provider_id      uuid not null references public.providers(id) on delete cascade,
  queue_position   integer not null check (queue_position > 0),
  outcome          text not null default 'waiting'
                   check (outcome in ('waiting', 'offered', 'accepted', 'declined', 'expired', 'lost')),
  activated_at     timestamptz,
  respond_by       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),
  unique (booking_id, provider_id),
  unique (booking_id, queue_position)
);

create index if not exists booking_offer_queue_next_idx
  on public.booking_offer_queue (booking_id, queue_position)
  where outcome = 'waiting';

create index if not exists booking_offer_queue_due_idx
  on public.booking_offer_queue (respond_by)
  where outcome = 'offered';

alter table public.booking_offer_runs enable row level security;
alter table public.booking_offer_queue enable row level security;

revoke all on public.booking_offer_runs from public, anon, authenticated, service_role;
revoke all on public.booking_offer_queue from public, anon, authenticated, service_role;

create or replace function public._offer_response_minutes(p_scheduled_at timestamptz)
returns integer
language sql
stable
set search_path = public
as $fn$
  select case
    when p_scheduled_at - now() >= interval '7 days' then 60
    when p_scheduled_at - now() >= interval '3 days' then 30
    else 15
  end
$fn$;

revoke all on function public._offer_response_minutes(timestamptz)
  from public, anon, authenticated, service_role;

-- Replace any previous queue and stage the candidates. This intentionally
-- does not widen geography: callers supply only providers who already passed
-- the existing service-area, service, approval and fee checks.
create or replace function public.system_seed_booking_offer_queue(
  p_booking_id uuid,
  p_provider_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_booking public.bookings;
  v_count integer := 0;
  v_cadence integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_booking
    from public.bookings
   where id = p_booking_id
   for update;

  if not found then
    raise exception 'booking % not found', p_booking_id using errcode = 'no_data_found';
  end if;

  if v_booking.status::text <> 'offered' or v_booking.provider_id is not null then
    raise exception 'booking % is not awaiting a provider', p_booking_id
      using errcode = 'check_violation';
  end if;

  v_cadence := public._offer_response_minutes(v_booking.scheduled_at);

  -- Reseeding is used when an assigned provider withdraws. Close any stale
  -- active offer before replacing the private queue.
  update public.booking_offers
     set status = 'expired'
   where booking_id = p_booking_id
     and status = 'open';

  delete from public.booking_offer_queue where booking_id = p_booking_id;

  insert into public.booking_offer_runs
    (booking_id, cadence_minutes, started_at, exhausted_at)
  values
    (p_booking_id, v_cadence, now(), null)
  on conflict (booking_id) do update set
    cadence_minutes = excluded.cadence_minutes,
    started_at = excluded.started_at,
    exhausted_at = null;

  insert into public.booking_offer_queue
    (booking_id, provider_id, queue_position)
  select p_booking_id, candidate.provider_id, candidate.position
    from (
      select provider_id, min(ordinality)::integer as position
        from unnest(coalesce(p_provider_ids, '{}'::uuid[]))
             with ordinality as supplied(provider_id, ordinality)
       where provider_id is not null
       group by provider_id
    ) candidate
   order by candidate.position;

  get diagnostics v_count = row_count;

  return jsonb_build_object(
    'booking_id', p_booking_id,
    'queued', v_count,
    'cadence_minutes', v_cadence
  );
end
$fn$;

revoke all on function public.system_seed_booking_offer_queue(uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.system_seed_booking_offer_queue(uuid, uuid[])
  to service_role;

-- Expire the current provider if their turn elapsed, then activate exactly one
-- next provider. The booking row lock serialises cron, decline and reseed.
create or replace function public.system_rotate_booking_offer(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_booking public.bookings;
  v_run public.booking_offer_runs;
  v_current public.booking_offer_queue;
  v_next public.booking_offer_queue;
  v_offer_status text;
  v_deadline timestamptz;
  v_cadence integer;
  v_profile_id uuid;
  v_service text;
  v_newly_exhausted boolean := false;
  v_total integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_booking
    from public.bookings
   where id = p_booking_id
   for update;

  if not found then
    return jsonb_build_object('action', 'missing_booking');
  end if;

  if v_booking.status::text <> 'offered' or v_booking.provider_id is not null then
    return jsonb_build_object('action', 'closed');
  end if;

  select * into v_run
    from public.booking_offer_runs
   where booking_id = p_booking_id
   for update;

  if not found then
    return jsonb_build_object('action', 'no_queue');
  end if;

  select count(*) into v_total
    from public.booking_offer_queue
   where booking_id = p_booking_id;

  select * into v_current
    from public.booking_offer_queue
   where booking_id = p_booking_id
     and outcome = 'offered'
   order by activated_at desc
   limit 1
   for update;

  if found then
    select status into v_offer_status
      from public.booking_offers
     where booking_id = p_booking_id
       and provider_id = v_current.provider_id;

    if v_offer_status = 'open' and v_current.respond_by > now() then
      return jsonb_build_object(
        'action', 'waiting',
        'provider_id', v_current.provider_id,
        'respond_by', v_current.respond_by,
        'cadence_minutes', v_run.cadence_minutes,
        'queued', v_total
      );
    end if;

    if v_offer_status = 'open' then
      update public.booking_offers
         set status = 'expired'
       where booking_id = p_booking_id
         and provider_id = v_current.provider_id
         and status = 'open';
      v_offer_status := 'expired';
    end if;

    update public.booking_offer_queue
       set outcome = case
                       when v_offer_status in ('accepted', 'declined', 'expired', 'lost')
                         then v_offer_status
                       else 'expired'
                     end,
           finished_at = coalesce(finished_at, now())
     where id = v_current.id;
  end if;

  select * into v_next
    from public.booking_offer_queue
   where booking_id = p_booking_id
     and outcome = 'waiting'
   order by queue_position
   limit 1
   for update;

  if not found then
    if v_run.exhausted_at is null then
      update public.booking_offer_runs
         set exhausted_at = now()
       where booking_id = p_booking_id;
      v_newly_exhausted := true;
    end if;

    return jsonb_build_object(
      'action', 'exhausted',
      'newly_exhausted', v_newly_exhausted,
      'customer_id', v_booking.customer_id,
      'queued', v_total
    );
  end if;

  if v_booking.offer_expires_at is not null and v_booking.offer_expires_at <= now() then
    return jsonb_build_object('action', 'hard_deadline', 'queued', v_total);
  end if;

  -- Recompute on every hand-off: as the visit gets closer the queue speeds up.
  v_cadence := public._offer_response_minutes(v_booking.scheduled_at);
  v_deadline := now() + make_interval(mins => v_cadence);
  if v_booking.offer_expires_at is not null then
    v_deadline := least(v_deadline, v_booking.offer_expires_at);
  end if;

  insert into public.booking_offers (booking_id, provider_id, status)
  values (p_booking_id, v_next.provider_id, 'open')
  on conflict (booking_id, provider_id) do update set status = 'open';

  update public.booking_offer_queue
     set outcome = 'offered',
         activated_at = now(),
         respond_by = v_deadline,
         finished_at = null
   where id = v_next.id;

  update public.booking_offer_runs
     set cadence_minutes = v_cadence,
         exhausted_at = null
   where booking_id = p_booking_id;

  select p.profile_id into v_profile_id
    from public.providers p
   where p.id = v_next.provider_id;

  select pkg.name into v_service
    from public.packages pkg
   where pkg.id = v_booking.package_id;

  return jsonb_build_object(
    'action', 'activated',
    'provider_id', v_next.provider_id,
    'profile_id', v_profile_id,
    'respond_by', v_deadline,
    'cadence_minutes', v_cadence,
    'service', coalesce(v_service, 'Service'),
    'address', v_booking.address,
    'customer_id', v_booking.customer_id,
    'queued', v_total
  );
end
$fn$;

revoke all on function public.system_rotate_booking_offer(uuid)
  from public, anon, authenticated;
grant execute on function public.system_rotate_booking_offer(uuid)
  to service_role;

-- Keep queue history aligned with accept/decline/expiry updates made by the
-- existing booking state machine and provider decline action.
create or replace function public._sync_booking_offer_queue()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.status is distinct from old.status
     and new.status in ('accepted', 'declined', 'expired', 'lost') then
    update public.booking_offer_queue
       set outcome = new.status,
           finished_at = coalesce(finished_at, now())
     where booking_id = new.booking_id
       and provider_id = new.provider_id
       and outcome = 'offered';
  end if;
  return new;
end
$fn$;

revoke all on function public._sync_booking_offer_queue()
  from public, anon, authenticated, service_role;

drop trigger if exists sync_booking_offer_queue on public.booking_offers;
create trigger sync_booking_offer_queue
after update of status on public.booking_offers
for each row execute function public._sync_booking_offer_queue();

-- If a still-unassigned booking is rescheduled, make the active provider's
-- response window follow the new distance-to-visit immediately.
create or replace function public._refresh_offer_queue_after_reschedule()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_cadence integer;
begin
  if new.status::text = 'offered'
     and new.provider_id is null
     and (new.scheduled_at is distinct from old.scheduled_at
          or new.offer_expires_at is distinct from old.offer_expires_at) then
    v_cadence := public._offer_response_minutes(new.scheduled_at);

    update public.booking_offer_runs
       set cadence_minutes = v_cadence
     where booking_id = new.id;

    update public.booking_offer_queue
       set respond_by = case
         when new.offer_expires_at is null
           then now() + make_interval(mins => v_cadence)
         else least(
           now() + make_interval(mins => v_cadence),
           new.offer_expires_at
         )
       end
     where booking_id = new.id
       and outcome = 'offered';
  end if;
  return new;
end
$fn$;

revoke all on function public._refresh_offer_queue_after_reschedule()
  from public, anon, authenticated, service_role;

drop trigger if exists refresh_offer_queue_after_reschedule on public.bookings;
create trigger refresh_offer_queue_after_reschedule
after update of scheduled_at, offer_expires_at on public.bookings
for each row execute function public._refresh_offer_queue_after_reschedule();

-- ============================================================================
-- 2. GPS-gated, booking-specific client OTP
-- ============================================================================

create table if not exists public.check_in_challenges (
  id                  uuid primary key default gen_random_uuid(),
  booking_id          uuid not null references public.bookings(id) on delete restrict,
  provider_id         uuid not null references public.providers(id) on delete restrict,
  secret_seed         uuid not null default gen_random_uuid(),
  status              text not null default 'pending'
                      check (status in ('pending', 'verified', 'expired', 'locked', 'cancelled')),
  attempts_remaining  integer not null default 5 check (attempts_remaining between 0 and 5),
  gps_lat             numeric,
  gps_lng             numeric,
  distance_metres     integer,
  requested_at        timestamptz not null default now(),
  expires_at          timestamptz not null,
  verified_at         timestamptz,
  created_at          timestamptz not null default now()
);

create unique index if not exists one_pending_checkin_challenge
  on public.check_in_challenges (booking_id)
  where status = 'pending';

create index if not exists check_in_challenges_expiry_idx
  on public.check_in_challenges (expires_at)
  where status = 'pending';

create table if not exists public.check_in_challenge_events (
  id             uuid primary key default gen_random_uuid(),
  challenge_id   uuid not null references public.check_in_challenges(id) on delete restrict,
  booking_id     uuid not null references public.bookings(id) on delete restrict,
  event_type     text not null check (event_type in ('requested', 'attempt_failed', 'verified', 'expired', 'locked', 'cancelled')),
  actor_id       uuid,
  actor_kind     text not null check (actor_kind in ('provider', 'customer', 'admin', 'system')),
  meta           jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

alter table public.check_in_challenges enable row level security;
alter table public.check_in_challenge_events enable row level security;

revoke all on public.check_in_challenges from public, anon, authenticated, service_role;
revoke all on public.check_in_challenge_events from public, anon, authenticated, service_role;

create or replace function public._deny_checkin_event_mutation()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  raise exception 'check-in challenge events are immutable'
    using errcode = 'insufficient_privilege';
end
$fn$;

revoke all on function public._deny_checkin_event_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists checkin_events_immutable on public.check_in_challenge_events;
create trigger checkin_events_immutable
before update or delete on public.check_in_challenge_events
for each row execute function public._deny_checkin_event_mutation();

-- The plaintext OTP is never stored. It is derived from an unselectable random
-- seed and can only be obtained by the service-role notification path.
create or replace function public._checkin_otp(p_seed uuid)
returns text
language sql
immutable
strict
set search_path = public
as $fn$
  select lpad(
    (((('x' || substr(md5(p_seed::text), 1, 8))::bit(32)::bigint) % 1000000)::text),
    6,
    '0'
  )
$fn$;

revoke all on function public._checkin_otp(uuid)
  from public, anon, authenticated, service_role;

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

  -- Expire an old code before trying to create another one.
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
    (booking_id, provider_id, gps_lat, gps_lng, distance_metres, expires_at)
  values
    (p_booking_id, v_provider_id, p_gps_lat, p_gps_lng, p_distance_metres,
     now() + interval '10 minutes')
  returning * into v_challenge;

  insert into public.check_in_challenge_events
    (challenge_id, booking_id, event_type, actor_id, actor_kind, meta)
  values
    (v_challenge.id, p_booking_id, 'requested', p_provider_profile_id, 'provider',
     jsonb_build_object('distance_metres', p_distance_metres));

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

create or replace function public.system_get_checkin_code(p_challenge_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_challenge public.check_in_challenges;
  v_booking public.bookings;
  v_service text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_challenge
    from public.check_in_challenges
   where id = p_challenge_id
     and status = 'pending'
     and expires_at > now();

  if not found then
    raise exception 'active check-in code not found' using errcode = 'no_data_found';
  end if;

  select * into v_booking
    from public.bookings
   where id = v_challenge.booking_id;

  select name into v_service
    from public.packages
   where id = v_booking.package_id;

  return jsonb_build_object(
    'code', public._checkin_otp(v_challenge.secret_seed),
    'booking_id', v_challenge.booking_id,
    'customer_id', v_booking.customer_id,
    'customer_email', v_booking.customer_email,
    'service', coalesce(v_service, 'your visit'),
    'expires_at', v_challenge.expires_at
  );
end
$fn$;

revoke all on function public.system_get_checkin_code(uuid)
  from public, anon, authenticated;
grant execute on function public.system_get_checkin_code(uuid)
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
      'geofence_pass', true,
      'distance_metres', v_challenge.distance_metres,
      'otp_verified', true,
      'challenge_id', v_challenge.id
    )
  );

  insert into public.check_ins
    (booking_id, arrived_at, gps_lat, gps_lng, geofence_pass)
  values
    (p_booking_id, now(), v_challenge.gps_lat, v_challenge.gps_lng, true);

  update public.check_in_challenges
     set status = 'verified', verified_at = now()
   where id = v_challenge.id;

  insert into public.check_in_challenge_events
    (challenge_id, booking_id, event_type, actor_id, actor_kind, meta)
  values
    (v_challenge.id, p_booking_id, 'verified', v_uid, 'provider',
     jsonb_build_object('distance_metres', v_challenge.distance_metres));

  return jsonb_build_object('ok', true, 'reason', 'Code confirmed — job started.');
end
$fn$;

revoke all on function public.verify_checkin_challenge(uuid, text)
  from public, anon;
grant execute on function public.verify_checkin_challenge(uuid, text)
  to authenticated;

-- ============================================================================
-- 3. Schedule queue rotation every five minutes
-- ============================================================================

create or replace function public.invoke_opulence_cron(p_path text)
returns bigint
language plpgsql
security definer
set search_path = public, vault, net
as $fn$
declare
  v_secret text;
  v_request_id bigint;
begin
  if p_path not in (
    '/api/cron/expire-offers',
    '/api/cron/detect-no-shows',
    '/api/cron/reconcile',
    '/api/cron/rotate-offers'
  ) then
    raise exception 'cron path is not allow-listed: %', p_path;
  end if;

  select decrypted_secret
    into v_secret
    from vault.decrypted_secrets
   where name = 'opulence_cron_secret'
   order by created_at desc
   limit 1;

  if coalesce(v_secret, '') = '' then
    raise exception 'Vault secret opulence_cron_secret is missing';
  end if;

  select net.http_get(
    url := 'https://opulence-bliss-app.vercel.app' || p_path,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_secret,
      'User-Agent', 'opulence-supabase-cron/1.0'
    ),
    timeout_milliseconds := 120000
  ) into v_request_id;

  return v_request_id;
end
$fn$;

revoke all on function public.invoke_opulence_cron(text)
  from public, anon, authenticated, service_role;

do $schedule$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname = 'opulence-rotate-offers';
  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule(
    'opulence-rotate-offers',
    '*/5 * * * *',
    $$select public.invoke_opulence_cron('/api/cron/rotate-offers');$$
  );
end
$schedule$;

do $verify$
begin
  if not exists (
    select 1 from cron.job
     where jobname = 'opulence-rotate-offers'
       and schedule = '*/5 * * * *'
       and active
  ) then
    raise exception 'offer rotation cron is not active';
  end if;
end
$verify$;

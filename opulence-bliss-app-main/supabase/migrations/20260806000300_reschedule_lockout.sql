-- ============================================================================
-- 0008 — Reschedule lockout, enforced in the database
-- ============================================================================
-- Run AFTER the earlier migrations. Safe to re-run.
--
-- The brief asks for a strict 48-hour reschedule lockout. Enforcing that in the
-- interface only means any other route around it — an old client, a script, a
-- future action — silently ignores it. So:
--
--   * the window lives in a table, editable by an admin, not in code
--   * the check uses now() inside a function that has locked the booking row
--   * admins may override, but must give a reason, and it is recorded
--   * direct writes to bookings.scheduled_at are revoked
--
-- ⚠ Deploy the application change that calls reschedule_booking() together with
--   this migration. The revoke at the bottom breaks any code still writing
--   scheduled_at directly.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The timing rules, as data
-- ----------------------------------------------------------------------------
create table if not exists booking_rules (
  id                        int primary key default 1,
  reschedule_lockout_hours  int not null default 48,
  min_notice_hours          int not null default 2,
  free_cancellation_hours   int not null default 24,
  updated_at                timestamptz not null default now(),
  constraint one_row check (id = 1)
);

insert into booking_rules (id) values (1) on conflict (id) do nothing;

do $$ begin
  alter table booking_rules add constraint booking_rules_sane
    check (
      reschedule_lockout_hours between 0 and 336
      and min_notice_hours between 0 and 168
      and free_cancellation_hours between 0 and 336
    );
exception when duplicate_object then null; end $$;

alter table booking_rules enable row level security;

drop policy if exists "anyone reads booking rules" on booking_rules;
create policy "anyone reads booking rules" on booking_rules
  for select using (true);

drop policy if exists "admin writes booking rules" on booking_rules;
create policy "admin writes booking rules" on booking_rules
  for all using (is_admin()) with check (is_admin());


-- ----------------------------------------------------------------------------
-- 2. The only way to move a booking's time
-- ----------------------------------------------------------------------------
create or replace function _apply_reschedule(
  p_booking_id uuid,
  p_new_slot   timestamptz,
  p_actor_id   uuid,
  p_actor_kind text,
  p_reason     text,
  p_meta       jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_booking   bookings;
  v_rules     booking_rules;
  v_provider  uuid;
  v_old       timestamptz;
  v_cutoff    timestamptz;
  v_earliest  timestamptz;
begin
  select * into v_rules from booking_rules where id = 1;

  if p_new_slot is null then
    raise exception 'a new visit time is required'
      using errcode = 'check_violation';
  end if;

  -- Lock first. Everything after this is serialised against other callers.
  select * into v_booking from bookings where id = p_booking_id for update;
  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  -- Only a visit that hasn't started can move.
  if v_booking.status::text not in ('offered', 'declined', 'scheduled') then
    raise exception
      'a % booking cannot be rescheduled', v_booking.status
      using errcode = 'check_violation';
  end if;

  v_old := v_booking.scheduled_at;

  -- ---- who is asking ----
  if p_actor_kind = 'customer' then
    if v_booking.customer_id is distinct from p_actor_id then
      raise exception 'not your booking' using errcode = 'insufficient_privilege';
    end if;

    -- A retry after a successful move must converge even if the new time has
    -- since entered the lockout window.
    if p_new_slot = v_old then
      return jsonb_build_object('changed', false, 'scheduled_at', v_old);
    end if;

    -- THE LOCKOUT. Database clock, not the caller's.
    v_cutoff := v_old - make_interval(hours => v_rules.reschedule_lockout_hours);
    if now() >= v_cutoff then
      raise exception
        'too late to reschedule — changes need % hours notice, and this visit is at %',
        v_rules.reschedule_lockout_hours,
        to_char(v_old, 'DD Mon HH24:MI')
        using errcode = 'check_violation';
    end if;

  elsif p_actor_kind = 'provider' then
    select id into v_provider from providers where profile_id = p_actor_id;
    if v_provider is null or v_booking.provider_id is distinct from v_provider then
      raise exception 'not your job' using errcode = 'insufficient_privilege';
    end if;
    -- A provider moving a confirmed visit is a negotiation, not a right.
    raise exception
      'providers cannot reschedule — withdraw instead so it can be re-offered'
      using errcode = 'check_violation';

  elsif p_actor_kind in ('admin', 'system') then
    if p_new_slot = v_old then
      return jsonb_build_object('changed', false, 'scheduled_at', v_old);
    end if;

    -- May override the lockout, but must say why.
    if coalesce(trim(p_reason), '') = '' then
      raise exception 'a reason is required to override the lockout'
        using errcode = 'check_violation';
    end if;

  else
    raise exception 'unknown actor kind %', p_actor_kind
      using errcode = 'insufficient_privilege';
  end if;

  -- ---- is the new time sane for anyone? ----
  v_earliest := now() + make_interval(hours => v_rules.min_notice_hours);
  if p_new_slot < v_earliest and p_actor_kind not in ('admin', 'system') then
    raise exception
      'the new time needs at least % hours notice', v_rules.min_notice_hours
      using errcode = 'check_violation';
  end if;

  -- ---- move it ----
  update bookings
     set scheduled_at     = p_new_slot,
         offer_expires_at = case
           when p_actor_kind in ('admin', 'system')
                and nullif(p_meta->>'offer_expires_at', '') is not null
             then (p_meta->>'offer_expires_at')::timestamptz
           else p_new_slot - make_interval(hours => v_rules.min_notice_hours)
         end
   where id = p_booking_id;

  -- Rescheduling is not a status change, but it IS a fact about the booking
  -- that belongs in the same immutable history.
  insert into booking_events
    (booking_id, from_status, to_status, actor_id, actor_kind, reason, meta)
  values (
    p_booking_id,
    v_booking.status::text,
    v_booking.status::text,
    p_actor_id,
    p_actor_kind,
    nullif(trim(coalesce(p_reason, '')), ''),
    coalesce(p_meta, '{}'::jsonb) || jsonb_build_object(
      'event', 'rescheduled',
      'from', v_old,
      'to', p_new_slot,
      'lockout_hours', v_rules.reschedule_lockout_hours,
      'overrode_lockout', p_actor_kind in ('admin', 'system')
        and now() >= v_old - make_interval(hours => v_rules.reschedule_lockout_hours),
      'overrode_min_notice', p_actor_kind in ('admin', 'system')
        and p_new_slot < v_earliest
    )
  );

  return jsonb_build_object(
    'changed', true,
    'from', v_old,
    'scheduled_at', p_new_slot,
    'provider_id', v_booking.provider_id
  );
end $fn$;

revoke all on function _apply_reschedule(uuid, timestamptz, uuid, text, text, jsonb)
  from public, anon, authenticated;


-- ---- public entry point: actor derived, never supplied ----------------------
create or replace function reschedule_booking(
  p_booking_id uuid,
  p_new_slot   timestamptz,
  p_reason     text default null,
  p_meta       jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid  uuid := auth.uid();
  v_role text;
  v_kind text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  select role into v_role from profiles where id = v_uid;

  v_kind := case v_role
              when 'customer' then 'customer'
              when 'provider' then 'provider'
              when 'admin'    then 'admin'
              else null
            end;

  if v_kind is null then
    raise exception 'no role on file for this account'
      using errcode = 'insufficient_privilege';
  end if;

  return _apply_reschedule(
    p_booking_id, p_new_slot, v_uid, v_kind, p_reason, p_meta);
end $fn$;

revoke all on function reschedule_booking(uuid, timestamptz, text, jsonb)
  from public, anon;
grant execute on function reschedule_booking(uuid, timestamptz, text, jsonb)
  to authenticated;


-- ---- system path: service role only ----------------------------------------
create or replace function system_reschedule_booking(
  p_booking_id uuid,
  p_new_slot   timestamptz,
  p_reason     text,
  p_meta       jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role only' using errcode = 'insufficient_privilege';
  end if;

  return _apply_reschedule(
    p_booking_id, p_new_slot, null, 'system', p_reason, p_meta);
end $fn$;

revoke all on function system_reschedule_booking(uuid, timestamptz, text, jsonb)
  from public, anon, authenticated;

do $$ begin
  execute 'grant execute on function system_reschedule_booking(uuid, timestamptz, text, jsonb) to service_role';
exception when others then null; end $$;


-- ----------------------------------------------------------------------------
-- 3. Report the rule, so the interface can explain it truthfully
-- ----------------------------------------------------------------------------
-- Lets the client surface say "you can change this until Tuesday 10:00" using
-- the same numbers the database will enforce.
create or replace function reschedule_window(p_booking_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_booking bookings;
  v_rules   booking_rules;
  v_cutoff  timestamptz;
  v_uid     uuid := auth.uid();
  v_role    text;
  v_provider uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  select * into v_rules from booking_rules where id = 1;

  select * into v_booking from bookings where id = p_booking_id;
  if not found then
    return jsonb_build_object('can_reschedule', false, 'reason', 'not found');
  end if;

  -- SECURITY DEFINER bypasses RLS, so authorization must be explicit here.
  select role into v_role from profiles where id = v_uid;
  if v_role = 'customer' then
    if v_booking.customer_id is distinct from v_uid then
      raise exception 'not your booking' using errcode = 'insufficient_privilege';
    end if;
  elsif v_role = 'provider' then
    select id into v_provider from providers where profile_id = v_uid;
    if v_provider is null or v_booking.provider_id is distinct from v_provider then
      raise exception 'not your job' using errcode = 'insufficient_privilege';
    end if;
  elsif v_role <> 'admin' then
    raise exception 'account role cannot inspect this booking'
      using errcode = 'insufficient_privilege';
  end if;

  if v_booking.status::text not in ('offered', 'declined', 'scheduled') then
    return jsonb_build_object(
      'can_reschedule', false,
      'reason', 'this visit can no longer be changed',
      'lockout_hours', v_rules.reschedule_lockout_hours
    );
  end if;

  v_cutoff := v_booking.scheduled_at
              - make_interval(hours => v_rules.reschedule_lockout_hours);

  return jsonb_build_object(
    'can_reschedule', now() < v_cutoff,
    'cutoff_at', v_cutoff,
    'lockout_hours', v_rules.reschedule_lockout_hours,
    'min_notice_hours', v_rules.min_notice_hours,
    'reason', case
                when now() < v_cutoff then null
                else format('changes need %s hours notice',
                            v_rules.reschedule_lockout_hours)
              end
  );
end $fn$;

revoke all on function reschedule_window(uuid) from public, anon;
grant execute on function reschedule_window(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 4. Close the back door
-- ----------------------------------------------------------------------------
-- ⚠ Application code must already call reschedule_booking() before this lands.
-- Table-level UPDATE grants override column-level revokes, so remove the broad
-- grant first and restore only columns that are not state/timing controls.
revoke update on bookings from authenticated, anon, service_role;

grant update (
  id,
  customer_id,
  package_id,
  address,
  customer_email,
  household_notes,
  created_at,
  promo_code,
  subscription_id,
  provider_payout,
  membership_fee_deducted
) on bookings to authenticated, anon, service_role;

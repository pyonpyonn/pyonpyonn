-- ============================================================================
-- 0007 — Re-broadcast: scheduled → offered
-- ============================================================================
-- Run after the earlier migrations. Safe to re-run.
--
-- When a provider can't attend, cancelling the booking is the wrong answer:
-- it destroys the customer's slot and releases their authorisation for
-- something that is our problem, not theirs. The booking should go back on
-- the market with the customer none the worse off.
--
-- This adds that transition and makes its side effects atomic.
-- ============================================================================

insert into booking_transitions
  (from_status, to_status, actor_kind, required_assignment, reason_required, note)
values
  ('scheduled', 'offered', 'provider', 'assigned_provider', true,
   'Provider cannot attend. Clears the assignment and returns the job to the market.'),
  ('scheduled', 'offered', 'admin', 'none', true,
   'Manual re-broadcast.'),
  ('scheduled', 'offered', 'system', 'none', true,
   'Automatic re-broadcast, e.g. after a provider account is suspended.'),
  ('needs_review', 'offered', 'admin', 'none', true,
   'Case resolved by finding someone else.'),
  ('scheduled', 'needs_review', 'customer', 'customer', true,
   'Provider no-show reported after the grace period.'),
  ('offered', 'needs_review', 'system', 'none', true,
   'Re-broadcast found no eligible replacement provider.')
on conflict (from_status, to_status, actor_kind) do update set
  required_assignment = excluded.required_assignment,
  reason_required     = excluded.reason_required,
  note                = excluded.note;


-- ----------------------------------------------------------------------------
-- The side effects, inside the same lock as the status change
-- ----------------------------------------------------------------------------
create or replace function _apply_booking_transition(
  p_booking_id  uuid,
  p_to_status   text,
  p_actor_id    uuid,
  p_actor_kind  text,
  p_reason      text,
  p_meta        jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_booking     bookings;
  v_policy      booking_transitions;
  v_provider_id uuid;
  v_leaving     uuid;
  v_from        text;
  v_ok          boolean := false;
begin
  select * into v_booking
  from bookings
  where id = p_booking_id
  for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  v_from := v_booking.status::text;

  -- A no-op is idempotent only for someone related to this booking. Preserve
  -- the anti-enumeration/false-success guard from the original function.
  if v_from = p_to_status then
    if p_actor_kind in ('admin', 'system') then
      v_ok := true;
    elsif p_actor_kind = 'customer' then
      v_ok := v_booking.customer_id is not distinct from p_actor_id;
    elsif p_actor_kind = 'provider' then
      select id into v_provider_id from providers where profile_id = p_actor_id;
      v_ok := v_provider_id is not null and (
        v_booking.provider_id is not distinct from v_provider_id
        or (
          v_from = 'offered'
          and v_booking.provider_id is null
          and exists (
            select 1 from booking_offers o
            where o.booking_id = p_booking_id
              and o.provider_id = v_provider_id
              and o.status = 'open'
          )
        )
      );
    end if;

    if not v_ok then
      raise exception 'actor is not permitted to act on booking %', p_booking_id
        using errcode = 'insufficient_privilege';
    end if;

    return jsonb_build_object(
      'changed', false, 'status', v_from, 'reason', 'already in this state'
    );
  end if;

  select * into v_policy
  from booking_transitions
  where from_status = v_from
    and to_status   = p_to_status
    and actor_kind  = p_actor_kind;

  if not found then
    raise exception
      'transition %→% is not permitted for %', v_from, p_to_status, p_actor_kind
      using errcode = 'check_violation';
  end if;

  if v_policy.reason_required and coalesce(trim(p_reason), '') = '' then
    raise exception 'a reason is required for %→% by %',
      v_from, p_to_status, p_actor_kind
      using errcode = 'check_violation';
  end if;

  -- No-show/no-access claims are not valid before the provider has had a
  -- fifteen-minute grace period. Enforce this below the action layer too.
  if v_from = 'scheduled'
     and p_to_status = 'needs_review'
     and p_actor_kind in ('customer', 'provider')
     and now() < v_booking.scheduled_at + interval '15 minutes' then
    raise exception 'this visit cannot be reported before %',
      v_booking.scheduled_at + interval '15 minutes'
      using errcode = 'check_violation';
  end if;

  if v_from = 'scheduled'
     and p_to_status = 'needs_review'
     and p_actor_kind = 'customer'
     and exists (
       select 1 from check_ins ci
        where ci.booking_id = p_booking_id and ci.arrived_at is not null
     ) then
    raise exception 'the provider has already checked in'
      using errcode = 'check_violation';
  end if;

  -- A sweeper must not cancel and release money while an operator-owned case
  -- explicitly blocks payment or payout.
  if p_actor_kind = 'system' and p_to_status = 'cancelled' and exists (
    select 1 from review_cases rc
     where rc.booking_id = p_booking_id
       and rc.status <> 'resolved'
       and (rc.blocks_payment or rc.blocks_payout)
  ) then
    raise exception 'cannot cancel while a blocking review case is open'
      using errcode = 'check_violation';
  end if;

  if v_policy.required_assignment = 'customer' then
    v_ok := v_booking.customer_id is not distinct from p_actor_id;

  elsif v_policy.required_assignment = 'assigned_provider' then
    select id into v_provider_id from providers where profile_id = p_actor_id;
    v_ok := v_provider_id is not null
        and v_booking.provider_id is not distinct from v_provider_id;

  elsif v_policy.required_assignment = 'offered_provider' then
    select id into v_provider_id from providers where profile_id = p_actor_id;
    v_ok := v_provider_id is not null
        and v_booking.provider_id is null
        and exists (
          select 1 from booking_offers o
          where o.booking_id  = p_booking_id
            and o.provider_id = v_provider_id
            and o.status      = 'open'
        );
  else
    v_ok := true;
  end if;

  if not v_ok then
    raise exception 'actor is not permitted to act on booking %', p_booking_id
      using errcode = 'insufficient_privilege';
  end if;

  -- ---- side effects ----

  -- Accepting an offer claims the job and closes it for everyone else.
  if v_from = 'offered' and p_to_status = 'scheduled'
     and v_policy.required_assignment = 'offered_provider' then

    update bookings
       set status      = p_to_status::booking_status,
           provider_id = v_provider_id
     where id = p_booking_id;

    update booking_offers
       set status = 'accepted'
     where booking_id = p_booking_id and provider_id = v_provider_id;

    update booking_offers
       set status = 'lost'
     where booking_id = p_booking_id
       and provider_id <> v_provider_id
       and status = 'open';

  -- A customer reschedule preserves the original behaviour: move the slot,
  -- release the assignment, and reopen the former winning offer.
  elsif p_to_status = 'offered' and p_actor_kind = 'customer'
        and v_from in ('scheduled', 'declined') then

    update bookings
       set status = p_to_status::booking_status,
           provider_id = null,
           scheduled_at = coalesce(
             nullif(p_meta->>'scheduled_at', '')::timestamptz,
             scheduled_at
           )
     where id = p_booking_id;

    update booking_offers
       set status = 'open'
     where booking_id = p_booking_id
       and status = 'accepted';

  -- NEW: back on the market. The customer keeps their booking and card hold.
  elsif p_to_status = 'offered' and v_from in ('scheduled', 'needs_review') then

    v_leaving := v_booking.provider_id;

    update bookings
       set status      = p_to_status::booking_status,
           provider_id = null,
           offer_expires_at = coalesce(
             nullif(p_meta->>'offer_expires_at', '')::timestamptz,
             offer_expires_at
           )
     where id = p_booking_id;

    -- Whoever dropped it doesn't get offered it again.
    if v_leaving is not null then
      update booking_offers
         set status = 'declined'
       where booking_id = p_booking_id
         and provider_id = v_leaving;
    end if;

    -- Any offers still sitting open are stale; the caller re-broadcasts.
    update booking_offers
       set status = 'lost'
     where booking_id = p_booking_id
       and status = 'open';

  -- Leaving a confirmed state frees the provider.
  elsif p_to_status = 'cancelled' and v_from in ('scheduled', 'in_progress')
        and p_actor_kind = 'provider' then

    update bookings
       set status      = p_to_status::booking_status,
           provider_id = null
     where id = p_booking_id;

  else
    update bookings
       set status = p_to_status::booking_status
     where id = p_booking_id;
  end if;

  insert into booking_events
    (booking_id, from_status, to_status, actor_id, actor_kind, reason, meta)
  values
    (p_booking_id, v_from, p_to_status, p_actor_id, p_actor_kind,
     nullif(trim(coalesce(p_reason, '')), ''), coalesce(p_meta, '{}'::jsonb));

  return jsonb_build_object(
    'changed', true,
    'from', v_from,
    'status', p_to_status,
    'released_provider', v_leaving,
    'provider_id', (
      select b.provider_id from bookings b where b.id = p_booking_id
    )
  );
end $fn$;

revoke all on function _apply_booking_transition(uuid, text, uuid, text, text, jsonb)
  from public, anon, authenticated;


-- Participant moves into review must use the atomic exception function below;
-- otherwise a direct RPC could change status without creating the case.
create or replace function transition_booking(
  p_booking_id uuid,
  p_to_status text,
  p_reason text default null,
  p_meta jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_kind text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  select role into v_role from profiles where id = v_uid;
  v_kind := case v_role
              when 'provider' then 'provider'
              when 'admin' then 'admin'
              when 'customer' then 'customer'
              else null
            end;

  if v_kind is null then
    raise exception 'no role on file for this account'
      using errcode = 'insufficient_privilege';
  end if;

  if v_kind in ('customer', 'provider') and p_to_status = 'needs_review' then
    raise exception 'use report_booking_exception to open review atomically'
      using errcode = 'check_violation';
  end if;

  return _apply_booking_transition(
    p_booking_id, p_to_status, v_uid, v_kind, p_reason, p_meta
  );
end $fn$;

revoke all on function transition_booking(uuid, text, text, jsonb)
  from public, anon;
grant execute on function transition_booking(uuid, text, text, jsonb)
  to authenticated;


-- ----------------------------------------------------------------------------
-- Atomic participant exception: transition + case, or neither
-- ----------------------------------------------------------------------------
create or replace function report_booking_exception(
  p_booking_id uuid,
  p_category text,
  p_reason text,
  p_notes text default null,
  p_meta jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_case_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  select role into v_role from profiles where id = v_uid;

  if p_category = 'worker_no_show' and v_role <> 'customer' then
    raise exception 'only the customer can report a provider no-show'
      using errcode = 'insufficient_privilege';
  elsif p_category = 'client_unavailable' and v_role <> 'provider' then
    raise exception 'only the assigned provider can report no access'
      using errcode = 'insufficient_privilege';
  elsif p_category not in ('worker_no_show', 'client_unavailable') then
    raise exception 'unsupported exception category'
      using errcode = 'check_violation';
  end if;

  perform _apply_booking_transition(
    p_booking_id,
    'needs_review',
    v_uid,
    v_role,
    p_reason,
    coalesce(p_meta, '{}'::jsonb)
  );

  v_case_id := open_review_case(
    p_booking_id,
    p_category,
    case when p_category = 'worker_no_show' then 'urgent' else 'high' end,
    true,
    true,
    p_notes,
    null
  );

  return jsonb_build_object('ok', true, 'case_id', v_case_id);
end $fn$;

revoke all on function report_booking_exception(uuid, text, text, text, jsonb)
  from public, anon;
grant execute on function report_booking_exception(uuid, text, text, text, jsonb)
  to authenticated;


-- If re-broadcast has no eligible recipient, move the booking into review and
-- open the blocking case in the same service-role transaction.
create or replace function system_report_unfilled_rebroadcast(
  p_booking_id uuid,
  p_reason text,
  p_notes text,
  p_created_by uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare v_case_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role only' using errcode = 'insufficient_privilege';
  end if;

  perform _apply_booking_transition(
    p_booking_id,
    'needs_review',
    null,
    'system',
    p_reason,
    jsonb_build_object('reported_by', p_created_by)
  );

  v_case_id := open_review_case(
    p_booking_id,
    'worker_no_show',
    'urgent',
    true,
    true,
    p_notes,
    p_created_by
  );

  return v_case_id;
end $fn$;

revoke all on function system_report_unfilled_rebroadcast(uuid, text, text, uuid)
  from public, anon, authenticated;
do $grant$
begin
  execute 'grant execute on function system_report_unfilled_rebroadcast(uuid, text, text, uuid) to service_role';
exception when others then null;
end $grant$;

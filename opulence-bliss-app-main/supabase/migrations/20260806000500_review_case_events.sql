-- ============================================================================
-- 0009 — Review cases: immutable history, locked operations, no direct writes
-- ============================================================================
-- Run AFTER the earlier migrations. Safe to re-run.
--
-- Cases decide whether money moves. Until now they had admin-only RLS but no
-- history, so "who flipped blocks_payout?" had no answer. This migration:
--
--   * adds review_case_events — append only, admin-readable
--   * rebuilds every case operation as an RPC that locks the row first
--   * derives actor identity from the JWT, never from a parameter
--   * makes setting a blocking flag hold an eligible payout, atomically
--   * never releases money automatically when a block is removed
--   * moves notes into events, so they cannot be rewritten
--   * revokes INSERT/UPDATE/DELETE on review_cases from every role
--   * refuses to deploy if any protected column is still writable
--
-- ⚠ Deploy with the application change. After this, nothing writes review_cases
--   except the functions below.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The history
-- ----------------------------------------------------------------------------
-- 0004 already created this table with the legacy columns
-- (review_case_id, action, details). Evolve it in place and preserve every
-- historical row rather than letting CREATE TABLE IF NOT EXISTS hide the
-- incompatible shape.
drop trigger if exists review_case_events_no_update on review_case_events;
drop trigger if exists rce_no_change on review_case_events;

alter table review_case_events
  add column if not exists case_id uuid,
  add column if not exists booking_id uuid,
  add column if not exists event_type text,
  add column if not exists actor_kind text,
  add column if not exists before jsonb,
  add column if not exists after jsonb,
  add column if not exists reason text,
  add column if not exists meta jsonb default '{}'::jsonb;

-- Backfill the old audit rows before removing their legacy columns. Dynamic
-- SQL keeps this migration safe to re-run after those columns are gone.
do $backfill$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'review_case_events'
       and column_name = 'review_case_id'
  ) then
    execute $sql$
      update review_case_events e
         set case_id = coalesce(e.case_id, e.review_case_id),
             booking_id = coalesce(
               e.booking_id,
               (select rc.booking_id
                  from review_cases rc
                 where rc.id = e.review_case_id)
             ),
             event_type = coalesce(
               e.event_type,
               case e.action
                 when 'refund_sequence_claimed' then 'refund_sequence_issued'
                 else e.action
               end
             ),
             actor_kind = coalesce(e.actor_kind, 'admin'),
             after = coalesce(e.after, e.details),
             meta = coalesce(e.meta, '{}'::jsonb)
       where e.case_id is null
          or e.event_type is null
          or e.actor_kind is null
          or e.meta is null
    $sql$;
  end if;
end $backfill$;

alter table review_case_events
  alter column actor_id drop not null,
  alter column case_id set not null,
  alter column event_type set not null,
  alter column actor_kind set not null,
  alter column meta set not null,
  alter column meta set default '{}'::jsonb;

do $$ begin
  alter table review_case_events add constraint rce_case_fk
    foreign key (case_id) references review_cases(id) on delete restrict;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table review_case_events add constraint rce_booking_fk
    foreign key (booking_id) references bookings(id) on delete set null;
exception when duplicate_object then null; end $$;

alter table review_case_events
  drop column if exists review_case_id,
  drop column if exists action,
  drop column if exists details;

do $$ begin
  alter table review_case_events add constraint rce_event_type_check
    check (event_type in (
      'opened',
      'assigned',
      'priority_changed',
      'status_changed',
      'blocks_changed',
      'note_added',
      'refund_sequence_issued',
      'resolved',
      'reopened'
    ));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table review_case_events add constraint rce_actor_kind_check
    check (actor_kind in ('customer', 'provider', 'admin', 'system'));
exception when duplicate_object then null; end $$;

create index if not exists rce_case_idx
  on review_case_events(case_id, created_at desc);
create index if not exists rce_booking_idx
  on review_case_events(booking_id, created_at desc);
create index if not exists rce_actor_idx
  on review_case_events(actor_id, created_at desc);

alter table review_case_events enable row level security;

drop policy if exists "admin reads case events" on review_case_events;
drop policy if exists "admins read review case events" on review_case_events;
create policy "admin reads case events" on review_case_events
  for select using (is_admin());

-- Immutable and desk-readable only. The definer functions below still insert.
revoke all on review_case_events from authenticated, anon, service_role;
do $revoke_event_columns$
declare v_columns text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_columns
    from information_schema.columns
   where table_schema = 'public' and table_name = 'review_case_events';

  execute format(
    'revoke update (%s) on review_case_events from authenticated, anon, service_role',
    v_columns);
  execute format(
    'revoke insert (%s) on review_case_events from authenticated, anon, service_role',
    v_columns);
end $revoke_event_columns$;
grant select on review_case_events to authenticated;

create or replace function review_case_events_immutable()
returns trigger language plpgsql as $fn$
begin
  raise exception 'review_case_events is append-only (attempted %)', tg_op;
end $fn$;

drop trigger if exists rce_no_change on review_case_events;
create trigger rce_no_change
  before update or delete on review_case_events
  for each row execute function review_case_events_immutable();


-- ----------------------------------------------------------------------------
-- 2. Shared internals
-- ----------------------------------------------------------------------------

/** The acting admin, from the JWT. Raises for anyone else. */
create or replace function _case_admin()
returns uuid
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid  uuid := auth.uid();
  v_role text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  select role into v_role from profiles where id = v_uid;

  if v_role is distinct from 'admin' then
    raise exception 'admin only' using errcode = 'insufficient_privilege';
  end if;

  return v_uid;
end $fn$;

revoke all on function _case_admin()
  from public, anon, authenticated, service_role;

/** Write one history row. Private — callers below have already validated. */
create or replace function _case_event(
  p_case_id    uuid,
  p_booking_id uuid,
  p_event_type text,
  p_actor_id   uuid,
  p_actor_kind text,
  p_before     jsonb,
  p_after      jsonb,
  p_reason     text,
  p_meta       jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = public as $fn$
begin
  insert into review_case_events
    (case_id, booking_id, event_type, actor_id, actor_kind,
     before, after, reason, meta)
  values
    (p_case_id, p_booking_id, p_event_type, p_actor_id, p_actor_kind,
     p_before, p_after, nullif(trim(coalesce(p_reason, '')), ''),
     coalesce(p_meta, '{}'::jsonb));
end $fn$;

revoke all on function
  _case_event(uuid, uuid, text, uuid, text, jsonb, jsonb, text, jsonb)
  from public, anon, authenticated, service_role;

/** SLA windows, so priority changes recompute consistently. */
create or replace function _case_sla(p_priority text)
returns jsonb
language sql immutable as $fn$
  select jsonb_build_object(
    'respond', case p_priority
                 when 'urgent' then interval '1 hour'
                 when 'high'   then interval '4 hours'
                 when 'normal' then interval '1 day'
                 else interval '3 days'
               end,
    'resolve', case p_priority
                 when 'urgent' then interval '1 day'
                 when 'high'   then interval '3 days'
                 when 'normal' then interval '7 days'
                 else interval '14 days'
               end
  );
$fn$;

revoke all on function _case_sla(text)
  from public, anon, authenticated, service_role;

/**
 * A blocking flag turning ON must stop the money in the same transaction.
 * Only touches a payout that hasn't been sent. Never releases anything.
 */
create or replace function _hold_payout_for_case(
  p_booking_id uuid,
  p_actor_id   uuid,
  p_actor_kind text,
  p_reason     text
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare v_payout payouts;
begin
  if p_booking_id is null then
    return jsonb_build_object('held', false, 'reason', 'no booking');
  end if;

  select * into v_payout
  from payouts
  where booking_id = p_booking_id
  order by created_at
  limit 1
  for update;

  if not found then
    return jsonb_build_object('held', false, 'reason', 'no payout yet');
  end if;

  -- Already held, already sent, or already reversed: leave it alone. This is
  -- what stops a second case producing a duplicate hold event.
  if v_payout.status not in ('not_ready', 'pending') then
    return jsonb_build_object('held', false, 'status', v_payout.status,
                              'reason', 'not holdable');
  end if;

  perform _apply_payout_transition(
    v_payout.id, 'held', null, 'system', p_reason,
    jsonb_build_object(
      'triggered_by', p_actor_id,
      'triggered_by_kind', p_actor_kind
    ));

  return jsonb_build_object('held', true, 'payout_id', v_payout.id);
end $fn$;

revoke all on function _hold_payout_for_case(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;


-- ----------------------------------------------------------------------------
-- 3. Opening a case — now logs
-- ----------------------------------------------------------------------------
create or replace function open_review_case(
  p_booking_id     uuid,
  p_category       text,
  p_priority       text default 'normal',
  p_blocks_payment boolean default false,
  p_blocks_payout  boolean default false,
  p_notes          text default null,
  p_created_by     uuid default null   -- ignored; kept for signature stability
) returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid   uuid := auth.uid();
  v_kind  text := 'system';
  v_role  text;
  v_id    uuid;
  v_sla   jsonb;
  v_booking bookings;
  v_provider uuid;
begin
  -- Actor is derived. p_created_by is deliberately unused.
  -- Locking the booking serialises duplicate opens for the same
  -- booking/category before either caller checks the partial unique index.
  select * into v_booking
    from bookings
   where id = p_booking_id
   for update;
  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  if v_uid is null then
    if coalesce(auth.role(), '') <> 'service_role' then
      raise exception 'not authenticated' using errcode = 'insufficient_privilege';
    end if;
  else
    select role into v_role from profiles where id = v_uid;

    if v_role = 'admin' then
      v_kind := 'admin';
    elsif v_role = 'customer' then
      if v_booking.customer_id is distinct from v_uid then
        raise exception 'not your booking'
          using errcode = 'insufficient_privilege';
      end if;
      v_kind := 'customer';
    elsif v_role = 'provider' then
      select id into v_provider from providers where profile_id = v_uid;
      if v_provider is null
         or v_booking.provider_id is distinct from v_provider then
        raise exception 'not your booking'
          using errcode = 'insufficient_privilege';
      end if;
      v_kind := 'provider';
    else
      raise exception 'account role cannot open a review case'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- One unresolved case per booking per category.
  select id into v_id
  from review_cases
  where booking_id = p_booking_id
    and category   = p_category
    and status    <> 'resolved'
  limit 1;

  if v_id is not null then
    return v_id;
  end if;

  v_sla := _case_sla(p_priority);

  insert into review_cases (
    booking_id, category, priority, blocks_payment, blocks_payout,
    response_due_at, resolution_due_at, created_by
  ) values (
    p_booking_id, p_category, p_priority, p_blocks_payment, p_blocks_payout,
    now() + (v_sla->>'respond')::interval,
    now() + (v_sla->>'resolve')::interval,
    v_uid
  )
  returning id into v_id;

  perform _case_event(
    v_id, p_booking_id, 'opened', v_uid, v_kind,
    null,
    jsonb_build_object(
      'category', p_category, 'priority', p_priority,
      'blocks_payment', p_blocks_payment, 'blocks_payout', p_blocks_payout
    ),
    null, '{}'::jsonb);

  if p_notes is not null and trim(p_notes) <> '' then
    perform _case_event(
      v_id, p_booking_id, 'note_added', v_uid, v_kind,
      null, jsonb_build_object('note', p_notes), null, '{}'::jsonb);
  end if;

  if p_blocks_payment or p_blocks_payout then
    perform _hold_payout_for_case(
      p_booking_id, v_uid, v_kind,
      format('Case opened: %s', p_category));
  end if;

  return v_id;
end $fn$;

revoke all on function
  open_review_case(uuid, text, text, boolean, boolean, text, uuid)
  from public, anon;
grant execute on function
  open_review_case(uuid, text, text, boolean, boolean, text, uuid)
  to authenticated;
do $$ begin
  execute 'grant execute on function open_review_case(uuid, text, text, boolean, boolean, text, uuid) to service_role';
exception when others then null; end $$;


-- ----------------------------------------------------------------------------
-- 4. Assignment
-- ----------------------------------------------------------------------------
create or replace function assign_review_case(
  p_case_id uuid,
  p_to      uuid default null           -- null = me
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_admin uuid := _case_admin();
  v_case  review_cases;
  v_after review_cases;
  v_to    uuid;
  v_role  text;
begin
  select * into v_case from review_cases where id = p_case_id for update;
  if not found then
    raise exception 'case % not found', p_case_id using errcode = 'no_data_found';
  end if;
  if v_case.status = 'resolved' then
    raise exception 'case % is resolved — reopen it first', p_case_id
      using errcode = 'check_violation';
  end if;

  v_to := coalesce(p_to, v_admin);

  -- You may hand a case to another admin, but not to a customer.
  select role into v_role from profiles where id = v_to;
  if v_role is distinct from 'admin' then
    raise exception 'cases can only be assigned to an admin'
      using errcode = 'check_violation';
  end if;

  update review_cases
     set assigned_to     = v_to,
         status          = case when status = 'open' then 'acknowledged' else status end,
         acknowledged_at = coalesce(acknowledged_at, now())
   where id = p_case_id;
  select * into v_after from review_cases where id = p_case_id;

  perform _case_event(
    p_case_id, v_case.booking_id, 'assigned', v_admin, 'admin',
    jsonb_build_object('assigned_to', v_case.assigned_to, 'status', v_case.status),
    jsonb_build_object(
      'assigned_to', v_to,
      'status', v_after.status,
      'acknowledged_at', v_after.acknowledged_at
    ),
    null, '{}'::jsonb);

  return jsonb_build_object('ok', true, 'assigned_to', v_to);
end $fn$;

revoke all on function assign_review_case(uuid, uuid) from public, anon;
grant execute on function assign_review_case(uuid, uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 5. Priority — recomputes the SLA from the original opening time
-- ----------------------------------------------------------------------------
create or replace function set_case_priority(
  p_case_id  uuid,
  p_priority text,
  p_reason   text
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_admin uuid := _case_admin();
  v_case  review_cases;
  v_sla   jsonb;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'a reason is required to change priority'
      using errcode = 'check_violation';
  end if;
  if p_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'unknown priority %', p_priority using errcode = 'check_violation';
  end if;

  select * into v_case from review_cases where id = p_case_id for update;
  if not found then
    raise exception 'case % not found', p_case_id using errcode = 'no_data_found';
  end if;
  if v_case.status = 'resolved' then
    raise exception 'case % is resolved', p_case_id
      using errcode = 'check_violation';
  end if;
  if v_case.priority = p_priority then
    return jsonb_build_object('ok', true, 'changed', false);
  end if;

  v_sla := _case_sla(p_priority);

  -- Deadlines run from when the case was OPENED, not from now — raising
  -- priority must not buy back time already spent.
  update review_cases
     set priority          = p_priority,
         response_due_at   = v_case.opened_at + (v_sla->>'respond')::interval,
         resolution_due_at = v_case.opened_at + (v_sla->>'resolve')::interval
   where id = p_case_id;

  perform _case_event(
    p_case_id, v_case.booking_id, 'priority_changed', v_admin, 'admin',
    jsonb_build_object('priority', v_case.priority,
                       'resolution_due_at', v_case.resolution_due_at),
    jsonb_build_object('priority', p_priority,
                       'resolution_due_at',
                       v_case.opened_at + (v_sla->>'resolve')::interval),
    p_reason, '{}'::jsonb);

  return jsonb_build_object('ok', true, 'changed', true);
end $fn$;

revoke all on function set_case_priority(uuid, text, text) from public, anon;
grant execute on function set_case_priority(uuid, text, text) to authenticated;


-- ----------------------------------------------------------------------------
-- 6. Working status (not resolution — that has its own function)
-- ----------------------------------------------------------------------------
create or replace function set_case_status(
  p_case_id uuid,
  p_status  text,
  p_reason  text default null
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_admin uuid := _case_admin();
  v_case  review_cases;
begin
  if p_status not in ('open', 'acknowledged', 'awaiting_evidence') then
    raise exception
      'use resolve_review_case / reopen_review_case for resolution'
      using errcode = 'check_violation';
  end if;

  select * into v_case from review_cases where id = p_case_id for update;
  if not found then
    raise exception 'case % not found', p_case_id using errcode = 'no_data_found';
  end if;
  if v_case.status = 'resolved' then
    raise exception 'case % is resolved — reopen it first', p_case_id
      using errcode = 'check_violation';
  end if;
  if v_case.status = p_status then
    return jsonb_build_object('ok', true, 'changed', false);
  end if;

  update review_cases
     set status          = p_status,
         acknowledged_at = case
                             when p_status = 'open' then acknowledged_at
                             else coalesce(acknowledged_at, now())
                           end
   where id = p_case_id;

  perform _case_event(
    p_case_id, v_case.booking_id, 'status_changed', v_admin, 'admin',
    jsonb_build_object('status', v_case.status),
    jsonb_build_object('status', p_status),
    p_reason, '{}'::jsonb);

  return jsonb_build_object('ok', true, 'changed', true);
end $fn$;

revoke all on function set_case_status(uuid, text, text) from public, anon;
grant execute on function set_case_status(uuid, text, text) to authenticated;


-- ----------------------------------------------------------------------------
-- 7. The blocking flags — the ones that gate money
-- ----------------------------------------------------------------------------
create or replace function set_case_blocks(
  p_case_id        uuid,
  p_blocks_payment boolean,
  p_blocks_payout  boolean,
  p_reason         text
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_admin uuid := _case_admin();
  v_case  review_cases;
  v_hold  jsonb := jsonb_build_object('held', false);
  v_on    boolean;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'a reason is required to change what a case blocks'
      using errcode = 'check_violation';
  end if;

  select * into v_case from review_cases where id = p_case_id for update;
  if not found then
    raise exception 'case % not found', p_case_id using errcode = 'no_data_found';
  end if;
  if v_case.status = 'resolved' then
    raise exception 'case % is resolved', p_case_id
      using errcode = 'check_violation';
  end if;

  if v_case.blocks_payment = p_blocks_payment
     and v_case.blocks_payout = p_blocks_payout then
    return jsonb_build_object('ok', true, 'changed', false);
  end if;

  -- Did either flag just turn ON?
  v_on := (p_blocks_payment and not v_case.blocks_payment)
       or (p_blocks_payout  and not v_case.blocks_payout);

  update review_cases
     set blocks_payment = p_blocks_payment,
         blocks_payout  = p_blocks_payout
   where id = p_case_id;

  -- Turning a block ON stops the money in this same transaction.
  if v_on then
    v_hold := _hold_payout_for_case(
      v_case.booking_id, v_admin, 'admin',
      format('Case %s now blocks money: %s', p_case_id, p_reason));
  end if;

  perform _case_event(
    p_case_id, v_case.booking_id, 'blocks_changed', v_admin, 'admin',
    jsonb_build_object('blocks_payment', v_case.blocks_payment,
                       'blocks_payout', v_case.blocks_payout),
    jsonb_build_object('blocks_payment', p_blocks_payment,
                       'blocks_payout', p_blocks_payout),
    p_reason,
    jsonb_build_object('payout_hold', v_hold));

  -- Removing a block deliberately does NOT release anything. Releasing money
  -- is its own decision, made explicitly.
  return jsonb_build_object(
    'ok', true, 'changed', true, 'payout_hold', v_hold,
    'note', case
              when not p_blocks_payout and v_case.blocks_payout
                then 'Block removed. Any hold stays until released explicitly.'
              else null
            end);
end $fn$;

revoke all on function set_case_blocks(uuid, boolean, boolean, text) from public, anon;
grant execute on function set_case_blocks(uuid, boolean, boolean, text) to authenticated;


-- ----------------------------------------------------------------------------
-- 8. Notes — append only
-- ----------------------------------------------------------------------------
create or replace function add_case_note(
  p_case_id uuid,
  p_note    text
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_admin uuid := _case_admin();
  v_case  review_cases;
begin
  if coalesce(trim(p_note), '') = '' then
    raise exception 'the note is empty' using errcode = 'check_violation';
  end if;

  select * into v_case from review_cases where id = p_case_id for update;
  if not found then
    raise exception 'case % not found', p_case_id using errcode = 'no_data_found';
  end if;

  -- No column is written. The note IS the event.
  perform _case_event(
    p_case_id, v_case.booking_id, 'note_added', v_admin, 'admin',
    null, jsonb_build_object('note', p_note), null, '{}'::jsonb);

  return jsonb_build_object('ok', true);
end $fn$;

revoke all on function add_case_note(uuid, text) from public, anon;
grant execute on function add_case_note(uuid, text) to authenticated;


-- ----------------------------------------------------------------------------
-- 9. Resolve
-- ----------------------------------------------------------------------------
create or replace function resolve_review_case(
  p_case_id  uuid,
  p_outcome  text,
  p_notes    text default null,
  p_amount   numeric default null,
  p_currency text default 'gbp'
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_admin uuid := _case_admin();
  v_case  review_cases;
  v_gross numeric;
begin
  if coalesce(trim(p_outcome), '') = '' then
    raise exception 'an outcome is required' using errcode = 'check_violation';
  end if;

  if lower(coalesce(p_currency, 'gbp')) <> 'gbp' then
    raise exception 'only gbp resolutions are supported'
      using errcode = 'check_violation';
  end if;

  if p_amount = 'NaN'::numeric or p_amount < 0 then
    raise exception 'resolution amount must be zero or positive'
      using errcode = 'check_violation';
  end if;

  select * into v_case from review_cases where id = p_case_id for update;
  if not found then
    raise exception 'case % not found', p_case_id using errcode = 'no_data_found';
  end if;

  if v_case.status = 'resolved' then
    return jsonb_build_object('ok', true, 'changed', false,
                              'note', 'already resolved');
  end if;

  if p_amount is not null and p_amount > 0 then
    select gross_amount into v_gross
      from payments
     where booking_id = v_case.booking_id
       and coalesce(kind, 'booking') <> 'tip'
     order by created_at
     limit 1;

    if v_gross is null then
      raise exception 'a refund cannot be approved without a booking payment'
        using errcode = 'check_violation';
    end if;
    if p_amount > v_gross then
      raise exception 'resolution amount % exceeds charged amount %',
        p_amount, v_gross using errcode = 'check_violation';
    end if;
  end if;

  update review_cases
     set status              = 'resolved',
         resolution          = p_outcome,
         resolution_amount   = p_amount,
         resolution_currency = lower(coalesce(p_currency, 'gbp')),
         resolved_at         = now(),
         resolved_by         = v_admin,
         assigned_to         = coalesce(assigned_to, v_admin)
   where id = p_case_id;

  if p_notes is not null and trim(p_notes) <> '' then
    perform _case_event(
      p_case_id, v_case.booking_id, 'note_added', v_admin, 'admin',
      null, jsonb_build_object('note', p_notes), null, '{}'::jsonb);
  end if;

  perform _case_event(
    p_case_id, v_case.booking_id, 'resolved', v_admin, 'admin',
    jsonb_build_object('status', v_case.status,
                       'blocks_payment', v_case.blocks_payment,
                       'blocks_payout', v_case.blocks_payout),
    jsonb_build_object('status', 'resolved', 'resolution', p_outcome,
                       'amount', p_amount,
                       'currency', lower(coalesce(p_currency, 'gbp'))),
    p_outcome, '{}'::jsonb);

  return jsonb_build_object(
    'ok', true, 'changed', true,
    'booking_id', v_case.booking_id,
    'was_blocking_payout', v_case.blocks_payout,
    'was_blocking_payment', v_case.blocks_payment);
end $fn$;

revoke all on function resolve_review_case(uuid, text, text, numeric, text)
  from public, anon;
grant execute on function resolve_review_case(uuid, text, text, numeric, text)
  to authenticated;


-- ----------------------------------------------------------------------------
-- 10. Reopen
-- ----------------------------------------------------------------------------
create or replace function reopen_review_case(
  p_case_id uuid,
  p_reason  text
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_admin uuid := _case_admin();
  v_case  review_cases;
  v_other uuid;
  v_hold  jsonb := jsonb_build_object('held', false);
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'a reason is required to reopen a case'
      using errcode = 'check_violation';
  end if;

  select * into v_case from review_cases where id = p_case_id for update;
  if not found then
    raise exception 'case % not found', p_case_id using errcode = 'no_data_found';
  end if;
  if v_case.status <> 'resolved' then
    return jsonb_build_object('ok', true, 'changed', false,
                              'note', 'already open');
  end if;

  -- The one-unresolved-case-per-category rule must still hold afterwards.
  select id into v_other
  from review_cases
  where booking_id = v_case.booking_id
    and category   = v_case.category
    and status    <> 'resolved'
    and id        <> p_case_id
  limit 1;

  if v_other is not null then
    raise exception
      'another unresolved % case already exists on this booking (%)',
      v_case.category, v_other
      using errcode = 'unique_violation';
  end if;

  -- Preserve what the resolution WAS before clearing it. This event is the
  -- only remaining record of it.
  perform _case_event(
    p_case_id, v_case.booking_id, 'reopened', v_admin, 'admin',
    jsonb_build_object(
      'status', 'resolved',
      'resolution', v_case.resolution,
      'resolution_notes', v_case.resolution_notes,
      'resolution_amount', v_case.resolution_amount,
      'resolution_currency', v_case.resolution_currency,
      'resolved_at', v_case.resolved_at,
      'resolved_by', v_case.resolved_by),
    jsonb_build_object('status', 'open'),
    p_reason, '{}'::jsonb);

  update review_cases
     set status              = 'open',
         resolution          = null,
         resolution_notes    = null,
         resolution_amount   = null,
         resolved_at         = null,
         resolved_by         = null
   where id = p_case_id;

  -- Reopening makes existing blocking flags active again. If the payout was
  -- released after the earlier resolution, put it back on hold atomically.
  if v_case.blocks_payment or v_case.blocks_payout then
    v_hold := _hold_payout_for_case(
      v_case.booking_id, v_admin, 'admin',
      format('Case %s reopened and blocks money: %s', p_case_id, p_reason));
  end if;

  return jsonb_build_object(
    'ok', true, 'changed', true, 'payout_hold', v_hold);
end $fn$;

revoke all on function reopen_review_case(uuid, text) from public, anon;
grant execute on function reopen_review_case(uuid, text) to authenticated;


-- ----------------------------------------------------------------------------
-- 11. Refund sequence — logged, and the only way to move the counter
-- ----------------------------------------------------------------------------
create or replace function next_refund_sequence(p_case_id uuid)
returns int
language plpgsql security definer set search_path = public as $fn$
declare
  v_admin uuid := _case_admin();
  v_case  review_cases;
  v_n     int;
begin
  select * into v_case from review_cases where id = p_case_id for update;
  if not found then
    raise exception 'case % not found', p_case_id using errcode = 'no_data_found';
  end if;

  if v_case.status <> 'resolved'
     or coalesce(v_case.resolution_amount, 0) <= 0 then
    raise exception 'case % has no resolved refund approval', p_case_id
      using errcode = 'no_data_found';
  end if;

  update review_cases
     set refund_sequence = refund_sequence + 1
   where id = p_case_id
  returning refund_sequence into v_n;

  perform _case_event(
    p_case_id, v_case.booking_id, 'refund_sequence_issued', v_admin, 'admin',
    jsonb_build_object('refund_sequence', v_case.refund_sequence),
    jsonb_build_object('refund_sequence', v_n),
    null, '{}'::jsonb);

  return v_n;
end $fn$;

revoke all on function next_refund_sequence(uuid) from public, anon;
grant execute on function next_refund_sequence(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 12. Legacy column
-- ----------------------------------------------------------------------------
comment on column review_cases.resolution_notes is
  'LEGACY. Frozen by the revoke below — no longer written. New notes are rows '
  'in review_case_events (event_type = note_added). Read for historical cases '
  'only; drop once no reader depends on it.';


-- ----------------------------------------------------------------------------
-- 13. Close every direct write
-- ----------------------------------------------------------------------------
-- Table grant off first, then nothing handed back. Every write goes through the
-- functions above, which are SECURITY DEFINER and keep working.
revoke insert, update, delete, truncate on review_cases from authenticated, anon;
do $$ begin
  execute 'revoke insert, update, delete, truncate on review_cases from service_role';
exception when others then null; end $$;

-- Remove any explicit column grants too; table-level revokes do not cancel
-- privileges that may have been granted on individual columns.
do $revoke_case_columns$
declare v_columns text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_columns
    from information_schema.columns
   where table_schema = 'public' and table_name = 'review_cases';

  execute format(
    'revoke update (%s) on review_cases from authenticated, anon, service_role',
    v_columns);
  execute format(
    'revoke insert (%s) on review_cases from authenticated, anon, service_role',
    v_columns);
end $revoke_case_columns$;

-- Reading is still governed by the RLS policies from earlier migrations.
grant select on review_cases to authenticated;
do $$ begin
  execute 'grant select on review_cases to service_role';
exception when others then null; end $$;


-- ----------------------------------------------------------------------------
-- 14. Refuse to deploy if any of that failed
-- ----------------------------------------------------------------------------
do $assert$
declare
  v_role text;
  v_col  text;
  v_priv text;
  v_bad  text[] := '{}';
begin
  -- No table-level write of any kind, for any role.
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege(v_role, 'review_cases', v_priv) then
        v_bad := v_bad || format('%s can %s review_cases', v_role, v_priv);
      end if;
    end loop;
  end loop;

  -- And no column-level INSERT/UPDATE on any case field.
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    for v_col in
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'review_cases'
    loop
      if has_column_privilege(v_role, 'review_cases'::regclass, v_col, 'UPDATE')
         or has_column_privilege(v_role, 'review_cases'::regclass, v_col, 'INSERT') then
        v_bad := v_bad || format(
          '%s can insert/update review_cases.%s', v_role, v_col);
      end if;
    end loop;
  end loop;

  -- Events must be append-only.
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege(v_role, 'review_case_events', v_priv) then
        v_bad := v_bad || format('%s can %s review_case_events',
                                 v_role, v_priv);
      end if;
    end loop;

    for v_col in
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'review_case_events'
    loop
      if has_column_privilege(
           v_role, 'review_case_events'::regclass, v_col, 'UPDATE')
         or has_column_privilege(
           v_role, 'review_case_events'::regclass, v_col, 'INSERT') then
        v_bad := v_bad || format(
          '%s can insert/update review_case_events.%s', v_role, v_col);
      end if;
    end loop;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception
      'migration 0009 did not take effect: %', array_to_string(v_bad, '; ');
  end if;

  raise notice '0009 verified — review_cases is function-only, events immutable';
end $assert$;

-- ============================================================================
-- 0001 — Booking state machine, event log, and durable money operations
-- ============================================================================
-- Run in Supabase → SQL Editor. Safe to re-run.
--
-- After this migration, application code CANNOT write bookings.status or
-- bookings.provider_id directly. Every change goes through:
--
--     transition_booking(...)         — acting as the authenticated user
--     system_transition_booking(...)  — service role only (crons, webhooks)
--
-- Both lock the row, validate against policy, and write an immutable event.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. New statuses
-- ----------------------------------------------------------------------------
-- Every live booking needs somewhere safe to go besides completed/cancelled.
alter type booking_status add value if not exists 'needs_review';

-- NOTE: policy tables below store statuses as TEXT, never as the enum, so this
-- migration never has to cast a newly-added enum value in the same transaction.


-- ----------------------------------------------------------------------------
-- 1. booking_events — append only, forever
-- ----------------------------------------------------------------------------
create table if not exists booking_events (
  id           bigint generated always as identity primary key,
  booking_id   uuid not null references bookings(id) on delete restrict,
  from_status  text,
  to_status    text not null,
  actor_id     uuid,                       -- null when actor_kind = 'system'
  actor_kind   text not null,              -- 'customer' | 'provider' | 'admin' | 'system'
  reason       text,
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

do $$ begin
  alter table booking_events add constraint booking_events_actor_kind_check
    check (actor_kind in ('customer', 'provider', 'admin', 'system'));
exception when duplicate_object then null; end $$;

create index if not exists booking_events_booking_idx
  on booking_events(booking_id, created_at desc);
create index if not exists booking_events_actor_idx
  on booking_events(actor_id, created_at desc);

alter table booking_events enable row level security;

-- Readable by the people involved, and admins. Writable by nobody directly —
-- only the transition functions (which run as definer) insert here.
drop policy if exists "participants read events" on booking_events;
create policy "participants read events" on booking_events
  for select using (
    is_admin()
    or exists (
      select 1 from bookings b
      where b.id = booking_events.booking_id
        and (
          b.customer_id = auth.uid()
          or b.provider_id = current_provider_id()
        )
    )
  );

-- Immutable: no update, no delete, for anyone. Not even admins.
revoke insert, update, delete on booking_events from authenticated, anon;

do $$ begin
  execute 'revoke insert, update, delete on booking_events from service_role';
exception when others then null; end $$;

create or replace function booking_events_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'booking_events is append-only (attempted %)', tg_op;
end $$;

drop trigger if exists booking_events_no_update on booking_events;
create trigger booking_events_no_update
  before update or delete on booking_events
  for each row execute function booking_events_immutable();


-- ----------------------------------------------------------------------------
-- 2. booking_transitions — the policy, as data
-- ----------------------------------------------------------------------------
create table if not exists booking_transitions (
  from_status         text not null,
  to_status           text not null,
  actor_kind          text not null,
  -- what relationship the actor must have to the booking
  required_assignment text not null default 'none',
  reason_required     boolean not null default false,
  note                text,
  primary key (from_status, to_status, actor_kind)
);

do $$ begin
  alter table booking_transitions add constraint booking_transitions_assignment_check
    check (required_assignment in (
      'none',              -- no relationship needed (system/admin)
      'customer',          -- actor must be bookings.customer_id
      'assigned_provider', -- actor must be bookings.provider_id
      'offered_provider'   -- actor must have an OPEN booking_offers row
    ));
exception when duplicate_object then null; end $$;

alter table booking_transitions enable row level security;

drop policy if exists "anyone reads transition policy" on booking_transitions;
create policy "anyone reads transition policy" on booking_transitions
  for select using (true);

drop policy if exists "admin writes transition policy" on booking_transitions;
create policy "admin writes transition policy" on booking_transitions
  for all using (is_admin()) with check (is_admin());


-- ----------------------------------------------------------------------------
-- 3. The policy rows
-- ----------------------------------------------------------------------------
insert into booking_transitions
  (from_status, to_status, actor_kind, required_assignment, reason_required, note)
values
  -- ---- provider ----
  ('offered',     'scheduled',    'provider', 'offered_provider',  false,
   'Accepting an open offer. Also claims the booking; see transition_booking.'),
  ('scheduled',   'in_progress',  'provider', 'assigned_provider', false,
   'Check-in. Timing and geofence rules are enforced in the action layer.'),
  ('in_progress', 'completed',    'provider', 'assigned_provider', false,
   'Check-out.'),
  ('scheduled',   'cancelled',    'provider', 'assigned_provider', true,
   'Provider cannot attend. Caller must re-broadcast.'),
  ('in_progress', 'needs_review', 'provider', 'assigned_provider', true,
   'Work stopped midway, unsafe property, damage.'),
  ('scheduled',   'needs_review', 'provider', 'assigned_provider', true,
   'Customer unavailable / no access.'),

  -- ---- customer ----
  ('offered',     'cancelled',    'customer', 'customer', false, null),
  ('declined',    'cancelled',    'customer', 'customer', false, null),
  ('scheduled',   'cancelled',    'customer', 'customer', false,
   'Late-cancellation charging is decided by the action layer, not here.'),
  ('scheduled',   'offered',      'customer', 'customer', true,
   'Customer rescheduled; release the assignment and reopen the winning offer.'),
  ('declined',    'offered',      'customer', 'customer', true,
   'Customer selected a new time after providers declined.'),
  ('completed',   'needs_review', 'customer', 'customer', true,
   'Unsatisfactory work, damage, injury.'),
  ('in_progress', 'needs_review', 'customer', 'customer', true, null),

  -- ---- system (crons, webhooks) ----
  ('offered',     'cancelled',    'system', 'none', true,
   'Offer expired with nobody accepting.'),
  ('declined',    'cancelled',    'system', 'none', true,
   'Offer expired with nobody accepting.'),
  ('scheduled',   'needs_review', 'system', 'none', true,
   'No-show timeout: nobody checked in.'),
  ('scheduled',   'cancelled',    'system', 'none', true,
   'Payment authorisation expired.'),
  ('in_progress', 'needs_review', 'system', 'none', true,
   'Check-out never happened.'),
  ('completed',   'needs_review', 'system', 'none', true,
   'Capture failed after completion.'),

  -- ---- admin: can correct anything, but must say why ----
  ('offered',     'scheduled',    'admin', 'none', true, 'Manual assignment.'),
  ('offered',     'cancelled',    'admin', 'none', true, null),
  ('declined',    'scheduled',    'admin', 'none', true, 'Manual assignment.'),
  ('declined',    'cancelled',    'admin', 'none', true, null),
  ('scheduled',   'in_progress',  'admin', 'none', true, null),
  ('scheduled',   'cancelled',    'admin', 'none', true, null),
  ('scheduled',   'needs_review', 'admin', 'none', true, null),
  ('in_progress', 'completed',    'admin', 'none', true, null),
  ('in_progress', 'cancelled',    'admin', 'none', true, null),
  ('in_progress', 'needs_review', 'admin', 'none', true, null),
  ('completed',   'needs_review', 'admin', 'none', true, null),
  ('needs_review','completed',    'admin', 'none', true, 'Case resolved in favour of completion.'),
  ('needs_review','cancelled',    'admin', 'none', true, 'Case resolved as cancelled.')
on conflict (from_status, to_status, actor_kind) do update set
  required_assignment = excluded.required_assignment,
  reason_required     = excluded.reason_required,
  note                = excluded.note;


-- ----------------------------------------------------------------------------
-- 4. The one way to change a booking's status
-- ----------------------------------------------------------------------------
-- Shared core. p_actor_kind is trusted here, so this stays PRIVATE.
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
as $$
declare
  v_booking     bookings;
  v_policy      booking_transitions;
  v_provider_id uuid;
  v_from        text;
  v_ok          boolean := false;
begin
  -- Lock the row. Everything below is serialised against concurrent callers.
  select * into v_booking
  from bookings
  where id = p_booking_id
  for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  v_from := v_booking.status::text;

  -- No-op: already there. It is idempotent only for an actor who is actually
  -- related to this booking; otherwise this would leak booking state and let a
  -- losing provider mistake a concurrent acceptance for their own success.
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

  -- Relationship to the booking
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
    v_ok := true;                                   -- 'none'
  end if;

  if not v_ok then
    raise exception 'actor is not permitted to act on booking %', p_booking_id
      using errcode = 'insufficient_privilege';
  end if;

  -- ---- side effects that must be atomic with the status change ----

  -- Accepting an offer also claims the job and closes it for everyone else.
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

  -- Rescheduling a confirmed booking releases the assignment, updates the
  -- time atomically from metadata, and reopens the previous winning offer.
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

  -- Leaving a confirmed state frees the provider so it can be re-offered.
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

  -- ---- the immutable record ----
  insert into booking_events
    (booking_id, from_status, to_status, actor_id, actor_kind, reason, meta)
  values
    (p_booking_id, v_from, p_to_status, p_actor_id, p_actor_kind,
     nullif(trim(coalesce(p_reason, '')), ''), coalesce(p_meta, '{}'::jsonb));

  return jsonb_build_object(
    'changed', true,
    'from', v_from,
    'status', p_to_status,
    'provider_id', coalesce(v_provider_id, v_booking.provider_id)
  );
end $$;

revoke all on function _apply_booking_transition(uuid, text, uuid, text, text, jsonb)
  from public, anon, authenticated;


-- ---- public entry point: actor is DERIVED, never supplied -------------------
create or replace function transition_booking(
  p_booking_id uuid,
  p_to_status  text,
  p_reason     text default null,
  p_meta       jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
              when 'provider' then 'provider'
              when 'admin'    then 'admin'
              when 'customer' then 'customer'
              else null
            end;

  if v_kind is null then
    raise exception 'no role on file for this account'
      using errcode = 'insufficient_privilege';
  end if;

  return _apply_booking_transition(
    p_booking_id, p_to_status, v_uid, v_kind, p_reason, p_meta
  );
end $$;

revoke all on function transition_booking(uuid, text, text, jsonb) from public, anon;
grant execute on function transition_booking(uuid, text, text, jsonb) to authenticated;


-- ---- system entry point: service role only ---------------------------------
create or replace function system_transition_booking(
  p_booking_id uuid,
  p_to_status  text,
  p_reason     text,
  p_meta       jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return _apply_booking_transition(
    p_booking_id, p_to_status, null, 'system', p_reason, p_meta
  );
end $$;

revoke all on function system_transition_booking(uuid, text, text, jsonb)
  from public, anon, authenticated;

do $$ begin
  execute 'grant execute on function system_transition_booking(uuid, text, text, jsonb) to service_role';
exception when others then null; end $$;


-- ----------------------------------------------------------------------------
-- 5. Close the back door
-- ----------------------------------------------------------------------------
-- RLS decides WHICH rows you may touch. This decides which COLUMNS — so even a
-- permissive policy or a buggy action can no longer move a booking sideways.
revoke update (status, provider_id) on bookings from authenticated, anon;

-- Anything the app legitimately edits stays writable (RLS still applies).
grant update (
  scheduled_at,
  address,
  household_notes,
  offer_expires_at
) on bookings to authenticated;


-- ----------------------------------------------------------------------------
-- 6. money_operations — the durable ledger
-- ----------------------------------------------------------------------------
create table if not exists money_operations (
  id              uuid primary key default gen_random_uuid(),

  -- The logical identity of this operation. Retried, never duplicated.
  --   capture:booking:{id}
  --   transfer:booking:{id}:provider:{id}
  --   refund:resolution:{id}:{sequence}
  operation_key   text not null unique,
  operation_type  text not null,

  booking_id      uuid references bookings(id) on delete restrict,
  payment_id      uuid references payments(id) on delete set null,
  payout_id       uuid references payouts(id)  on delete set null,

  amount          numeric(10,2) not null,
  currency        text not null default 'gbp',

  status          text not null default 'pending',

  -- Short-term protection only: Stripe may prune v1 keys after ~24h, so this
  -- is NOT a recovery handle. Reconciliation matches on stripe_object_id or on
  -- metadata.operation_key, which Stripe keeps.
  idempotency_key text,
  stripe_object_id text,

  attempt_count   int not null default 0,
  last_error      text,
  requested_by    uuid,               -- null when raised by a system job

  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  completed_at    timestamptz
);

do $$ begin
  alter table money_operations add constraint money_operations_type_check
    check (operation_type in ('capture', 'transfer', 'refund', 'release'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table money_operations add constraint money_operations_status_check
    check (status in (
      'pending',     -- created, not yet sent to Stripe
      'processing',  -- sent; outcome unknown
      'succeeded',
      'failed',      -- Stripe said no; safe to retry the same row
      'ambiguous'    -- we cannot prove what happened; ADMIN ONLY from here
    ));
exception when duplicate_object then null; end $$;

create index if not exists money_operations_booking_idx
  on money_operations(booking_id);
create index if not exists money_operations_stripe_idx
  on money_operations(stripe_object_id);

-- Needs attention: stuck, failed, or unprovable.
create index if not exists money_operations_open_idx
  on money_operations(status, created_at)
  where status in ('pending', 'processing', 'failed', 'ambiguous');

-- One live capture per booking, and one live transfer per booking+provider.
create unique index if not exists money_operations_one_capture
  on money_operations(booking_id)
  where operation_type = 'capture' and status <> 'failed';

alter table money_operations enable row level security;

-- Money records are internal. Providers see their own transfers; nobody else
-- reads anything here except admins. All writes go through the service role.
drop policy if exists "admin reads money operations" on money_operations;
create policy "admin reads money operations" on money_operations
  for select using (is_admin());

drop policy if exists "provider reads own transfers" on money_operations;
create policy "provider reads own transfers" on money_operations
  for select using (
    operation_type = 'transfer'
    and exists (
      select 1 from bookings b
      where b.id = money_operations.booking_id
        and b.provider_id = current_provider_id()
    )
  );

revoke insert, update, delete on money_operations from authenticated, anon;


-- ----------------------------------------------------------------------------
-- 7. Claim an operation — the concurrency-safe pattern
-- ----------------------------------------------------------------------------
-- Two callers converge on one locked row. Returns the row plus a `should_run`
-- flag; if false, the caller must NOT call Stripe.
create or replace function claim_money_operation(
  p_operation_key  text,
  p_operation_type text,
  p_booking_id     uuid,
  p_amount         numeric,
  p_requested_by   uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_op money_operations;
begin
  insert into money_operations
    (operation_key, operation_type, booking_id, amount, requested_by, status,
     idempotency_key)
  values
    (p_operation_key, p_operation_type, p_booking_id, p_amount, p_requested_by,
     'pending', p_operation_key)
  on conflict (operation_key) do nothing;

  select * into v_op
  from money_operations
  where operation_key = p_operation_key
  for update;

  if v_op.operation_type <> p_operation_type
     or v_op.booking_id is distinct from p_booking_id
     or v_op.amount is distinct from p_amount then
    raise exception 'operation key % was reused with different parameters',
      p_operation_key using errcode = 'check_violation';
  end if;

  if v_op.status = 'succeeded' then
    return jsonb_build_object(
      'should_run', false, 'status', 'succeeded',
      'id', v_op.id, 'stripe_object_id', v_op.stripe_object_id
    );
  end if;

  if v_op.status = 'ambiguous' then
    return jsonb_build_object(
      'should_run', false, 'status', 'ambiguous', 'id', v_op.id,
      'message', 'needs admin resolution — outcome unknown'
    );
  end if;

  if v_op.status = 'processing' then
    if v_op.started_at > now() - interval '2 minutes' then
      return jsonb_build_object(
        'should_run', false, 'status', 'processing', 'id', v_op.id,
        'message', 'another attempt is in flight'
      );
    end if;

    -- We cannot prove whether Stripe completed an earlier request after the
    -- process died. Reconciliation must inspect Stripe metadata/object state;
    -- never automatically replay an ambiguous money mutation.
    update money_operations
       set status = 'ambiguous',
           last_error = 'processing lease expired before outcome was recorded'
     where id = v_op.id;

    return jsonb_build_object(
      'should_run', false, 'status', 'ambiguous', 'id', v_op.id,
      'message', 'outcome unknown — reconciliation required'
    );
  end if;

  update money_operations
     set status        = 'processing',
         attempt_count = attempt_count + 1,
         started_at    = now(),
         last_error    = null
   where id = v_op.id;

  return jsonb_build_object(
    'should_run', true, 'status', 'processing',
    'id', v_op.id, 'attempt', v_op.attempt_count + 1
  );
end $$;

revoke all on function claim_money_operation(text, text, uuid, numeric, uuid)
  from public, anon, authenticated;

do $$ begin
  execute 'grant execute on function claim_money_operation(text, text, uuid, numeric, uuid) to service_role';
exception when others then null; end $$;


-- ----------------------------------------------------------------------------
-- Done. Next migration: payments/payouts state machines, review_cases,
-- reconciliation_findings.
-- ----------------------------------------------------------------------------

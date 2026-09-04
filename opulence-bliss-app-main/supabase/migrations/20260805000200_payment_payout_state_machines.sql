-- ============================================================================
-- 0002 — Payment & payout state machines, review cases, reconciliation
-- ============================================================================
-- Run AFTER 0001. Safe to re-run.
--
-- ⚠ DO NOT APPLY TO PRODUCTION BEFORE THE APPLICATION REFACTOR.
--   This migration revokes UPDATE (status) on payments and payouts from EVERY
--   role, including service_role. Any code still writing those columns
--   directly will start failing the moment this lands.
--
--   INSERTs may still set an initial status — only UPDATEs are closed off.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Payment lifecycle
-- ----------------------------------------------------------------------------
--   created → authorised → capturing → succeeded
--                             ↘ capture_failed → capturing (retry)
--   authorised → cancelling → cancelled
--   succeeded → refund_pending → refunded | partially_refunded
--                             ↘ back to succeeded if the refund fails
-- ----------------------------------------------------------------------------

-- Period bounds let us answer "which invoice covers this visit?" precisely,
-- rather than inferring it. Populated by the subscription webhook.
alter table payments add column if not exists period_start timestamptz;
alter table payments add column if not exists period_end   timestamptz;
alter table payments add column if not exists status_changed_at timestamptz
  not null default now();

-- The original schema used a narrow payment_status enum. The state machine is
-- policy-table driven, so the column must be text before new states can land.
-- Keep the old enum type itself for rollback/forensics; only detach the column.
alter table payments alter column status drop default;
alter table payments alter column status type text using status::text;
alter table payments alter column status set default 'created';

-- Map only the legacy value whose meaning is unambiguous.
-- 'pending' was an uncaptured authorisation.
update payments set status = 'authorised' where status = 'pending';

-- Legacy 'refunded' rows are deliberately left as refunded. Existing code used
-- that value for both released authorisations and genuine post-capture refunds;
-- rewriting them to cancelled would fabricate financial history. Reconciliation
-- must classify/backfill those rows from Stripe.

do $$ begin
  alter table payments add constraint payments_status_check
    check (status in (
      'created',
      'authorised',
      'capturing',
      'succeeded',
      'capture_failed',
      'failed', -- legacy, unresolved; reconciliation must classify it
      'cancelling',
      'cancelled',
      'refund_pending',
      'partially_refunded',
      'refunded'
    ));
exception when duplicate_object then null; end $$;

create table if not exists payment_events (
  id          bigint generated always as identity primary key,
  payment_id  uuid not null references payments(id) on delete restrict,
  from_status text,
  to_status   text not null,
  actor_id    uuid,
  actor_kind  text not null check (actor_kind in ('admin', 'system')),
  reason      text,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists payment_events_payment_idx
  on payment_events(payment_id, created_at desc);

alter table payment_events enable row level security;

drop policy if exists "admin reads payment events" on payment_events;
create policy "admin reads payment events" on payment_events
  for select using (is_admin());

revoke insert, update, delete on payment_events from authenticated, anon;
do $$ begin
  execute 'revoke insert, update, delete on payment_events from service_role';
exception when others then null; end $$;

create table if not exists payment_transitions (
  from_status     text not null,
  to_status       text not null,
  actor_kind      text not null,
  reason_required boolean not null default false,
  note            text,
  primary key (from_status, to_status, actor_kind)
);

alter table payment_transitions enable row level security;
drop policy if exists "anyone reads payment policy" on payment_transitions;
create policy "anyone reads payment policy" on payment_transitions
  for select using (true);

insert into payment_transitions
  (from_status, to_status, actor_kind, reason_required, note)
values
  -- happy path, driven by our own code and Stripe webhooks
  ('created',        'authorised',         'system', false, 'Checkout completed, card held.'),
  ('authorised',     'capturing',          'system', false, 'Capture started at check-out.'),
  ('capturing',      'succeeded',          'system', false, 'Capture confirmed.'),
  ('capturing',      'capture_failed',     'system', true,  'Stripe declined the capture.'),
  ('capture_failed', 'capturing',          'system', false, 'Retrying the same operation.'),
  ('authorised',     'cancelling',         'system', false, 'Releasing an unused hold.'),
  ('cancelling',     'cancelled',          'system', false, 'Hold released.'),
  ('cancelling',     'authorised',         'system', true,  'Hold release failed.'),
  ('authorised',     'cancelled',          'system', true,  'Authorisation expired at Stripe.'),
  ('succeeded',      'refund_pending',     'system', true,  'Refund approved by a resolution.'),
  ('refund_pending', 'refunded',           'system', false, null),
  ('refund_pending', 'partially_refunded', 'system', false, null),
  ('refund_pending', 'succeeded',          'system', true,  'Refund failed; back to charged.'),
  ('partially_refunded', 'refund_pending', 'system', true,  'A further partial refund.'),

  -- admins may correct anything, with a reason, and it is logged
  ('created',        'cancelled',          'admin', true, null),
  ('authorised',     'cancelling',         'admin', true, null),
  ('cancelling',     'authorised',         'admin', true, 'Hold release failed.'),
  ('authorised',     'capturing',          'admin', true, null),
  ('capturing',      'capture_failed',     'admin', true, null),
  ('capture_failed', 'capturing',          'admin', true, 'Manual retry.'),
  ('capture_failed', 'cancelled',          'admin', true, 'Written off.'),
  ('succeeded',      'refund_pending',     'admin', true, null),
  ('refund_pending', 'succeeded',          'admin', true, null),
  ('refund_pending', 'refunded',           'admin', true, null),
  ('refund_pending', 'partially_refunded', 'admin', true, null)
on conflict (from_status, to_status, actor_kind) do update set
  reason_required = excluded.reason_required,
  note            = excluded.note;


-- ----------------------------------------------------------------------------
-- 2. Payout lifecycle
-- ----------------------------------------------------------------------------
--   not_ready → pending → processing → paid
--                            ↘ failed → processing (retry)
--                            ↘ held   → pending (released)
--   paid → reversed
-- ----------------------------------------------------------------------------

alter table payouts add column if not exists status_changed_at timestamptz
  not null default now();
alter table payouts add column if not exists held_reason text;

-- Likewise, the original payout_status enum only knew pending/paid/failed.
alter table payouts alter column status drop default;
alter table payouts alter column status type text using status::text;
alter table payouts alter column status set default 'not_ready';

-- Old values were 'pending' (unpaid, attempt may have failed) and 'paid'.
-- 'pending' is left as-is deliberately: reconciliation should decide whether
-- each one actually failed rather than us guessing here.
do $$ begin
  alter table payouts add constraint payouts_status_check
    check (status in (
      'not_ready',
      'pending',
      'processing',
      'paid',
      'failed',
      'held',
      'reversed'
    ));
exception when duplicate_object then null; end $$;

create table if not exists payout_events (
  id          bigint generated always as identity primary key,
  payout_id   uuid not null references payouts(id) on delete restrict,
  from_status text,
  to_status   text not null,
  actor_id    uuid,
  actor_kind  text not null check (actor_kind in ('admin', 'system')),
  reason      text,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists payout_events_payout_idx
  on payout_events(payout_id, created_at desc);

alter table payout_events enable row level security;

drop policy if exists "admin reads payout events" on payout_events;
create policy "admin reads payout events" on payout_events
  for select using (is_admin());

drop policy if exists "provider reads own payout events" on payout_events;
create policy "provider reads own payout events" on payout_events
  for select using (
    exists (
      select 1 from payouts p
      where p.id = payout_events.payout_id
        and p.provider_id = current_provider_id()
    )
  );

revoke insert, update, delete on payout_events from authenticated, anon;
do $$ begin
  execute 'revoke insert, update, delete, truncate on payment_events from service_role';
  execute 'revoke insert, update, delete, truncate on payout_events from service_role';
exception when others then null; end $$;

create or replace function financial_events_immutable()
returns trigger language plpgsql as $$
begin
  raise exception '% is append-only (attempted %)', tg_table_name, tg_op;
end $$;

drop trigger if exists payment_events_no_update on payment_events;
create trigger payment_events_no_update
  before update or delete on payment_events
  for each row execute function financial_events_immutable();

drop trigger if exists payout_events_no_update on payout_events;
create trigger payout_events_no_update
  before update or delete on payout_events
  for each row execute function financial_events_immutable();

create table if not exists payout_transitions (
  from_status     text not null,
  to_status       text not null,
  actor_kind      text not null,
  reason_required boolean not null default false,
  note            text,
  primary key (from_status, to_status, actor_kind)
);

alter table payout_transitions enable row level security;
drop policy if exists "anyone reads payout policy" on payout_transitions;
create policy "anyone reads payout policy" on payout_transitions
  for select using (true);

insert into payout_transitions
  (from_status, to_status, actor_kind, reason_required, note)
values
  ('not_ready',  'pending',    'system', true,  'Work complete AND funds received.'),
  ('not_ready',  'held',       'system', true,  'A review case blocks this payout.'),
  ('pending',    'processing', 'system', false, 'Transfer started.'),
  ('pending',    'held',       'system', true,  'Blocked before sending.'),
  ('processing', 'paid',       'system', false, 'Transfer confirmed.'),
  ('processing', 'failed',     'system', true,  'Stripe rejected the transfer.'),
  ('failed',     'processing', 'system', false, 'Retrying the same operation.'),
  ('held',       'pending',    'system', true,  'Hold lifted.'),
  ('paid',       'reversed',   'system', true,  'Transfer reversed at Stripe.'),

  ('not_ready',  'pending',    'admin', true, 'Released manually.'),
  ('not_ready',  'held',       'admin', true, null),
  ('pending',    'held',       'admin', true, null),
  ('pending',    'processing', 'admin', true, 'Manual send.'),
  ('processing', 'failed',     'admin', true, null),
  ('failed',     'processing', 'admin', true, 'Manual retry.'),
  ('failed',     'held',       'admin', true, null),
  ('held',       'pending',    'admin', true, null),
  ('paid',       'reversed',   'admin', true, null)
on conflict (from_status, to_status, actor_kind) do update set
  reason_required = excluded.reason_required,
  note            = excluded.note;


-- ----------------------------------------------------------------------------
-- 3. The transition functions
-- ----------------------------------------------------------------------------

-- ---- payments ----
create or replace function _apply_payment_transition(
  p_payment_id uuid,
  p_to_status  text,
  p_actor_id   uuid,
  p_actor_kind text,
  p_reason     text,
  p_meta       jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row    payments;
  v_policy payment_transitions;
  v_from   text;
begin
  select * into v_row from payments where id = p_payment_id for update;
  if not found then
    raise exception 'payment % not found', p_payment_id using errcode = 'no_data_found';
  end if;

  v_from := v_row.status;
  if v_from = p_to_status then
    return jsonb_build_object('changed', false, 'status', v_from);
  end if;

  select * into v_policy from payment_transitions
   where from_status = v_from and to_status = p_to_status and actor_kind = p_actor_kind;

  if not found then
    raise exception 'payment transition %→% not permitted for %',
      v_from, p_to_status, p_actor_kind using errcode = 'check_violation';
  end if;

  if v_policy.reason_required and coalesce(trim(p_reason), '') = '' then
    raise exception 'a reason is required for payment %→%', v_from, p_to_status
      using errcode = 'check_violation';
  end if;

  update payments
     set status = p_to_status, status_changed_at = now()
   where id = p_payment_id;

  insert into payment_events
    (payment_id, from_status, to_status, actor_id, actor_kind, reason, meta)
  values
    (p_payment_id, v_from, p_to_status, p_actor_id, p_actor_kind,
     nullif(trim(coalesce(p_reason, '')), ''), coalesce(p_meta, '{}'::jsonb));

  return jsonb_build_object('changed', true, 'from', v_from, 'status', p_to_status);
end $$;

revoke all on function _apply_payment_transition(uuid, text, uuid, text, text, jsonb)
  from public, anon, authenticated;

create or replace function transition_payment(
  p_payment_id uuid,
  p_to_status  text,
  p_reason     text default null,
  p_meta       jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or not is_admin() then
    raise exception 'payments may only be corrected by an admin'
      using errcode = 'insufficient_privilege';
  end if;
  return _apply_payment_transition(
    p_payment_id, p_to_status, v_uid, 'admin', p_reason, p_meta);
end $$;

revoke all on function transition_payment(uuid, text, text, jsonb) from public, anon;
grant execute on function transition_payment(uuid, text, text, jsonb) to authenticated;

create or replace function system_transition_payment(
  p_payment_id uuid,
  p_to_status  text,
  p_reason     text default null,
  p_meta       jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return _apply_payment_transition(
    p_payment_id, p_to_status, null, 'system', p_reason, p_meta);
end $$;

revoke all on function system_transition_payment(uuid, text, text, jsonb)
  from public, anon, authenticated;
do $$ begin
  execute 'grant execute on function system_transition_payment(uuid, text, text, jsonb) to service_role';
exception when others then null; end $$;


-- ---- payouts ----
create or replace function _apply_payout_transition(
  p_payout_id  uuid,
  p_to_status  text,
  p_actor_id   uuid,
  p_actor_kind text,
  p_reason     text,
  p_meta       jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row    payouts;
  v_policy payout_transitions;
  v_from   text;
begin
  select * into v_row from payouts where id = p_payout_id for update;
  if not found then
    raise exception 'payout % not found', p_payout_id using errcode = 'no_data_found';
  end if;

  v_from := v_row.status;
  if v_from = p_to_status then
    return jsonb_build_object('changed', false, 'status', v_from);
  end if;

  select * into v_policy from payout_transitions
   where from_status = v_from and to_status = p_to_status and actor_kind = p_actor_kind;

  if not found then
    raise exception 'payout transition %→% not permitted for %',
      v_from, p_to_status, p_actor_kind using errcode = 'check_violation';
  end if;

  if v_policy.reason_required and coalesce(trim(p_reason), '') = '' then
    raise exception 'a reason is required for payout %→%', v_from, p_to_status
      using errcode = 'check_violation';
  end if;

  update payouts
     set status            = p_to_status,
         status_changed_at = now(),
         held_reason       = case
                               when p_to_status = 'held' then p_reason
                               when p_to_status = 'pending' then null
                               else held_reason
                             end
   where id = p_payout_id;

  insert into payout_events
    (payout_id, from_status, to_status, actor_id, actor_kind, reason, meta)
  values
    (p_payout_id, v_from, p_to_status, p_actor_id, p_actor_kind,
     nullif(trim(coalesce(p_reason, '')), ''), coalesce(p_meta, '{}'::jsonb));

  return jsonb_build_object('changed', true, 'from', v_from, 'status', p_to_status);
end $$;

revoke all on function _apply_payout_transition(uuid, text, uuid, text, text, jsonb)
  from public, anon, authenticated;

create or replace function transition_payout(
  p_payout_id uuid,
  p_to_status text,
  p_reason    text default null,
  p_meta      jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or not is_admin() then
    raise exception 'payouts may only be corrected by an admin'
      using errcode = 'insufficient_privilege';
  end if;
  return _apply_payout_transition(
    p_payout_id, p_to_status, v_uid, 'admin', p_reason, p_meta);
end $$;

revoke all on function transition_payout(uuid, text, text, jsonb) from public, anon;
grant execute on function transition_payout(uuid, text, text, jsonb) to authenticated;

create or replace function system_transition_payout(
  p_payout_id uuid,
  p_to_status text,
  p_reason    text default null,
  p_meta      jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return _apply_payout_transition(
    p_payout_id, p_to_status, null, 'system', p_reason, p_meta);
end $$;

revoke all on function system_transition_payout(uuid, text, text, jsonb)
  from public, anon, authenticated;
do $$ begin
  execute 'grant execute on function system_transition_payout(uuid, text, text, jsonb) to service_role';
exception when others then null; end $$;


-- ----------------------------------------------------------------------------
-- 4. Funding → payout readiness
-- ----------------------------------------------------------------------------
-- BOTH conditions must hold. An invoice being paid establishes funding; it does
-- not release a per-visit payout before that visit is done.
--
--   one-off:     booking completed AND its capture succeeded
--   membership:  booking completed AND the covering invoice is paid
--
-- Idempotent. Call after check-out, after capture success, and after
-- invoice.paid. Reconciliation only reports findings and never calls this
-- mutating function. Never releases a held payout — that needs an admin.
create or replace function maybe_release_payout(p_booking_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_booking bookings;
  v_payout  payouts;
  v_funded  boolean := false;
  v_why     text;
begin
  select * into v_booking
  from bookings
  where id = p_booking_id
  for update;
  if not found then
    return jsonb_build_object('released', false, 'reason', 'no such booking');
  end if;

  if v_booking.status::text <> 'completed' then
    return jsonb_build_object('released', false, 'reason', 'work not complete');
  end if;

  select * into v_payout
  from payouts
  where booking_id = p_booking_id
  order by created_at
  limit 1
  for update;

  if not found then
    return jsonb_build_object('released', false, 'reason', 'no payout row');
  end if;

  if v_payout.status <> 'not_ready' then
    return jsonb_build_object('released', false, 'status', v_payout.status,
                              'reason', 'not awaiting release');
  end if;

  if v_booking.subscription_id is null then
    -- One-off: the customer's own payment must have captured.
    select exists (
      select 1 from payments
       where booking_id = p_booking_id
         and coalesce(kind, 'booking') <> 'tip'
         and status = 'succeeded'
    ) into v_funded;
    v_why := 'per-visit capture succeeded';
  else
    -- Membership: an invoice covering this visit must be paid.
    select exists (
      select 1 from payments
       where subscription_id = v_booking.subscription_id
         and kind = 'subscription'
         and status = 'succeeded'
         and period_start is not null
         and period_end is not null
         and v_booking.scheduled_at >= period_start
         and v_booking.scheduled_at < period_end
    ) into v_funded;
    v_why := 'covering invoice paid';
  end if;

  if not v_funded then
    return jsonb_build_object('released', false, 'reason', 'funds not received');
  end if;

  -- Anything blocking payment or payout on this booking wins.
  if exists (
    select 1 from review_cases
     where booking_id = p_booking_id
       and status <> 'resolved'
       and (blocks_payment or blocks_payout)
  ) then
    perform _apply_payout_transition(
      v_payout.id, 'held', null, 'system',
      'An open review case blocks this payout', '{}'::jsonb);
    return jsonb_build_object('released', false, 'reason', 'held by review case');
  end if;

  perform _apply_payout_transition(
    v_payout.id, 'pending', null, 'system',
    'Work complete and ' || v_why, '{}'::jsonb);

  return jsonb_build_object('released', true, 'payout_id', v_payout.id);
end $$;

revoke all on function maybe_release_payout(uuid) from public, anon, authenticated;
do $$ begin
  execute 'grant execute on function maybe_release_payout(uuid) to service_role';
exception when others then null; end $$;


-- ----------------------------------------------------------------------------
-- 5. review_cases — owned, deadlined, and explicit about what it blocks
-- ----------------------------------------------------------------------------
create table if not exists review_cases (
  id                uuid primary key default gen_random_uuid(),
  booking_id        uuid references bookings(id) on delete restrict,

  category          text not null,
  priority          text not null default 'normal',
  status            text not null default 'open',

  blocks_payment    boolean not null default false,
  blocks_payout     boolean not null default false,

  assigned_to       uuid references profiles(id) on delete set null,

  opened_at         timestamptz not null default now(),
  response_due_at   timestamptz,
  resolution_due_at timestamptz,
  acknowledged_at   timestamptz,
  resolved_at       timestamptz,

  resolution        text,
  resolution_notes  text,
  created_by        uuid,
  created_at        timestamptz not null default now()
);

do $$ begin
  alter table review_cases add constraint review_cases_category_check
    check (category in (
      'worker_no_show',
      'client_unavailable',
      'late_cancellation',
      'work_stopped',
      'unsafe_property',
      'damage_or_injury',
      'quality_complaint',
      'payment_failure',
      'payout_failure',
      'other'
    ));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table review_cases add constraint review_cases_priority_check
    check (priority in ('low', 'normal', 'high', 'urgent'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table review_cases add constraint review_cases_status_check
    check (status in ('open', 'acknowledged', 'awaiting_evidence', 'resolved'));
exception when duplicate_object then null; end $$;

-- The queries the admin desk actually runs
create index if not exists review_cases_unassigned_idx
  on review_cases(opened_at)
  where status <> 'resolved' and assigned_to is null;

create index if not exists review_cases_overdue_idx
  on review_cases(resolution_due_at)
  where status <> 'resolved';

create index if not exists review_cases_blocking_payment_idx
  on review_cases(booking_id)
  where status <> 'resolved' and blocks_payment;

create index if not exists review_cases_blocking_payout_idx
  on review_cases(booking_id)
  where status <> 'resolved' and blocks_payout;

create index if not exists review_cases_priority_idx
  on review_cases(priority, opened_at)
  where status <> 'resolved';

-- The booking-row lock in open_review_case serialises creation, while this
-- constraint remains the durable invariant.
create unique index if not exists review_cases_one_open_category
  on review_cases(booking_id, category)
  where status <> 'resolved';

alter table review_cases enable row level security;

drop policy if exists "admin manages review cases" on review_cases;
create policy "admin manages review cases" on review_cases
  for all using (is_admin()) with check (is_admin());

-- Participants must not select this table directly because RLS filters rows,
-- not sensitive columns such as internal resolution_notes. Add a safe-column
-- RPC/view when the participant case UI is built.
drop policy if exists "participants read own cases" on review_cases;

-- Opening a case sets its SLA from its priority, so "forgotten" is visible.
create or replace function open_review_case(
  p_booking_id     uuid,
  p_category       text,
  p_priority       text default 'normal',
  p_blocks_payment boolean default false,
  p_blocks_payout  boolean default false,
  p_notes          text default null,
  p_created_by     uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id          uuid;
  v_uid         uuid := auth.uid();
  v_role        text;
  v_creator     uuid;
  v_booking     bookings;
  v_provider_id uuid;
  v_payout      payouts;
  v_respond     interval;
  v_resolve     interval;
begin
  -- This lock serialises case creation with maybe_release_payout.
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
    v_creator := p_created_by;
  else
    select role into v_role from profiles where id = v_uid;
    v_creator := v_uid; -- caller cannot spoof created_by

    if v_role = 'provider' then
      select id into v_provider_id from providers where profile_id = v_uid;
      if v_provider_id is null
         or v_booking.provider_id is distinct from v_provider_id then
        raise exception 'provider is not assigned to this booking'
          using errcode = 'insufficient_privilege';
      end if;
    elsif v_role = 'customer' then
      if v_booking.customer_id is distinct from v_uid then
        raise exception 'customer does not own this booking'
          using errcode = 'insufficient_privilege';
      end if;
    elsif v_role <> 'admin' then
      raise exception 'account role cannot open a review case'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  select id into v_id
  from review_cases
  where booking_id = p_booking_id
    and category = p_category
    and status <> 'resolved'
  limit 1;

  if v_id is null then
    v_respond := case p_priority
                   when 'urgent' then interval '1 hour'
                   when 'high'   then interval '4 hours'
                   when 'normal' then interval '1 day'
                   else interval '3 days'
                 end;
    v_resolve := case p_priority
                   when 'urgent' then interval '1 day'
                   when 'high'   then interval '3 days'
                   when 'normal' then interval '7 days'
                   else interval '14 days'
                 end;

    insert into review_cases (
      booking_id, category, priority, blocks_payment, blocks_payout,
      response_due_at, resolution_due_at, resolution_notes, created_by
    ) values (
      p_booking_id, p_category, p_priority, p_blocks_payment, p_blocks_payout,
      now() + v_respond, now() + v_resolve, p_notes, v_creator
    )
    returning id into v_id;
  end if;

  -- A case opened after funding became ready must still stop a payout that has
  -- not started processing. The payout row lock serialises this with senders.
  if p_blocks_payment or p_blocks_payout then
    select * into v_payout
    from payouts
    where booking_id = p_booking_id
      and status in ('not_ready', 'pending')
    order by created_at
    limit 1
    for update;

    if found and v_payout.status <> 'held' then
      perform _apply_payout_transition(
        v_payout.id, 'held', null, 'system',
        'Review case ' || v_id || ' blocks release',
        jsonb_build_object('review_case_id', v_id, 'opened_by', v_creator)
      );
    end if;
  end if;

  return v_id;
end $$;

revoke all on function open_review_case(uuid, text, text, boolean, boolean, text, uuid)
  from public, anon;
grant execute on function open_review_case(uuid, text, text, boolean, boolean, text, uuid)
  to authenticated;
do $$ begin
  execute 'grant execute on function open_review_case(uuid, text, text, boolean, boolean, text, uuid) to service_role';
exception when others then null; end $$;


-- ----------------------------------------------------------------------------
-- 6. reconciliation_findings — observes, never mutates
-- ----------------------------------------------------------------------------
create table if not exists reconciliation_findings (
  id               uuid primary key default gen_random_uuid(),
  finding_type     text not null,
  severity         text not null default 'warning',

  booking_id       uuid references bookings(id) on delete set null,
  payment_id       uuid references payments(id) on delete set null,
  payout_id        uuid references payouts(id)  on delete set null,
  operation_id     uuid references money_operations(id) on delete set null,
  stripe_object_id text,

  expected         jsonb,
  actual           jsonb,

  detected_at      timestamptz not null default now(),
  status           text not null default 'open',
  assigned_to      uuid references profiles(id) on delete set null,
  acknowledged_at  timestamptz,
  resolved_at      timestamptz,
  resolution       text,
  resolved_by      uuid references profiles(id) on delete set null
);

do $$ begin
  alter table reconciliation_findings add constraint recon_type_check
    check (finding_type in (
      'completed_booking_uncaptured_payment',
      'stripe_captured_local_pending',
      'stripe_transfer_without_local_payout',
      'local_paid_without_stripe_transfer',
      'duplicate_transfer',
      'duplicate_capture',
      'refund_amount_mismatch',
      'payment_stuck_capturing',
      'payout_stuck_processing',
      'operation_ambiguous',
      'membership_visit_without_payout'
    ));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table reconciliation_findings add constraint recon_severity_check
    check (severity in ('info', 'warning', 'critical'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table reconciliation_findings add constraint recon_status_check
    check (status in ('open', 'acknowledged', 'resolved', 'false_positive'));
exception when duplicate_object then null; end $$;

-- Don't re-raise the same finding every night.
create unique index if not exists recon_open_unique
  on reconciliation_findings(
    finding_type,
    coalesce(booking_id,   '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(payment_id,   '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(payout_id,    '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(operation_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(stripe_object_id, '')
  )
  where status = 'open';

create index if not exists recon_open_idx
  on reconciliation_findings(severity, detected_at)
  where status = 'open';

alter table reconciliation_findings enable row level security;

drop policy if exists "admin reads findings" on reconciliation_findings;
create policy "admin reads findings" on reconciliation_findings
  for all using (is_admin()) with check (is_admin());

revoke insert on reconciliation_findings from anon;


-- ----------------------------------------------------------------------------
-- 7. Close the back doors
-- ----------------------------------------------------------------------------
-- ⚠ Everything above must be wired into the application FIRST. Inserts may
--   still set an initial status; only updates are closed off.
revoke update (status) on payments from authenticated, anon;
revoke update (status) on payouts  from authenticated, anon;

do $$ begin
  execute 'revoke update (status) on payments from service_role';
  execute 'revoke update (status) on payouts  from service_role';
exception when others then null; end $$;

-- Columns the app may still update directly.
grant update (
  stripe_payment_ref,
  split_breakdown,
  period_start,
  period_end
) on payments to service_role;

grant update (
  stripe_transfer_ref,
  amount,
  note
) on payouts to service_role;


-- ============================================================================
-- Next: the application refactor. Every writer must go through
-- transition_booking / transition_payment / transition_payout before this
-- migration is applied to production.
-- ============================================================================

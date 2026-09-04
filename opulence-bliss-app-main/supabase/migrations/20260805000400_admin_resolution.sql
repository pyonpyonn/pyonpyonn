-- ============================================================================
-- 0004 — Admin resolution: amounts, ownership, and audited close-out
-- ============================================================================
-- Run AFTER 0001, 0002 and 0003. Safe to re-run.
--
-- It adds the fields the reconciliation runner needs to check refund amounts,
-- plus append-only audit records and functions for deliberate desk actions.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. What was actually approved
-- ----------------------------------------------------------------------------
alter table review_cases
  add column if not exists resolution_amount   numeric(10,2);
alter table review_cases
  add column if not exists resolution_currency text not null default 'gbp';

-- Partial refunds can legitimately happen more than once against one case, so
-- refund operation keys need a sequence: refund:resolution:{caseId}:{n}
alter table review_cases
  add column if not exists refund_sequence     int not null default 0;

alter table review_cases
  add column if not exists resolved_by         uuid references profiles(id) on delete set null;

do $$ begin
  alter table review_cases add constraint review_cases_amount_sign
    check (
      resolution_amount is null
      or (resolution_amount <> 'NaN'::numeric and resolution_amount >= 0)
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table review_cases add constraint review_cases_currency_check
    check (resolution_currency = 'gbp');
exception when duplicate_object then null; end $$;

do $$ begin
  alter table review_cases add constraint review_cases_refund_sequence_check
    check (refund_sequence >= 0);
exception when duplicate_object then null; end $$;

-- A resolved case must say what the resolution was.
do $$ begin
  alter table review_cases add constraint review_cases_resolved_has_resolution
    check (status <> 'resolved' or coalesce(trim(resolution), '') <> '');
exception when duplicate_object then null; end $$;

-- If an additional partial refund fails, return to the already-partially-
-- refunded state rather than pretending the earlier refund disappeared.
insert into payment_transitions
  (from_status, to_status, actor_kind, reason_required, note)
values
  ('refund_pending', 'partially_refunded', 'admin', true,
   'A further refund failed; prior partial refunds remain.'),
  ('refund_pending', 'partially_refunded', 'system', true,
   'A further refund failed; prior partial refunds remain.')
on conflict (from_status, to_status, actor_kind) do update set
  reason_required = excluded.reason_required,
  note = excluded.note;


-- ----------------------------------------------------------------------------
-- 2. Append-only desk audit
-- ----------------------------------------------------------------------------
create table if not exists review_case_events (
  id             bigint generated always as identity primary key,
  review_case_id uuid not null references review_cases(id) on delete restrict,
  action         text not null check (
    action in ('assigned', 'resolved', 'refund_sequence_claimed')
  ),
  actor_id       uuid not null references profiles(id) on delete restrict,
  details        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

create table if not exists reconciliation_finding_events (
  id         bigint generated always as identity primary key,
  finding_id uuid not null references reconciliation_findings(id) on delete restrict,
  action     text not null check (action in ('acknowledged', 'resolved', 'false_positive')),
  actor_id   uuid not null references profiles(id) on delete restrict,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists review_case_events_case_idx
  on review_case_events(review_case_id, created_at desc);
create index if not exists reconciliation_finding_events_finding_idx
  on reconciliation_finding_events(finding_id, created_at desc);

alter table review_case_events enable row level security;
alter table reconciliation_finding_events enable row level security;

drop policy if exists "admins read review case events" on review_case_events;
create policy "admins read review case events" on review_case_events
  for select using (is_admin());
drop policy if exists "admins read finding events" on reconciliation_finding_events;
create policy "admins read finding events" on reconciliation_finding_events
  for select using (is_admin());

revoke insert, update, delete on review_case_events from authenticated, anon;
revoke insert, update, delete on reconciliation_finding_events from authenticated, anon;
do $$ begin
  execute 'revoke insert, update, delete, truncate on review_case_events from service_role';
  execute 'revoke insert, update, delete, truncate on reconciliation_finding_events from service_role';
exception when others then null; end $$;

drop trigger if exists review_case_events_no_update on review_case_events;
create trigger review_case_events_no_update
  before update or delete on review_case_events
  for each row execute function financial_events_immutable();

drop trigger if exists reconciliation_finding_events_no_update
  on reconciliation_finding_events;
create trigger reconciliation_finding_events_no_update
  before update or delete on reconciliation_finding_events
  for each row execute function financial_events_immutable();


-- ----------------------------------------------------------------------------
-- 3. Review case management — admin only, actor derived
-- ----------------------------------------------------------------------------
create or replace function assign_review_case(
  p_case_id uuid,
  p_to      uuid default null          -- null = assign to me
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_to  uuid;
begin
  if v_uid is null or not is_admin() then
    raise exception 'admin only' using errcode = 'insufficient_privilege';
  end if;

  v_to := coalesce(p_to, v_uid);

  if not exists (
    select 1 from profiles where id = v_to and role = 'admin'
  ) then
    raise exception 'case owner must be an admin'
      using errcode = 'check_violation';
  end if;

  update review_cases
     set assigned_to     = v_to,
         status          = case when status = 'open' then 'acknowledged' else status end,
         acknowledged_at = coalesce(acknowledged_at, now())
   where id = p_case_id
     and status <> 'resolved';

  if not found then
    raise exception 'case % not found or already resolved', p_case_id
      using errcode = 'no_data_found';
  end if;

  insert into review_case_events (review_case_id, action, actor_id, details)
  values (
    p_case_id, 'assigned', v_uid,
    jsonb_build_object('assigned_to', v_to)
  );

  return jsonb_build_object('ok', true, 'assigned_to', v_to);
end $fn$;

revoke all on function assign_review_case(uuid, uuid) from public, anon;
grant execute on function assign_review_case(uuid, uuid) to authenticated;


/**
 * Record what was decided. Does NOT move money — the caller performs any
 * refund or payout action separately, through the money state machines.
 */
create or replace function resolve_review_case(
  p_case_id  uuid,
  p_outcome  text,
  p_notes    text default null,
  p_amount   numeric default null,
  p_currency text default 'gbp'
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid  uuid := auth.uid();
  v_case review_cases;
  v_gross numeric;
begin
  if v_uid is null or not is_admin() then
    raise exception 'admin only' using errcode = 'insufficient_privilege';
  end if;

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
      raise exception 'resolution amount % exceeds charged amount %', p_amount, v_gross
        using errcode = 'check_violation';
    end if;
  end if;

  update review_cases
     set status              = 'resolved',
         resolution          = p_outcome,
         resolution_notes    = coalesce(p_notes, resolution_notes),
         resolution_amount   = p_amount,
         resolution_currency = lower(coalesce(p_currency, 'gbp')),
         resolved_at         = now(),
         resolved_by         = v_uid,
         assigned_to         = coalesce(assigned_to, v_uid)
   where id = p_case_id;

  insert into review_case_events (review_case_id, action, actor_id, details)
  values (
    p_case_id, 'resolved', v_uid,
    jsonb_build_object(
      'outcome', p_outcome,
      'amount', p_amount,
      'currency', lower(coalesce(p_currency, 'gbp'))
    )
  );

  return jsonb_build_object(
    'ok', true, 'changed', true,
    'booking_id', v_case.booking_id,
    'was_blocking_payout', v_case.blocks_payout,
    'was_blocking_payment', v_case.blocks_payment
  );
end $fn$;

revoke all on function resolve_review_case(uuid, text, text, numeric, text)
  from public, anon;
grant execute on function resolve_review_case(uuid, text, text, numeric, text)
  to authenticated;


/**
 * Claim the next refund sequence for a case, so repeat partial refunds get
 * distinct durable operation keys. Returns the new sequence number.
 */
create or replace function next_refund_sequence(p_case_id uuid)
returns int
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_n   int;
begin
  if v_uid is null or not is_admin() then
    raise exception 'admin only' using errcode = 'insufficient_privilege';
  end if;

  update review_cases
     set refund_sequence = refund_sequence + 1
   where id = p_case_id
     and status = 'resolved'
     and coalesce(resolution_amount, 0) > 0
  returning refund_sequence into v_n;

  if v_n is null then
    raise exception 'case % has no resolved refund approval', p_case_id
      using errcode = 'no_data_found';
  end if;

  insert into review_case_events (review_case_id, action, actor_id, details)
  values (
    p_case_id, 'refund_sequence_claimed', v_uid,
    jsonb_build_object('sequence', v_n)
  );

  return v_n;
end $fn$;

revoke all on function next_refund_sequence(uuid) from public, anon;
grant execute on function next_refund_sequence(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 4. Reconciliation findings — acknowledge and close out
-- ----------------------------------------------------------------------------
create or replace function acknowledge_finding(
  p_finding_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or not is_admin() then
    raise exception 'admin only' using errcode = 'insufficient_privilege';
  end if;

  update reconciliation_findings
     set status          = 'acknowledged',
         assigned_to     = coalesce(assigned_to, v_uid),
         acknowledged_at = coalesce(acknowledged_at, now())
   where id = p_finding_id
     and status = 'open';

  if not found then
    raise exception 'finding % not open', p_finding_id
      using errcode = 'no_data_found';
  end if;

  insert into reconciliation_finding_events
    (finding_id, action, actor_id)
  values (p_finding_id, 'acknowledged', v_uid);

  return jsonb_build_object('ok', true);
end $fn$;

revoke all on function acknowledge_finding(uuid) from public, anon;
grant execute on function acknowledge_finding(uuid) to authenticated;


create or replace function close_finding(
  p_finding_id uuid,
  p_outcome    text,
  p_false_positive boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or not is_admin() then
    raise exception 'admin only' using errcode = 'insufficient_privilege';
  end if;

  if coalesce(trim(p_outcome), '') = '' then
    raise exception 'say what was done about it' using errcode = 'check_violation';
  end if;

  update reconciliation_findings
     set status      = case when p_false_positive then 'false_positive' else 'resolved' end,
         resolution  = p_outcome,
         resolved_at = now(),
         resolved_by = v_uid,
         assigned_to = coalesce(assigned_to, v_uid)
   where id = p_finding_id
     and status in ('open', 'acknowledged');

  if not found then
    raise exception 'finding % not open', p_finding_id
      using errcode = 'no_data_found';
  end if;

  insert into reconciliation_finding_events
    (finding_id, action, actor_id, details)
  values (
    p_finding_id,
    case when p_false_positive then 'false_positive' else 'resolved' end,
    v_uid,
    jsonb_build_object('outcome', p_outcome)
  );

  return jsonb_build_object('ok', true);
end $fn$;

revoke all on function close_finding(uuid, text, boolean) from public, anon;
grant execute on function close_finding(uuid, text, boolean) to authenticated;


-- ----------------------------------------------------------------------------
-- 5. A read model for the desk
-- ----------------------------------------------------------------------------
create or replace view admin_review_queue
with (security_invoker = true) as
select
  rc.id,
  rc.booking_id,
  rc.category,
  rc.priority,
  rc.status,
  rc.blocks_payment,
  rc.blocks_payout,
  rc.assigned_to,
  rc.opened_at,
  rc.response_due_at,
  rc.resolution_due_at,
  rc.resolution_amount,
  rc.resolution_currency,
  rc.refund_sequence,
  coalesce(ro.refunded_amount, 0)                  as refunded_amount,
  greatest(
    coalesce(rc.resolution_amount, 0) - coalesce(ro.refunded_amount, 0),
    0
  )                                               as refund_remaining,
  (rc.resolution_due_at is not null
     and rc.resolution_due_at < now()
     and rc.status <> 'resolved')                as overdue,
  b.scheduled_at,
  b.status::text                                 as booking_status,
  b.customer_email,
  pk.name                                        as service,
  pay.id                                         as payment_id,
  pay.status                                     as payment_status,
  pay.gross_amount,
  po.id                                          as payout_id,
  po.status                                      as payout_status,
  po.amount                                      as payout_amount
from review_cases rc
left join bookings b  on b.id = rc.booking_id
left join packages pk on pk.id = b.package_id
left join lateral (
  select p.id, p.status, p.gross_amount
  from payments p
  where p.booking_id = rc.booking_id
    and coalesce(p.kind, 'booking') <> 'tip'
  order by p.created_at
  limit 1
) pay on true
left join lateral (
  select x.id, x.status, x.amount
  from payouts x
  where x.booking_id = rc.booking_id
  order by x.created_at
  limit 1
) po on true

left join lateral (
  select coalesce(sum(mo.amount), 0) as refunded_amount
  from money_operations mo
  where mo.operation_type = 'refund'
    and mo.status = 'succeeded'
    and mo.operation_key like
      ('refund:resolution:' || rc.id::text || ':%')
) ro on true;

revoke all on admin_review_queue from public, anon;
-- security_invoker makes base-table RLS apply to the caller.
grant select on admin_review_queue to authenticated;

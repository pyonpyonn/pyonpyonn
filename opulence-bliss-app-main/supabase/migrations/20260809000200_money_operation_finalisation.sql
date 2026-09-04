-- ============================================================================
-- Money operations: locked finalisation, immutable history, no direct writes
-- ============================================================================

create table if not exists money_operation_events (
  id               bigint generated always as identity primary key,
  operation_id     uuid not null references money_operations(id) on delete restrict,
  from_status      text,
  to_status        text not null,
  actor_id         uuid,
  actor_kind       text not null check (actor_kind in ('admin', 'system')),
  stripe_object_id text,
  reason           text,
  meta             jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists moe_operation_idx
  on money_operation_events(operation_id, created_at desc);

alter table money_operation_events enable row level security;

drop policy if exists "admin reads operation events" on money_operation_events;
create policy "admin reads operation events" on money_operation_events
  for select using (is_admin());

revoke insert, update, delete, truncate on money_operation_events
  from authenticated, anon;
do $$ begin
  execute 'revoke insert, update, delete, truncate on money_operation_events from service_role';
exception when others then null; end $$;

create or replace function money_operation_events_immutable()
returns trigger language plpgsql as $fn$
begin
  raise exception 'money_operation_events is append-only (attempted %)', tg_op;
end $fn$;

drop trigger if exists moe_no_change on money_operation_events;
create trigger moe_no_change
  before update or delete on money_operation_events
  for each row execute function money_operation_events_immutable();

-- Replace the claim function as well so creation, retries, and lease expiry
-- join the same immutable history as final outcomes.
create or replace function claim_money_operation(
  p_operation_key  text,
  p_operation_type text,
  p_booking_id     uuid,
  p_amount         numeric,
  p_requested_by   uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_op       money_operations;
  v_inserted integer := 0;
begin
  insert into money_operations
    (operation_key, operation_type, booking_id, amount, requested_by, status,
     idempotency_key)
  values
    (p_operation_key, p_operation_type, p_booking_id, p_amount, p_requested_by,
     'pending', p_operation_key)
  on conflict (operation_key) do nothing;
  get diagnostics v_inserted = row_count;

  select * into v_op
  from money_operations
  where operation_key = p_operation_key
  for update;

  if v_inserted > 0 then
    insert into money_operation_events
      (operation_id, from_status, to_status, actor_id, actor_kind, reason, meta)
    values
      (v_op.id, null, 'pending', p_requested_by,
       case when p_requested_by is null then 'system' else 'admin' end,
       'Operation created',
       jsonb_build_object('attempt', 0, 'operation_key', v_op.operation_key));
  end if;

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

    update money_operations
       set status = 'ambiguous',
           last_error = 'processing lease expired before outcome was recorded',
           completed_at = now()
     where id = v_op.id;

    insert into money_operation_events
      (operation_id, from_status, to_status, actor_id, actor_kind, reason, meta)
    values
      (v_op.id, 'processing', 'ambiguous', null, 'system',
       'Processing lease expired before outcome was recorded',
       jsonb_build_object(
         'attempt', v_op.attempt_count,
         'operation_key', v_op.operation_key
       ));

    return jsonb_build_object(
      'should_run', false, 'status', 'ambiguous', 'id', v_op.id,
      'message', 'outcome unknown — reconciliation required'
    );
  end if;

  update money_operations
     set status        = 'processing',
         attempt_count = attempt_count + 1,
         started_at    = now(),
         completed_at  = null,
         last_error    = null
   where id = v_op.id;

  insert into money_operation_events
    (operation_id, from_status, to_status, actor_id, actor_kind, reason, meta)
  values
    (v_op.id, v_op.status, 'processing', p_requested_by,
     case when p_requested_by is null then 'system' else 'admin' end,
     case when v_op.status = 'failed' then 'Operation retried' else 'Operation claimed' end,
     jsonb_build_object(
       'attempt', v_op.attempt_count + 1,
       'operation_key', v_op.operation_key
     ));

  return jsonb_build_object(
    'should_run', true, 'status', 'processing',
    'id', v_op.id, 'attempt', v_op.attempt_count + 1
  );
end $fn$;

-- The only primitive that may record an operation outcome. The row is locked
-- before validation, so concurrent callers converge on one observed state.
create or replace function _finalise_operation(
  p_operation_id uuid,
  p_outcome      text,
  p_stripe_id    text,
  p_error        text,
  p_actor_id     uuid,
  p_actor_kind   text,
  p_reason       text
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_op   money_operations;
  v_from text;
begin
  if p_outcome not in ('succeeded', 'failed', 'ambiguous') then
    raise exception 'unknown outcome %', p_outcome using errcode = 'check_violation';
  end if;

  if p_actor_kind not in ('admin', 'system') then
    raise exception 'unknown operation actor %', p_actor_kind
      using errcode = 'check_violation';
  end if;

  select * into v_op from money_operations where id = p_operation_id for update;
  if not found then
    raise exception 'operation % not found', p_operation_id
      using errcode = 'no_data_found';
  end if;

  v_from := v_op.status;

  -- Repeating the recorded outcome is idempotent.
  if v_from = p_outcome then
    return jsonb_build_object('changed', false, 'status', v_from);
  end if;

  if v_from = 'succeeded' then
    raise exception 'operation % already succeeded — that cannot be changed',
      p_operation_id using errcode = 'check_violation';
  end if;

  -- Normal outcomes may only follow a successful claim. This prevents callers
  -- from skipping the attempt counter and processing lease.
  if v_from <> 'processing' and v_from <> 'ambiguous' then
    raise exception 'operation % must be processing before finalisation (is %)',
      p_operation_id, v_from using errcode = 'check_violation';
  end if;

  -- Ambiguous is deliberately sticky: only an authenticated admin with written
  -- Stripe evidence can establish whether money moved.
  if v_from = 'ambiguous' and p_actor_kind <> 'admin' then
    raise exception 'operation % is ambiguous — an admin must establish the outcome first',
      p_operation_id using errcode = 'insufficient_privilege';
  end if;

  if v_from = 'ambiguous' and coalesce(trim(p_reason), '') = '' then
    raise exception 'say what evidence resolved this ambiguity'
      using errcode = 'check_violation';
  end if;

  if p_outcome = 'succeeded'
     and coalesce(trim(coalesce(p_stripe_id, v_op.stripe_object_id, '')), '') = '' then
    raise exception 'cannot mark % succeeded with no Stripe object id', p_operation_id
      using errcode = 'check_violation';
  end if;

  update money_operations
     set status           = p_outcome,
         stripe_object_id = coalesce(p_stripe_id, stripe_object_id),
         last_error       = case
                              when p_outcome = 'succeeded' then null
                              else left(coalesce(p_error, last_error), 500)
                            end,
         completed_at     = now()
   where id = p_operation_id;

  insert into money_operation_events
    (operation_id, from_status, to_status, actor_id, actor_kind,
     stripe_object_id, reason, meta)
  values
    (p_operation_id, v_from, p_outcome, p_actor_id, p_actor_kind,
     coalesce(p_stripe_id, v_op.stripe_object_id),
     nullif(trim(coalesce(p_reason, p_error, '')), ''),
     jsonb_build_object(
       'attempt', v_op.attempt_count,
       'operation_key', v_op.operation_key
     ));

  return jsonb_build_object('changed', true, 'from', v_from, 'status', p_outcome);
end $fn$;

revoke all on function
  _finalise_operation(uuid, text, text, text, uuid, text, text)
  from public, anon, authenticated, service_role;

create or replace function system_finalise_operation(
  p_operation_id uuid,
  p_outcome      text,
  p_stripe_id    text default null,
  p_error        text default null
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
begin
  return _finalise_operation(
    p_operation_id, p_outcome, p_stripe_id, p_error, null, 'system', null);
end $fn$;

revoke all on function system_finalise_operation(uuid, text, text, text)
  from public, anon, authenticated;
do $$ begin
  execute 'grant execute on function system_finalise_operation(uuid, text, text, text) to service_role';
exception when others then null; end $$;

create or replace function resolve_ambiguous_operation(
  p_operation_id uuid,
  p_outcome      text,
  p_stripe_id    text,
  p_evidence     text
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not is_admin() then
    raise exception 'admin only' using errcode = 'insufficient_privilege';
  end if;
  if p_outcome not in ('succeeded', 'failed') then
    raise exception 'resolve to succeeded or failed' using errcode = 'check_violation';
  end if;
  if coalesce(trim(p_evidence), '') = '' then
    raise exception 'record what you checked at Stripe'
      using errcode = 'check_violation';
  end if;

  return _finalise_operation(
    p_operation_id, p_outcome, p_stripe_id, null, v_uid, 'admin', p_evidence);
end $fn$;

revoke all on function resolve_ambiguous_operation(uuid, text, text, text)
  from public, anon;
grant execute on function resolve_ambiguous_operation(uuid, text, text, text)
  to authenticated;

-- claim_money_operation() remains the only insert/claim path and runs as its
-- owner. Application roles can no longer alter an outcome directly.
revoke update on money_operations from authenticated, anon;
do $$ begin
  execute 'revoke update on money_operations from service_role';
  execute 'revoke truncate on money_operations from authenticated, anon, service_role';
exception when others then null; end $$;

-- Booking/payment history is append-only in practice: immutable event rows use
-- ON DELETE RESTRICT, so destructive reset buttons could only work on records
-- with no history. Retire that false escape hatch completely.
revoke delete on bookings, payments, payouts
  from anon, authenticated, service_role;

do $assert$
declare
  v_role text;
  v_priv text;
  v_bad  text[] := '{}';
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if has_table_privilege(v_role, 'money_operations', 'UPDATE') then
      v_bad := v_bad || format('%s can UPDATE money_operations', v_role);
    end if;
    if has_column_privilege(
      v_role, 'money_operations'::regclass, 'status', 'UPDATE'
    ) then
      v_bad := v_bad || format('%s can write money_operations.status', v_role);
    end if;
    foreach v_priv in array array['bookings', 'payments', 'payouts'] loop
      if has_table_privilege(v_role, format('public.%I', v_priv), 'DELETE') then
        v_bad := v_bad || format('%s can DELETE %s', v_role, v_priv);
      end if;
    end loop;

    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege(v_role, 'money_operation_events', v_priv) then
        v_bad := v_bad || format('%s can %s money_operation_events', v_role, v_priv);
      end if;
    end loop;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception 'money operation finalisation migration did not take effect: %',
      array_to_string(v_bad, '; ');
  end if;
end $assert$;

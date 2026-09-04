-- ============================================================================
-- 0005 — A held payout cannot be released while a blocking case is open
-- ============================================================================

create or replace function _apply_payout_transition(
  p_payout_id  uuid,
  p_to_status  text,
  p_actor_id   uuid,
  p_actor_kind text,
  p_reason     text,
  p_meta       jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_row    payouts;
  v_policy payout_transitions;
  v_from   text;
begin
  select * into v_row from payouts where id = p_payout_id for update;
  if not found then
    raise exception 'payout % not found', p_payout_id
      using errcode = 'no_data_found';
  end if;

  v_from := v_row.status;
  if v_from = p_to_status then
    return jsonb_build_object('changed', false, 'status', v_from);
  end if;

  select * into v_policy from payout_transitions
   where from_status = v_from
     and to_status = p_to_status
     and actor_kind = p_actor_kind;

  if not found then
    raise exception 'payout transition %→% not permitted for %',
      v_from, p_to_status, p_actor_kind using errcode = 'check_violation';
  end if;

  if v_policy.reason_required and coalesce(trim(p_reason), '') = '' then
    raise exception 'a reason is required for payout %→%', v_from, p_to_status
      using errcode = 'check_violation';
  end if;

  -- The database owns this invariant. No caller, including a future route or
  -- service-role job, may lift a hold while the case that caused it is open.
  if v_from = 'held' and p_to_status = 'pending' and exists (
    select 1
      from review_cases rc
     where rc.booking_id = v_row.booking_id
       and rc.status <> 'resolved'
       and (rc.blocks_payment or rc.blocks_payout)
  ) then
    raise exception 'cannot lift a hold while a blocking review case is open'
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

  return jsonb_build_object(
    'changed', true,
    'from', v_from,
    'status', p_to_status
  );
end $fn$;

revoke all on function _apply_payout_transition(uuid, text, uuid, text, text, jsonb)
  from public, anon, authenticated;

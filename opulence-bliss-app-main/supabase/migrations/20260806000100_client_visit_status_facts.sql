-- ============================================================================
-- 0006 — Safe customer facts for the visit-status projector
-- ============================================================================
-- Participants cannot SELECT review_cases directly because RLS cannot hide
-- sensitive columns. This function validates booking ownership and returns
-- only the small, explicitly safe projection needed by the customer UI.

create or replace function get_client_visit_status_facts(p_booking_id uuid)
returns table (
  open_offer_count bigint,
  review_category text,
  review_status text,
  blocks_payment boolean,
  blocks_payout boolean,
  resolution_due_at timestamptz,
  refunded_amount numeric
)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  if not is_admin() and not exists (
    select 1
      from bookings b
     where b.id = p_booking_id
       and b.customer_id = v_uid
  ) then
    raise exception 'booking not found or access denied'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    (
      select count(*)
        from booking_offers bo
       where bo.booking_id = p_booking_id
         and bo.status = 'open'
    ) as open_offer_count,
    rc.category as review_category,
    rc.status as review_status,
    rc.blocks_payment,
    rc.blocks_payout,
    rc.resolution_due_at,
    coalesce(
      (
        select sum(mo.amount)
          from money_operations mo
         where mo.booking_id = p_booking_id
           and mo.operation_type = 'refund'
           and mo.status = 'succeeded'
      ),
      0
    ) as refunded_amount
  from (values (1)) as singleton(n)
  left join lateral (
    select
      r.category,
      r.status,
      r.blocks_payment,
      r.blocks_payout,
      r.resolution_due_at
    from review_cases r
    where r.booking_id = p_booking_id
    order by
      case when r.status <> 'resolved' then 0 else 1 end,
      r.opened_at desc
    limit 1
  ) rc on true;
end $fn$;

revoke all on function get_client_visit_status_facts(uuid) from public, anon;
grant execute on function get_client_visit_status_facts(uuid) to authenticated;

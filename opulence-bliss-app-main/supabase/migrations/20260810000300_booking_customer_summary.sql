-- ============================================================================
-- Assigned providers may see the customer's booking-facing identity/rating.
-- ============================================================================
-- profiles RLS intentionally permits only self/admin reads. This narrow RPC
-- exposes no address, phone, private notes, or unrelated customer record.

create or replace function public.booking_customer_summary(p_booking_id uuid)
returns table (
  full_name text,
  client_rating_avg numeric,
  client_rating_count integer
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_provider_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  select p.id
    into v_provider_id
    from public.providers p
   where p.profile_id = v_uid;

  return query
  select
    customer.full_name,
    customer.client_rating_avg,
    customer.client_rating_count
  from public.bookings booking
  join public.profiles customer on customer.id = booking.customer_id
  where booking.id = p_booking_id
    and (
      booking.provider_id = v_provider_id
      or public.is_admin()
    );

  if not found then
    raise exception 'you are not assigned to this booking'
      using errcode = 'insufficient_privilege';
  end if;
end $fn$;

revoke all on function public.booking_customer_summary(uuid)
  from public, anon;
grant execute on function public.booking_customer_summary(uuid)
  to authenticated;

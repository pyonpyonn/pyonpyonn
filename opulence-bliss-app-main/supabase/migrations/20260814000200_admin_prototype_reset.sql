-- One controlled reset for prototype activity. Accounts, providers, services,
-- service areas, availability, pricing and state-machine policy are preserved.

create table if not exists public.prototype_reset_events (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid not null references public.profiles(id) on delete restrict,
  removed     jsonb not null,
  created_at  timestamptz not null default now()
);

alter table public.prototype_reset_events enable row level security;
revoke all on public.prototype_reset_events
  from public, anon, authenticated, service_role;

create or replace function public.admin_reset_prototype_data(
  p_actor_id uuid,
  p_confirmation text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_role text;
  v_removed jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = 'insufficient_privilege';
  end if;

  if p_confirmation is distinct from 'RESET PROTOTYPE DATA' then
    raise exception 'reset confirmation did not match'
      using errcode = 'check_violation';
  end if;

  select role into v_role
    from public.profiles
   where id = p_actor_id;

  if v_role is distinct from 'admin' then
    raise exception 'admin actor required' using errcode = 'insufficient_privilege';
  end if;

  select jsonb_build_object(
    'bookings', (select count(*) from public.bookings),
    'payments', (select count(*) from public.payments),
    'payouts', (select count(*) from public.payouts),
    'reviews', (select count(*) from public.reviews),
    'subscriptions', (select count(*) from public.subscriptions),
    'messages', (select count(*) from public.booking_messages),
    'notifications', (select count(*) from public.notifications),
    'review_cases', (select count(*) from public.review_cases)
  ) into v_removed;

  -- Explicitly list every activity table. CASCADE handles any future dependent
  -- table, while the preserved identity/configuration tables remain untouched.
  truncate table
    public.check_in_challenge_events,
    public.check_in_challenges,
    public.booking_messages,
    public.booking_offer_queue,
    public.booking_offer_runs,
    public.booking_offers,
    public.reconciliation_finding_events,
    public.reconciliation_findings,
    public.review_case_events,
    public.review_cases,
    public.money_operation_events,
    public.money_operations,
    public.payout_events,
    public.payouts,
    public.payment_events,
    public.payments,
    public.booking_events,
    public.check_ins,
    public.reviews,
    public.bookings,
    public.subscriptions,
    public.notifications
  restart identity cascade;

  update public.providers
     set rating_avg = null,
         rating_count = 0
   where id <> '00000000-0000-0000-0000-000000000000'::uuid;

  update public.profiles
     set client_rating_avg = null,
         client_rating_count = 0
   where id <> '00000000-0000-0000-0000-000000000000'::uuid;

  insert into public.prototype_reset_events (actor_id, removed)
  values (p_actor_id, v_removed);

  return jsonb_build_object('ok', true, 'removed', v_removed);
end
$fn$;

revoke all on function public.admin_reset_prototype_data(uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_reset_prototype_data(uuid, text)
  to service_role;

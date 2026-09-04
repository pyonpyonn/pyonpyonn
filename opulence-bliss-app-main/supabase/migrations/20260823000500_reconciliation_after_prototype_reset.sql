-- Reconciliation should not compare Stripe's retained test history against a
-- database that an administrator deliberately reset afterwards. The reset log
-- remains private; this narrow function exposes only its latest timestamp to
-- the service-role reconciliation runner.

create or replace function public.latest_prototype_reset_at()
returns timestamptz
language sql
stable
security definer
set search_path = public
as $fn$
  select max(created_at) from public.prototype_reset_events;
$fn$;

revoke all on function public.latest_prototype_reset_at()
  from public, anon, authenticated;
grant execute on function public.latest_prototype_reset_at()
  to service_role;


-- ============================================================================
-- Schedule the platform safety jobs in Supabase Cron
-- ============================================================================
-- Vercel Hobby only permits daily cron jobs. These safety sweeps need ten- and
-- fifteen-minute precision, so Postgres schedules authenticated HTTP requests
-- to the production route instead. The shared secret lives in Supabase Vault
-- under `opulence_cron_secret`; it is never stored in this migration.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function public.invoke_opulence_cron(p_path text)
returns bigint
language plpgsql
security definer
set search_path = public, vault, net
as $fn$
declare
  v_secret text;
  v_request_id bigint;
begin
  if p_path not in (
    '/api/cron/expire-offers',
    '/api/cron/detect-no-shows',
    '/api/cron/reconcile'
  ) then
    raise exception 'cron path is not allow-listed: %', p_path;
  end if;

  select decrypted_secret
    into v_secret
    from vault.decrypted_secrets
   where name = 'opulence_cron_secret'
   order by created_at desc
   limit 1;

  if coalesce(v_secret, '') = '' then
    raise exception 'Vault secret opulence_cron_secret is missing';
  end if;

  select net.http_get(
    url := 'https://opulence-bliss-app.vercel.app' || p_path,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_secret,
      'User-Agent', 'opulence-supabase-cron/1.0'
    ),
    timeout_milliseconds := 120000
  ) into v_request_id;

  return v_request_id;
end $fn$;

revoke all on function public.invoke_opulence_cron(text)
  from public, anon, authenticated, service_role;

select cron.schedule(
  'opulence-expire-offers',
  '*/15 * * * *',
  $$select public.invoke_opulence_cron('/api/cron/expire-offers');$$
);

select cron.schedule(
  'opulence-detect-no-shows',
  '*/10 * * * *',
  $$select public.invoke_opulence_cron('/api/cron/detect-no-shows');$$
);

select cron.schedule(
  'opulence-reconcile-nightly',
  '0 3 * * *',
  $$select public.invoke_opulence_cron('/api/cron/reconcile');$$
);

do $assert$
declare
  v_count integer;
begin
  select count(*) into v_count
  from cron.job
  where jobname in (
    'opulence-expire-offers',
    'opulence-detect-no-shows',
    'opulence-reconcile-nightly'
  ) and active;

  if v_count <> 3 then
    raise exception 'expected three active safety jobs, found %', v_count;
  end if;
end $assert$;

-- ============================================================================
-- Provider arrival-delay updates
-- ============================================================================
-- A delay is booking state, not just an informal chat message. The latest
-- estimate is projected onto bookings for fast portal reads; every meaningful
-- change also creates an immutable booking message and a customer notification.

alter table public.bookings
  add column if not exists provider_delay_minutes integer,
  add column if not exists provider_delay_reported_at timestamptz;

do $constraint$
begin
  alter table public.bookings
    add constraint bookings_provider_delay_minutes_check
    check (
      provider_delay_minutes is null
      or provider_delay_minutes between 5 and 120
    );
exception when duplicate_object then null;
end
$constraint$;

comment on column public.bookings.provider_delay_minutes is
  'Latest provider-reported arrival delay. Null means no active delay.';
comment on column public.bookings.provider_delay_reported_at is
  'When the assigned provider last changed the arrival estimate.';

-- A delay belongs to one provider, one scheduled time and the pre-arrival
-- stage. Reassignment, rescheduling or check-in must not carry an old estimate
-- into a different job context. The immutable chat message remains as history.
create or replace function public.clear_stale_provider_delay()
returns trigger
language plpgsql
set search_path = public
as $trigger$
begin
  if old.provider_delay_minutes is not null
     and (
       new.provider_id is distinct from old.provider_id
       or new.scheduled_at is distinct from old.scheduled_at
       or new.status::text <> 'scheduled'
     ) then
    new.provider_delay_minutes := null;
    new.provider_delay_reported_at := null;
  end if;
  return new;
end
$trigger$;

drop trigger if exists bookings_clear_stale_provider_delay on public.bookings;
create trigger bookings_clear_stale_provider_delay
  before update on public.bookings
  for each row execute function public.clear_stale_provider_delay();

create or replace function public.report_provider_delay(
  p_booking_id uuid,
  p_delay_minutes integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_uid uuid := auth.uid();
  v_provider_id uuid;
  v_booking public.bookings;
  v_provider_name text;
  v_message text;
  v_title text;
  v_eta timestamptz;
  v_message_id bigint;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  if p_delay_minutes <> 0
     and p_delay_minutes not between 5 and 120 then
    raise exception 'choose a delay between 5 and 120 minutes'
      using errcode = 'check_violation';
  end if;

  select p.id, coalesce(p.display_name, 'Your provider')
    into v_provider_id, v_provider_name
    from public.providers p
   where p.profile_id = v_uid;

  if v_provider_id is null then
    raise exception 'providers only' using errcode = 'insufficient_privilege';
  end if;

  select * into v_booking
    from public.bookings b
   where b.id = p_booking_id
   for update;

  if not found then
    raise exception 'booking not found' using errcode = 'no_data_found';
  end if;

  if v_booking.provider_id is distinct from v_provider_id then
    raise exception 'you are not assigned to this booking'
      using errcode = 'insufficient_privilege';
  end if;

  if v_booking.status::text <> 'scheduled' then
    raise exception 'arrival updates are only available before check-in'
      using errcode = 'check_violation';
  end if;

  -- Repeating the same report is a true no-op: no duplicate chat message and
  -- no duplicate notification for the customer.
  if (p_delay_minutes = 0 and v_booking.provider_delay_minutes is null)
     or v_booking.provider_delay_minutes = p_delay_minutes then
    return jsonb_build_object(
      'ok', true,
      'changed', false,
      'delay_minutes', v_booking.provider_delay_minutes,
      'estimated_arrival',
        case when v_booking.provider_delay_minutes is null then v_booking.scheduled_at
             else v_booking.scheduled_at
                  + make_interval(mins => v_booking.provider_delay_minutes)
        end
    );
  end if;

  if p_delay_minutes = 0 then
    update public.bookings
       set provider_delay_minutes = null,
           provider_delay_reported_at = now()
     where id = p_booking_id;

    v_title := format('%s is back on schedule', v_provider_name);
    v_message := 'I am back on schedule and expect to arrive at the original booking time.';
    v_eta := v_booking.scheduled_at;
  else
    v_eta := v_booking.scheduled_at + make_interval(mins => p_delay_minutes);

    update public.bookings
       set provider_delay_minutes = p_delay_minutes,
           provider_delay_reported_at = now()
     where id = p_booking_id;

    v_title := format('%s is running late', v_provider_name);
    v_message := format(
      'I am running about %s minutes late. My updated arrival time is around %s.',
      p_delay_minutes,
      lower(to_char(v_eta at time zone 'Europe/London', 'HH12:MI AM'))
    );
  end if;

  insert into public.booking_messages
    (booking_id, sender_id, sender_role, body)
  values (p_booking_id, v_uid, 'provider', v_message)
  returning id into v_message_id;

  if v_booking.customer_id is not null then
    insert into public.notifications (user_id, title, body, href)
    values (
      v_booking.customer_id,
      v_title,
      v_message,
      format('/account/visit/%s', p_booking_id)
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'changed', true,
    'delay_minutes', nullif(p_delay_minutes, 0),
    'estimated_arrival', v_eta,
    'message_id', v_message_id
  );
end
$function$;

revoke all on function public.report_provider_delay(uuid, integer)
  from public, anon;
grant execute on function public.report_provider_delay(uuid, integer)
  to authenticated;

-- These two fields are controlled only by report_provider_delay(). Existing
-- table-level UPDATE grants were already removed by migration 0008.
revoke update (provider_delay_minutes, provider_delay_reported_at)
  on public.bookings from anon, authenticated, service_role;

do $verify$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if has_column_privilege(
      v_role,
      'public.bookings',
      'provider_delay_minutes',
      'UPDATE'
    ) or has_column_privilege(
      v_role,
      'public.bookings',
      'provider_delay_reported_at',
      'UPDATE'
    ) then
      raise exception '%.bookings provider delay remains directly writable', v_role;
    end if;
  end loop;
end
$verify$;

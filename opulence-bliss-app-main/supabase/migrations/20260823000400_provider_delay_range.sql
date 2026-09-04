-- Keep provider arrival estimates useful and realistic for the pre-arrival UI.
-- Zero remains the explicit "back on time" command; active delays are 10–50.

alter table public.bookings
  drop constraint if exists bookings_provider_delay_minutes_check;

update public.bookings
   set provider_delay_minutes = greatest(10, least(50, provider_delay_minutes))
 where provider_delay_minutes is not null
   and provider_delay_minutes not between 10 and 50;

alter table public.bookings
  add constraint bookings_provider_delay_minutes_check
  check (
    provider_delay_minutes is null
    or provider_delay_minutes between 10 and 50
  );

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
     and p_delay_minutes not between 10 and 50 then
    raise exception 'choose a delay between 10 and 50 minutes'
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

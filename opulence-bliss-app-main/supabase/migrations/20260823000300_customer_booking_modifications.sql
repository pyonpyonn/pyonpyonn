-- Prototype booking changes: remove the advance reschedule lockout and expose
-- one locked, audited path for customers to change time, compatible service,
-- and visit instructions.

alter table public.booking_rules
  alter column reschedule_lockout_hours set default 0;

update public.booking_rules
   set reschedule_lockout_hours = 0,
       updated_at = now()
 where id = 1;

create or replace function public.modify_customer_booking(
  p_booking_id       uuid,
  p_new_slot         timestamptz default null,
  p_package_id       uuid default null,
  p_household_notes  text default null,
  p_update_notes     boolean default false,
  p_reason           text default null,
  p_meta             jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_uid              uuid := auth.uid();
  v_role             text;
  v_kind             text;
  v_booking          public.bookings;
  v_old_package      public.packages;
  v_new_package      public.packages;
  v_target_package   uuid;
  v_target_notes     text;
  v_time_changed     boolean := false;
  v_package_changed  boolean := false;
  v_notes_changed    boolean := false;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  select role into v_role from public.profiles where id = v_uid;
  v_kind := case v_role
    when 'customer' then 'customer'
    when 'admin' then 'admin'
    else null
  end;

  if v_kind is null then
    raise exception 'only the customer or an administrator can modify this booking'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_booking
    from public.bookings
   where id = p_booking_id
   for update;

  if not found then
    raise exception 'booking % not found', p_booking_id using errcode = 'no_data_found';
  end if;

  if v_kind = 'customer' and v_booking.customer_id is distinct from v_uid then
    raise exception 'not your booking' using errcode = 'insufficient_privilege';
  end if;

  if v_booking.status::text not in ('offered', 'declined', 'scheduled') then
    raise exception 'this visit has started or closed and can no longer be modified'
      using errcode = 'check_violation';
  end if;

  v_target_package := coalesce(p_package_id, v_booking.package_id);
  v_target_notes := case
    when p_update_notes then nullif(trim(coalesce(p_household_notes, '')), '')
    else v_booking.household_notes
  end;
  v_time_changed := p_new_slot is not null
                    and p_new_slot is distinct from v_booking.scheduled_at;
  v_package_changed := v_target_package is distinct from v_booking.package_id;
  v_notes_changed := v_target_notes is distinct from v_booking.household_notes;

  if not v_time_changed and not v_package_changed and not v_notes_changed then
    return jsonb_build_object(
      'changed', false,
      'scheduled_at', v_booking.scheduled_at,
      'package_id', v_booking.package_id
    );
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'tell us why the booking is changing'
      using errcode = 'check_violation';
  end if;

  if v_package_changed then
    select * into v_old_package from public.packages where id = v_booking.package_id;
    select * into v_new_package from public.packages where id = v_target_package;

    if not found or not coalesce(v_new_package.active, false)
       or v_new_package.billing_type is distinct from 'per_visit' then
      raise exception 'that service is not available for individual bookings'
        using errcode = 'check_violation';
    end if;

    -- Never alter the value of an existing Stripe authorisation silently.
    if v_new_package.price is distinct from v_old_package.price then
      raise exception
        'that service has a different price — cancel and rebook so payment can be confirmed securely'
        using errcode = 'check_violation';
    end if;

    -- Changing discipline would invalidate the provider matching/assignment.
    -- Same-discipline package changes remain safe (for example duration/tier).
    if v_new_package.service_type is distinct from v_old_package.service_type then
      raise exception
        'changing to a different service type needs a new booking so the right professional can be matched'
        using errcode = 'check_violation';
    end if;
  end if;

  -- _apply_reschedule takes the same row lock, validates the appointment window
  -- and minimum notice, and appends its own immutable time-change event.
  if v_time_changed then
    perform public._apply_reschedule(
      p_booking_id,
      p_new_slot,
      v_uid,
      v_kind,
      p_reason,
      coalesce(p_meta, '{}'::jsonb) || jsonb_build_object('source', 'modify_booking')
    );
  end if;

  if v_package_changed or v_notes_changed then
    update public.bookings
       set package_id = v_target_package,
           household_notes = v_target_notes
     where id = p_booking_id;

    insert into public.booking_events
      (booking_id, from_status, to_status, actor_id, actor_kind, reason, meta)
    values (
      p_booking_id,
      v_booking.status::text,
      v_booking.status::text,
      v_uid,
      v_kind,
      nullif(trim(p_reason), ''),
      coalesce(p_meta, '{}'::jsonb) || jsonb_build_object(
        'event', 'booking_details_modified',
        'old_package_id', v_booking.package_id,
        'new_package_id', v_target_package,
        'service_changed', v_package_changed,
        'visit_notes_changed', v_notes_changed
      )
    );
  end if;

  return jsonb_build_object(
    'changed', true,
    'scheduled_at', coalesce(p_new_slot, v_booking.scheduled_at),
    'package_id', v_target_package,
    'time_changed', v_time_changed,
    'service_changed', v_package_changed,
    'visit_notes_changed', v_notes_changed
  );
end
$function$;

revoke all on function public.modify_customer_booking(
  uuid, timestamptz, uuid, text, boolean, text, jsonb
) from public, anon, service_role;
grant execute on function public.modify_customer_booking(
  uuid, timestamptz, uuid, text, boolean, text, jsonb
) to authenticated;

-- Package and instructions now have the same no-back-door guarantee as time.
revoke update (package_id, household_notes) on public.bookings
  from anon, authenticated, service_role;

do $verify$
declare
  v_role text;
  v_column text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    foreach v_column in array array['scheduled_at', 'package_id', 'household_notes'] loop
      if has_column_privilege(v_role, 'public.bookings', v_column, 'UPDATE') then
        raise exception '% can still update bookings.% directly', v_role, v_column;
      end if;
    end loop;
  end loop;
end
$verify$;

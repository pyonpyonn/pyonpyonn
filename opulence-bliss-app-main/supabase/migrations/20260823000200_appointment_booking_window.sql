-- Appointments may be purchased at any time, but the work itself must take
-- place inside the operating window. The visit must finish by closing time.

alter table booking_rules
  add column if not exists appointment_start_hour smallint not null default 7,
  add column if not exists appointment_end_hour smallint not null default 19;

do $constraint$ begin
  alter table booking_rules
    add constraint booking_rules_appointment_window_sane check (
      appointment_start_hour between 0 and 23
      and appointment_end_hour between 1 and 24
      and appointment_start_hour < appointment_end_hour
    );
exception when duplicate_object then null; end $constraint$;

create or replace function enforce_booking_appointment_window()
returns trigger
language plpgsql security definer set search_path = public as $function$
declare
  v_rules booking_rules;
  v_duration integer;
  v_local_start timestamp;
  v_local_end timestamp;
begin
  select * into v_rules from booking_rules where id = 1;
  select coalesce(duration_minutes, 120)
    into v_duration
    from packages
   where id = new.package_id;

  v_duration := coalesce(v_duration, 120);
  v_local_start := new.scheduled_at at time zone 'Europe/London';
  v_local_end := (new.scheduled_at + make_interval(mins => v_duration))
    at time zone 'Europe/London';

  if v_local_start::time < make_time(v_rules.appointment_start_hour, 0, 0)
     or v_local_end::date <> v_local_start::date
     or v_local_end::time > make_time(v_rules.appointment_end_hour, 0, 0)
  then
    raise exception
      'appointments must start at or after % and finish by % (Europe/London)',
      to_char(make_time(v_rules.appointment_start_hour, 0, 0), 'HH12:MI am'),
      to_char(make_time(v_rules.appointment_end_hour, 0, 0), 'HH12:MI am')
      using errcode = 'check_violation';
  end if;

  return new;
end $function$;

drop trigger if exists bookings_enforce_appointment_window on bookings;
create trigger bookings_enforce_appointment_window
before insert or update of scheduled_at, package_id on bookings
for each row execute function enforce_booking_appointment_window();

revoke all on function enforce_booking_appointment_window() from public;

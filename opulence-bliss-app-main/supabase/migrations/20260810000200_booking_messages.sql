-- ============================================================================
-- 0012 — Messages between a customer and their provider
-- ============================================================================
-- One thread per booking. Only the two people on that booking can see it, plus
-- an admin if it ends up in a dispute. Messages are immutable except for the
-- recipient's read receipt.

create table if not exists public.booking_messages (
  id          bigint generated always as identity primary key,
  booking_id  uuid not null references public.bookings(id) on delete restrict,
  sender_id   uuid not null references public.profiles(id) on delete restrict,
  sender_role text not null,
  body        text not null,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

do $$ begin
  alter table public.booking_messages add constraint bm_role_check
    check (sender_role in ('customer', 'provider', 'admin'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.booking_messages add constraint bm_body_check
    check (length(trim(body)) between 1 and 2000);
exception when duplicate_object then null; end $$;

create index if not exists bm_booking_idx
  on public.booking_messages(booking_id, created_at);
create index if not exists bm_unread_idx
  on public.booking_messages(booking_id, sender_id)
  where read_at is null;

alter table public.booking_messages enable row level security;

drop policy if exists "participants read messages" on public.booking_messages;
create policy "participants read messages" on public.booking_messages
  for select using (
    is_admin()
    or exists (
      select 1 from public.bookings b
      where b.id = booking_messages.booking_id
        and (b.customer_id = auth.uid()
             or b.provider_id = current_provider_id())
    )
  );

-- Everything goes through the functions below.
revoke insert, update, delete, truncate on public.booking_messages
  from authenticated, anon;
do $$ begin
  execute 'revoke insert, update, delete, truncate on public.booking_messages from service_role';
exception when others then null; end $$;

create or replace function public.booking_messages_immutable()
returns trigger language plpgsql set search_path = public as $fn$
begin
  -- read_at is the one field that may change, and only from null to a value.
  if tg_op = 'UPDATE'
     and old.id = new.id
     and old.body = new.body
     and old.sender_id = new.sender_id
     and old.sender_role = new.sender_role
     and old.booking_id = new.booking_id
     and old.created_at = new.created_at
     and old.read_at is null
     and new.read_at is not null then
    return new;
  end if;

  raise exception 'messages cannot be edited or deleted';
end $fn$;

drop trigger if exists bm_immutable on public.booking_messages;
create trigger bm_immutable
  before update or delete on public.booking_messages
  for each row execute function public.booking_messages_immutable();

-- ----------------------------------------------------------------------------
-- Sending
-- ----------------------------------------------------------------------------
create or replace function public.send_booking_message(
  p_booking_id uuid,
  p_body       text
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid      uuid := auth.uid();
  v_role     text;
  v_kind     text;
  v_booking  bookings;
  v_provider uuid;
  v_other    uuid;
  v_name     text;
  v_service  text;
  v_id       bigint;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_body), '') = '' then
    raise exception 'the message is empty' using errcode = 'check_violation';
  end if;
  if length(trim(p_body)) > 2000 then
    raise exception 'that message is too long' using errcode = 'check_violation';
  end if;

  select role into v_role from public.profiles where id = v_uid;
  select * into v_booking from public.bookings where id = p_booking_id;

  if not found then
    raise exception 'booking not found' using errcode = 'no_data_found';
  end if;

  select id into v_provider from public.providers where profile_id = v_uid;

  if v_booking.customer_id = v_uid then
    v_kind := 'customer';
  elsif v_provider is not null and v_booking.provider_id = v_provider then
    v_kind := 'provider';
  elsif v_role = 'admin' then
    v_kind := 'admin';
  else
    raise exception 'you are not on this booking'
      using errcode = 'insufficient_privilege';
  end if;

  -- The thread opens after acceptance and closes seven days after the visit.
  if v_kind <> 'admin' then
    if v_booking.provider_id is null then
      raise exception
        'you can message once a provider has accepted the booking'
        using errcode = 'check_violation';
    end if;

    if v_booking.status::text = 'cancelled'
       or v_booking.scheduled_at < now() - interval '7 days' then
      raise exception
        'this booking is closed — contact support instead'
        using errcode = 'check_violation';
    end if;
  end if;

  insert into public.booking_messages
    (booking_id, sender_id, sender_role, body)
  values (p_booking_id, v_uid, v_kind, trim(p_body))
  returning id into v_id;

  select pk.name into v_service
  from public.packages pk where pk.id = v_booking.package_id;

  if v_kind = 'customer' then
    select pr.profile_id, coalesce(pr.display_name, 'Your provider')
      into v_other, v_name
    from public.providers pr where pr.id = v_booking.provider_id;
  else
    v_other := v_booking.customer_id;
    select coalesce(pr.display_name, 'Your provider') into v_name
    from public.providers pr where pr.id = v_booking.provider_id;
  end if;

  if v_other is not null then
    insert into public.notifications (user_id, title, body, href)
    values (
      v_other,
      case v_kind
        when 'customer' then 'Message from your customer'
        when 'admin'    then 'Message from Opulence Bliss'
        else format('Message from %s', v_name)
      end,
      left(trim(p_body), 140),
      case
        when v_kind = 'customer' then format('/worker/job/%s', p_booking_id)
        else format('/account/visit/%s', p_booking_id)
      end
    );
  end if;

  return jsonb_build_object('ok', true, 'id', v_id, 'sender_role', v_kind);
end $fn$;

revoke all on function public.send_booking_message(uuid, text)
  from public, anon;
grant execute on function public.send_booking_message(uuid, text)
  to authenticated;

-- ----------------------------------------------------------------------------
-- Marking as read
-- ----------------------------------------------------------------------------
create or replace function public.mark_messages_read(p_booking_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_n   int;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  update public.booking_messages m
     set read_at = now()
   where m.booking_id = p_booking_id
     and m.sender_id <> v_uid
     and m.read_at is null
     and exists (
       select 1 from public.bookings b
       where b.id = m.booking_id
         and (b.customer_id = v_uid or b.provider_id = current_provider_id())
     );

  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'marked', v_n);
end $fn$;

revoke all on function public.mark_messages_read(uuid) from public, anon;
grant execute on function public.mark_messages_read(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Unread count, for portal badges
-- ----------------------------------------------------------------------------
create or replace function public.my_unread_messages()
returns int
language sql stable security definer set search_path = public as $fn$
  select count(*)::int
  from public.booking_messages m
  join public.bookings b on b.id = m.booking_id
  where m.read_at is null
    and m.sender_id <> auth.uid()
    and (b.customer_id = auth.uid() or b.provider_id = current_provider_id());
$fn$;

revoke all on function public.my_unread_messages() from public, anon;
grant execute on function public.my_unread_messages() to authenticated;

-- ----------------------------------------------------------------------------
-- Assert that direct writes remain closed
-- ----------------------------------------------------------------------------
do $assert$
declare
  v_role text;
  v_priv text;
  v_bad  text[] := '{}';
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege(v_role, 'public.booking_messages', v_priv) then
        v_bad := v_bad || format('%s can %s booking_messages', v_role, v_priv);
      end if;
    end loop;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception 'migration 0012 did not take effect: %',
      array_to_string(v_bad, '; ');
  end if;

  raise notice '0012 verified — messages are function-only and immutable';
end $assert$;

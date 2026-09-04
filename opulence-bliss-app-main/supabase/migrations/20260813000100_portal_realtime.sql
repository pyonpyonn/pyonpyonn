-- Portal live updates.
--
-- Notifications are the cross-account refresh signal: every booking action
-- that affects the other participant inserts one for that user. Messages use
-- their own booking-scoped subscription. RLS still decides which rows each
-- connected user may receive.

do $realtime$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;

  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'booking_messages'
  ) then
    alter publication supabase_realtime add table public.booking_messages;
  end if;
end
$realtime$;

do $verify$
begin
  if exists (
    select required.table_name
      from (values ('notifications'), ('booking_messages')) as required(table_name)
     where not exists (
       select 1
         from pg_publication_tables published
        where published.pubname = 'supabase_realtime'
          and published.schemaname = 'public'
          and published.tablename = required.table_name
     )
  ) then
    raise exception 'portal realtime tables were not added to supabase_realtime';
  end if;
end
$verify$;

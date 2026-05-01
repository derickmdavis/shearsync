update public.activity_events
set activity_type = 'booking_created'
where activity_type = 'appointment_created';

do $$
declare
  existing_constraint_name text;
begin
  select con.conname
  into existing_constraint_name
  from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'activity_events'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%activity_type%';

  if existing_constraint_name is not null then
    execute format(
      'alter table public.activity_events drop constraint %I',
      existing_constraint_name
    );
  end if;
end $$;

alter table public.activity_events
  add constraint activity_events_activity_type_check
  check (
    activity_type in (
      'booking_created',
      'appointment_cancelled',
      'appointment_rescheduled',
      'reminder_sent'
    )
  );

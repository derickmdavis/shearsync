alter table public.reminders
  add column if not exists appointment_id uuid references public.appointments(id) on delete set null,
  add column if not exists channel text,
  add column if not exists reminder_type text,
  add column if not exists sent_at timestamptz;

alter table public.reminders
  drop constraint if exists reminders_status_check;

alter table public.reminders
  drop constraint if exists reminders_channel_check;

alter table public.reminders
  drop constraint if exists reminders_reminder_type_check;

alter table public.reminders
  add constraint reminders_status_check
    check (status in ('open', 'done', 'dismissed', 'sent')),
  add constraint reminders_channel_check
    check (channel is null or channel in ('sms', 'email')),
  add constraint reminders_reminder_type_check
    check (reminder_type is null or reminder_type in ('appointment_reminder', 'follow_up', 'general'));

create index if not exists reminders_user_id_sent_at_idx
  on public.reminders(user_id, sent_at);

create table if not exists public.activity_events (
  id uuid primary key default gen_random_uuid(),
  stylist_id uuid not null references public.users(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,
  activity_type text not null,
  title text not null,
  description text,
  occurred_at timestamptz not null default now(),
  metadata jsonb,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  constraint activity_events_activity_type_check
    check (activity_type in ('booking_created', 'appointment_cancelled', 'appointment_rescheduled', 'reminder_sent'))
);

create index if not exists activity_events_stylist_occurred_at_idx
  on public.activity_events(stylist_id, occurred_at desc, id desc);

create index if not exists activity_events_appointment_id_idx
  on public.activity_events(appointment_id);

create index if not exists activity_events_client_id_idx
  on public.activity_events(client_id);

create index if not exists activity_events_activity_type_idx
  on public.activity_events(activity_type);

create unique index if not exists activity_events_stylist_dedupe_key_idx
  on public.activity_events(stylist_id, dedupe_key);

alter table public.activity_events enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'activity_events'
      and policyname = 'activity_events_select_own'
  ) then
    create policy activity_events_select_own
      on public.activity_events
      for select
      using (auth.uid() = stylist_id);
  end if;
end
$$;

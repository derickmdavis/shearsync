create table if not exists public.appointment_email_events (
  id uuid primary key default gen_random_uuid(),
  stylist_id uuid not null references public.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  email_type text not null,
  recipient_email text not null,
  status text not null default 'queued',
  idempotency_key text not null,
  provider text,
  provider_message_id text,
  template_data jsonb not null default '{}'::jsonb,
  error text,
  sent_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  check (email_type in ('appointment_scheduled', 'appointment_pending', 'appointment_confirmed', 'appointment_cancelled', 'appointment_rescheduled')),
  check (status in ('queued', 'sending', 'sent', 'failed', 'skipped'))
);

create unique index if not exists appointment_email_events_idempotency_key_idx
  on public.appointment_email_events(idempotency_key);

create index if not exists appointment_email_events_stylist_status_idx
  on public.appointment_email_events(stylist_id, status, created_at);

create index if not exists appointment_email_events_appointment_id_idx
  on public.appointment_email_events(appointment_id);

alter table public.appointment_email_events enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'appointment_email_events'
      and policyname = 'appointment_email_events_select_own'
  ) then
    create policy appointment_email_events_select_own
      on public.appointment_email_events
      for select
      using (auth.uid() = stylist_id);
  end if;
end
$$;

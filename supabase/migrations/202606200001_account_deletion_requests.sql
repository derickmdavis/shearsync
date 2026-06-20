create table if not exists public.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  status text not null default 'pending',
  reason text,
  client_request_id text,
  requested_at timestamptz not null default now(),
  scheduled_deletion_at timestamptz,
  processing_started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  failure_reason text,
  created_ip_hash text,
  created_user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_deletion_requests_status_check
    check (status in ('pending', 'processing', 'failed_retryable', 'completed', 'cancelled')),
  constraint account_deletion_requests_reason_length_check
    check (reason is null or char_length(reason) <= 1000),
  constraint account_deletion_requests_client_request_id_length_check
    check (client_request_id is null or char_length(client_request_id) <= 120)
);

create unique index if not exists account_deletion_requests_user_active_idx
  on public.account_deletion_requests(user_id)
  where user_id is not null
    and status in ('pending', 'processing', 'failed_retryable');

create unique index if not exists account_deletion_requests_user_client_request_idx
  on public.account_deletion_requests(user_id, client_request_id)
  where user_id is not null
    and client_request_id is not null;

create index if not exists account_deletion_requests_status_scheduled_idx
  on public.account_deletion_requests(status, scheduled_deletion_at);

create table if not exists public.account_deletion_audit_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references public.account_deletion_requests(id) on delete set null,
  user_id uuid references public.users(id) on delete set null,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint account_deletion_audit_events_event_type_length_check
    check (char_length(trim(event_type)) between 1 and 80)
);

create index if not exists account_deletion_audit_events_request_idx
  on public.account_deletion_audit_events(request_id, created_at);

create index if not exists account_deletion_audit_events_user_idx
  on public.account_deletion_audit_events(user_id, created_at);

alter table public.account_deletion_requests enable row level security;
alter table public.account_deletion_audit_events enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'account_deletion_requests'
      and policyname = 'account_deletion_requests_select_own'
  ) then
    create policy account_deletion_requests_select_own
      on public.account_deletion_requests
      for select
      using (auth.uid() = user_id);
  end if;
end $$;

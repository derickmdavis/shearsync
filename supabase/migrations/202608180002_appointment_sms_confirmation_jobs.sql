-- Store confirmation work in the same transaction as appointment creation or
-- a pending-to-scheduled transition. The application worker renders and queues
-- the final SMS, so transient application/provider failures remain retryable.
create table if not exists public.appointment_sms_confirmation_jobs (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null unique references public.appointments(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'queued', 'skipped')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  completed_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointment_sms_confirmation_jobs_error_length_check check (
    (error_code is null or char_length(error_code) <= 120)
    and (error_message is null or char_length(error_message) <= 2000)
  )
);

create index if not exists appointment_sms_confirmation_jobs_pending_idx
  on public.appointment_sms_confirmation_jobs(status, next_attempt_at, created_at)
  where status = 'pending';

alter table public.appointment_sms_confirmation_jobs enable row level security;

create or replace function public.set_appointment_sms_confirmation_job_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists appointment_sms_confirmation_jobs_set_updated_at on public.appointment_sms_confirmation_jobs;
create trigger appointment_sms_confirmation_jobs_set_updated_at
  before update on public.appointment_sms_confirmation_jobs
  for each row execute function public.set_appointment_sms_confirmation_job_updated_at();

create or replace function public.enqueue_appointment_sms_confirmation_job()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT' and new.status = 'scheduled')
    or (tg_op = 'UPDATE' and new.status = 'scheduled' and old.status is distinct from 'scheduled') then
    insert into public.appointment_sms_confirmation_jobs (appointment_id, user_id)
    values (new.id, new.user_id)
    on conflict (appointment_id) do update
    set status = 'pending', attempt_count = 0, last_attempt_at = null, next_attempt_at = now(), completed_at = null,
        error_code = null, error_message = null, updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists appointments_enqueue_sms_confirmation_job on public.appointments;
create trigger appointments_enqueue_sms_confirmation_job
  after insert or update of status on public.appointments
  for each row execute function public.enqueue_appointment_sms_confirmation_job();

revoke all on function public.enqueue_appointment_sms_confirmation_job() from public, anon, authenticated;
grant execute on function public.enqueue_appointment_sms_confirmation_job() to service_role;

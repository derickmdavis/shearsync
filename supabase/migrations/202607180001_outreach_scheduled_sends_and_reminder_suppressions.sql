create table if not exists public.appointment_reminder_suppressions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  appointment_start_at timestamptz not null,
  reason text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint appointment_reminder_suppressions_reason_length_check
    check (reason is null or char_length(reason) <= 500),
  constraint appointment_reminder_suppressions_occurrence_unique
    unique (user_id, appointment_id, appointment_start_at)
);

create index if not exists appointment_reminder_suppressions_user_start_idx
  on public.appointment_reminder_suppressions(user_id, appointment_start_at);

create index if not exists appointment_reminder_suppressions_appointment_idx
  on public.appointment_reminder_suppressions(appointment_id);

alter table public.appointment_reminder_suppressions enable row level security;

drop policy if exists appointment_reminder_suppressions_select_own
  on public.appointment_reminder_suppressions;
create policy appointment_reminder_suppressions_select_own
  on public.appointment_reminder_suppressions
  for select
  using (auth.uid() = user_id);

drop policy if exists appointment_reminder_suppressions_insert_own
  on public.appointment_reminder_suppressions;
create policy appointment_reminder_suppressions_insert_own
  on public.appointment_reminder_suppressions
  for insert
  with check (auth.uid() = user_id and auth.uid() = created_by);

create or replace function public.cancel_appointment_reminder_occurrence(
  p_user_id uuid,
  p_appointment_id uuid,
  p_appointment_start_at timestamptz,
  p_reason text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_appointment public.appointments%rowtype;
  v_event public.appointment_email_events%rowtype;
  v_suppression public.appointment_reminder_suppressions%rowtype;
begin
  select *
  into v_appointment
  from public.appointments
  where id = p_appointment_id
    and user_id = p_user_id
    and appointment_date = p_appointment_start_at
    and status in ('pending', 'scheduled')
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'appointment_reminder_occurrence_not_found';
  end if;

  select *
  into v_event
  from public.appointment_email_events
  where user_id = p_user_id
    and appointment_id = p_appointment_id
    and email_type = 'appointment_reminder'
    and (template_data->>'appointment_start_time')::timestamptz = p_appointment_start_at
  for update;

  if found and v_event.status = 'sending' then
    raise exception using
      errcode = 'P0001',
      message = 'appointment_reminder_already_sending';
  end if;

  if found and v_event.status = 'sent' then
    raise exception using
      errcode = 'P0001',
      message = 'appointment_reminder_already_sent';
  end if;

  insert into public.appointment_reminder_suppressions (
    user_id,
    appointment_id,
    appointment_start_at,
    reason,
    created_by
  )
  values (
    p_user_id,
    p_appointment_id,
    p_appointment_start_at,
    nullif(trim(p_reason), ''),
    p_user_id
  )
  on conflict (user_id, appointment_id, appointment_start_at)
  do update set reason = coalesce(excluded.reason, public.appointment_reminder_suppressions.reason)
  returning * into v_suppression;

  update public.appointment_email_events
  set
    status = 'skipped',
    error = 'Appointment reminder cancelled by stylist',
    updated_at = now()
  where user_id = p_user_id
    and appointment_id = p_appointment_id
    and email_type = 'appointment_reminder'
    and (template_data->>'appointment_start_time')::timestamptz = p_appointment_start_at
    and status in ('queued', 'failed');

  return jsonb_build_object(
    'id', v_suppression.id,
    'appointment_id', v_suppression.appointment_id,
    'appointment_start_at', v_suppression.appointment_start_at,
    'status', 'cancelled',
    'reason', v_suppression.reason,
    'created_at', v_suppression.created_at
  );
end;
$$;

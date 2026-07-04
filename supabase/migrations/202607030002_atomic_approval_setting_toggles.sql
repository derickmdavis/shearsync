create or replace function public.upsert_birthday_reminder_settings_with_approval_mode(
  p_user_id uuid,
  p_approval_required boolean
)
returns jsonb
language plpgsql
as $$
declare
  v_settings jsonb;
begin
  with upserted as (
    insert into public.birthday_reminder_settings (
      user_id,
      approval_required
    )
    values (
      p_user_id,
      p_approval_required
    )
    on conflict (user_id)
    do update set
      approval_required = excluded.approval_required,
      updated_at = now()
    returning *
  )
  select to_jsonb(upserted) into v_settings
  from upserted;

  if p_approval_required then
    update public.birthday_reminders
    set
      status = 'pending_approval',
      error = null,
      updated_at = now()
    where user_id = p_user_id
      and status = 'queued'
      and scheduled_send_at >= now();
  else
    update public.birthday_reminders
    set
      status = 'queued',
      error = null,
      updated_at = now()
    where user_id = p_user_id
      and status = 'pending_approval';
  end if;

  return v_settings;
end;
$$;

create or replace function public.upsert_rebook_nudge_settings_with_approval_mode(
  p_user_id uuid,
  p_approval_required boolean,
  p_has_default_rebook_interval_days boolean default false,
  p_default_rebook_interval_days integer default null,
  p_has_subject_template boolean default false,
  p_subject_template text default null,
  p_has_custom_message_block boolean default false,
  p_custom_message_block text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_settings jsonb;
begin
  with upserted as (
    insert into public.rebook_nudge_settings (
      user_id,
      approval_required,
      default_rebook_interval_days,
      subject_template,
      custom_message_block
    )
    values (
      p_user_id,
      p_approval_required,
      case when p_has_default_rebook_interval_days then p_default_rebook_interval_days else 90 end,
      case when p_has_subject_template then p_subject_template else null end,
      case when p_has_custom_message_block then p_custom_message_block else null end
    )
    on conflict (user_id)
    do update set
      approval_required = excluded.approval_required,
      default_rebook_interval_days = case
        when p_has_default_rebook_interval_days then p_default_rebook_interval_days
        else public.rebook_nudge_settings.default_rebook_interval_days
      end,
      subject_template = case
        when p_has_subject_template then p_subject_template
        else public.rebook_nudge_settings.subject_template
      end,
      custom_message_block = case
        when p_has_custom_message_block then p_custom_message_block
        else public.rebook_nudge_settings.custom_message_block
      end,
      updated_at = now()
    returning *
  )
  select to_jsonb(upserted) into v_settings
  from upserted;

  if p_approval_required then
    update public.rebook_nudges
    set
      status = 'pending_approval',
      approval_required = true,
      error = null,
      updated_at = now()
    where user_id = p_user_id
      and status = 'queued'
      and approval_required = false;
  else
    update public.rebook_nudges
    set
      status = 'queued',
      approval_required = false,
      approved_at = now(),
      approved_by = p_user_id,
      error = null,
      updated_at = now()
    where user_id = p_user_id
      and status = 'pending_approval';
  end if;

  return v_settings;
end;
$$;

create or replace function public.upsert_thank_you_email_settings_with_approval_mode(
  p_user_id uuid,
  p_approval_required boolean,
  p_has_send_delay_hours boolean default false,
  p_send_delay_hours integer default null,
  p_has_subject_template boolean default false,
  p_subject_template text default null,
  p_has_custom_message_block boolean default false,
  p_custom_message_block text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_settings jsonb;
begin
  with upserted as (
    insert into public.thank_you_email_settings (
      user_id,
      approval_required,
      send_delay_hours,
      subject_template,
      custom_message_block
    )
    values (
      p_user_id,
      p_approval_required,
      case when p_has_send_delay_hours then p_send_delay_hours else 0 end,
      case when p_has_subject_template then p_subject_template else null end,
      case when p_has_custom_message_block then p_custom_message_block else null end
    )
    on conflict (user_id)
    do update set
      approval_required = excluded.approval_required,
      send_delay_hours = case
        when p_has_send_delay_hours then p_send_delay_hours
        else public.thank_you_email_settings.send_delay_hours
      end,
      subject_template = case
        when p_has_subject_template then p_subject_template
        else public.thank_you_email_settings.subject_template
      end,
      custom_message_block = case
        when p_has_custom_message_block then p_custom_message_block
        else public.thank_you_email_settings.custom_message_block
      end,
      updated_at = now()
    returning *
  )
  select to_jsonb(upserted) into v_settings
  from upserted;

  if p_approval_required then
    update public.thank_you_emails
    set
      status = 'pending_approval',
      approval_required = true,
      error = null,
      updated_at = now()
    where user_id = p_user_id
      and status = 'queued'
      and approval_required = false;
  else
    update public.thank_you_emails
    set
      status = 'queued',
      approval_required = false,
      approved_at = now(),
      approved_by = p_user_id,
      error = null,
      updated_at = now()
    where user_id = p_user_id
      and status = 'pending_approval';
  end if;

  return v_settings;
end;
$$;

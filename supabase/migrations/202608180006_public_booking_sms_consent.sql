-- Keep one auditable opt-in per contact and public appointment, even if the
-- booking request is retried after its appointment has already been created.
create unique index if not exists communication_consent_events_public_booking_sms_opt_in_unique
  on public.communication_consent_events (
    user_id,
    client_id,
    contact_normalized,
    (metadata ->> 'appointment_id')
  )
  where channel = 'sms'
    and event_type = 'opted_in'
    and source = 'booking_page'
    and metadata ? 'appointment_id';

drop function if exists public.apply_manual_sms_preference(
  uuid, uuid, text, text, text, text, text,
  boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean
);

create function public.apply_manual_sms_preference(
  p_user_id uuid,
  p_client_id uuid,
  p_phone text,
  p_phone_normalized text,
  p_action text,
  p_source text,
  p_consent_text text,
  p_has_transactional boolean,
  p_transactional_enabled boolean,
  p_has_reminders boolean,
  p_reminders_enabled boolean,
  p_has_marketing boolean,
  p_marketing_enabled boolean,
  p_has_rebooking boolean,
  p_rebooking_enabled boolean,
  p_ip_address text default null,
  p_user_agent text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.client_communication_preferences
language plpgsql
security definer
set search_path = public
as $$
declare
  preference public.client_communication_preferences;
  event_id uuid;
  event_type text;
begin
  if p_action not in ('preferences', 'opt_in', 'opt_out') then
    raise exception 'invalid_sms_preference_action';
  end if;

  perform 1 from public.clients where id = p_client_id and user_id = p_user_id;
  if not found then
    raise exception 'client_not_found';
  end if;

  insert into public.client_communication_preferences (
    user_id, client_id, phone, phone_normalized
  ) values (
    p_user_id, p_client_id, p_phone, p_phone_normalized
  ) on conflict (user_id, phone_normalized) do update
  set
    client_id = coalesce(client_communication_preferences.client_id, excluded.client_id),
    phone = coalesce(client_communication_preferences.phone, excluded.phone),
    updated_at = now()
  returning * into preference;

  if p_action = 'opt_in'
    and p_source = 'booking_page'
    and nullif(trim(coalesce(p_metadata ->> 'appointment_id', '')), '') is not null then
    select id into event_id
    from public.communication_consent_events
    where user_id = p_user_id
      and client_id = p_client_id
      and channel = 'sms'
      and contact_normalized = p_phone_normalized
      and event_type = 'opted_in'
      and source = 'booking_page'
      and metadata ->> 'appointment_id' = p_metadata ->> 'appointment_id'
    order by created_at desc
    limit 1;

    if event_id is not null then
      return preference;
    end if;
  end if;

  if p_action = 'opt_in' then
    if nullif(trim(coalesce(p_consent_text, '')), '') is null then
      raise exception 'sms_opt_in_requires_consent_text';
    end if;

    update public.client_communication_preferences
    set
      opted_out_all_sms = false,
      sms_transactional_enabled = case when p_has_transactional then p_transactional_enabled else true end,
      sms_reminders_enabled = case when p_has_reminders then p_reminders_enabled else true end,
      sms_marketing_enabled = false,
      sms_rebooking_enabled = false,
      sms_opted_in_at = now(),
      sms_opt_in_source = p_source,
      sms_opt_in_text = p_consent_text,
      sms_opted_out_at = null,
      sms_opt_out_source = null,
      updated_at = now()
    where id = preference.id
    returning * into preference;
    event_type := 'opted_in';
  elsif p_action = 'opt_out' then
    update public.client_communication_preferences
    set
      opted_out_all_sms = true,
      sms_transactional_enabled = false,
      sms_reminders_enabled = false,
      sms_marketing_enabled = false,
      sms_rebooking_enabled = false,
      sms_opted_out_at = now(),
      sms_opt_out_source = p_source,
      updated_at = now()
    where id = preference.id
    returning * into preference;
    event_type := 'opted_out';
  else
    if preference.sms_opted_in_at is null or preference.opted_out_all_sms then
      raise exception 'sms_explicit_opt_in_required';
    end if;

    update public.client_communication_preferences
    set
      sms_transactional_enabled = case when p_has_transactional then p_transactional_enabled else sms_transactional_enabled end,
      sms_reminders_enabled = case when p_has_reminders then p_reminders_enabled else sms_reminders_enabled end,
      sms_marketing_enabled = case when p_has_marketing then p_marketing_enabled else sms_marketing_enabled end,
      sms_rebooking_enabled = case when p_has_rebooking then p_rebooking_enabled else sms_rebooking_enabled end,
      updated_at = now()
    where id = preference.id
    returning * into preference;
    event_type := 'preference_updated';
  end if;

  begin
    insert into public.communication_consent_events (
      user_id, client_id, channel, contact_value, contact_normalized,
      event_type, source, consent_text, ip_address, user_agent, metadata
    ) values (
      p_user_id, p_client_id, 'sms', p_phone, p_phone_normalized,
      event_type, p_source, case when p_action = 'opt_in' then p_consent_text else null end,
      p_ip_address, p_user_agent,
      jsonb_build_object('consent_scope', 'account', 'action', p_action) || coalesce(p_metadata, '{}'::jsonb)
    ) returning id into event_id;
  exception when unique_violation then
    select id into event_id
    from public.communication_consent_events
    where user_id = p_user_id
      and client_id = p_client_id
      and channel = 'sms'
      and contact_normalized = p_phone_normalized
      and event_type = 'opted_in'
      and source = 'booking_page'
      and metadata ->> 'appointment_id' = p_metadata ->> 'appointment_id'
    order by created_at desc
    limit 1;

    if event_id is null then
      raise exception 'sms_consent_event_write_conflict';
    end if;
  end;

  update public.client_communication_preferences
  set sms_last_consent_event_id = event_id, updated_at = now()
  where id = preference.id
  returning * into preference;

  return preference;
end;
$$;

revoke all on function public.apply_manual_sms_preference(
  uuid, uuid, text, text, text, text, text,
  boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean,
  text, text, jsonb
) from public;
grant execute on function public.apply_manual_sms_preference(
  uuid, uuid, text, text, text, text, text,
  boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean,
  text, text, jsonb
) to service_role;

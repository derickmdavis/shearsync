alter table public.client_communication_preferences
  add column if not exists sms_last_consent_event_id uuid
  references public.communication_consent_events(id) on delete set null;

alter table public.communication_consent_events
  drop constraint if exists communication_consent_events_source_check;

alter table public.communication_consent_events
  add constraint communication_consent_events_source_check
  check (source in (
    'booking_page', 'staff', 'admin', 'unsubscribe_link', 'inbound_sms',
    'manual', 'import', 'client_portal', 'system'
  ));

create or replace function public.apply_manual_sms_preference(
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
  p_rebooking_enabled boolean
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

  insert into public.communication_consent_events (
    user_id, client_id, channel, contact_value, contact_normalized,
    event_type, source, consent_text, metadata
  ) values (
    p_user_id, p_client_id, 'sms', p_phone, p_phone_normalized,
    event_type, p_source, case when p_action = 'opt_in' then p_consent_text else null end,
    jsonb_build_object('consent_scope', 'account', 'action', p_action)
  ) returning id into event_id;

  update public.client_communication_preferences
  set sms_last_consent_event_id = event_id, updated_at = now()
  where id = preference.id
  returning * into preference;

  return preference;
end;
$$;

revoke all on function public.apply_manual_sms_preference(uuid, uuid, text, text, text, text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean) from public;
grant execute on function public.apply_manual_sms_preference(uuid, uuid, text, text, text, text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean) to service_role;

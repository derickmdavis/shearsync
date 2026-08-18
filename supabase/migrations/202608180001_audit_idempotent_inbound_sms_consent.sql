-- Audit each distinct inbound STOP, START, or HELP callback even when it does
-- not change an already-correct preference state. The unique inbound-event
-- indexes keep provider retries idempotent.
create or replace function public.apply_inbound_sms_consent(
  p_from text, p_from_normalized text, p_provider_message_id text,
  p_classification text, p_inbound_event_id uuid, p_metadata jsonb
)
returns void language plpgsql security definer set search_path = public as $$
declare r public.client_communication_preferences; changed boolean; v_event_type text;
begin
  if p_classification not in ('stop', 'start', 'help') then raise exception 'invalid_inbound_sms_classification'; end if;
  for r in select * from public.client_communication_preferences where phone_normalized = p_from_normalized for update loop
    changed := false;
    if p_classification = 'stop' then
      changed := r.opted_out_all_sms is distinct from true or r.sms_transactional_enabled is distinct from false
        or r.sms_reminders_enabled is distinct from false or r.sms_marketing_enabled is distinct from false or r.sms_rebooking_enabled is distinct from false;
      if changed then
        update public.client_communication_preferences set opted_out_all_sms = true, sms_transactional_enabled = false,
          sms_reminders_enabled = false, sms_marketing_enabled = false, sms_rebooking_enabled = false,
          sms_opted_out_at = now(), sms_opt_out_source = 'inbound_sms', updated_at = now() where id = r.id;
      end if;
      v_event_type := 'inbound_stop';
    elsif p_classification = 'start' then
      changed := r.opted_out_all_sms is distinct from false or r.sms_transactional_enabled is distinct from true
        or r.sms_reminders_enabled is distinct from true or r.sms_marketing_enabled is distinct from false or r.sms_rebooking_enabled is distinct from false
        or r.sms_opted_in_at is null;
      if changed then
        update public.client_communication_preferences set opted_out_all_sms = false, sms_transactional_enabled = true,
          sms_reminders_enabled = true, sms_marketing_enabled = false, sms_rebooking_enabled = false,
          sms_opted_in_at = now(), sms_opt_in_source = 'inbound_sms', sms_opted_out_at = null, sms_opted_out_source = null,
          updated_at = now() where id = r.id;
      end if;
      v_event_type := 'inbound_start';
    else
      v_event_type := 'inbound_help';
    end if;

    if not exists (
      select 1 from public.communication_consent_events where sms_inbound_event_id = p_inbound_event_id and user_id = r.user_id and event_type = v_event_type
    ) then
      insert into public.communication_consent_events (user_id, client_id, channel, contact_value, contact_normalized, event_type, source, metadata, sms_inbound_event_id)
      values (r.user_id, r.client_id, 'sms', p_from, p_from_normalized, v_event_type, 'inbound_sms', p_metadata, p_inbound_event_id);
      insert into public.communication_events (user_id, client_id, channel, to_address, to_normalized, provider, provider_message_id, status, metadata, sms_inbound_event_id)
      values (r.user_id, r.client_id, 'sms', p_from, p_from_normalized, 'twilio', p_provider_message_id, v_event_type, p_metadata, p_inbound_event_id);
    end if;
  end loop;
end;
$$;

revoke all on function public.apply_inbound_sms_consent(text, text, text, text, uuid, jsonb) from public;
grant execute on function public.apply_inbound_sms_consent(text, text, text, text, uuid, jsonb) to service_role;

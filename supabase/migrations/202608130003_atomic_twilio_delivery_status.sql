create unique index if not exists communication_events_twilio_final_status_unique
  on public.communication_events(provider, provider_message_id, status)
  where channel = 'sms'
    and provider = 'twilio'
    and provider_message_id is not null
    and status in ('delivered', 'failed');

create or replace function public.apply_twilio_sms_delivery_status(
  p_provider_message_id text,
  p_message_status text,
  p_error_code text default null,
  p_error_message text default null,
  p_to text default null,
  p_diagnostics jsonb default '{}'::jsonb
)
returns table(updated boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message public.sms_messages%rowtype;
  v_internal_status text;
  v_now timestamptz := now();
begin
  select * into v_message from public.sms_messages
  where provider = 'twilio' and provider_message_id = p_provider_message_id
  for update;

  if not found or v_message.status in ('delivered', 'failed', 'skipped', 'cancelled') then
    return query select false;
    return;
  end if;

  v_internal_status := case lower(p_message_status)
    when 'accepted' then 'sent' when 'queued' then 'sent' when 'sending' then 'sent'
    when 'sent' then 'sent' when 'delivered' then 'delivered'
    when 'failed' then 'failed' when 'undelivered' then 'failed' else null
  end;

  if v_message.status = 'unknown' and v_internal_status = 'sent' then
    return query select false;
    return;
  end if;

  update public.sms_messages
  set metadata = coalesce(v_message.metadata, '{}'::jsonb) || jsonb_build_object(
        'twilio_last_status', lower(p_message_status), 'twilio_last_status_to', p_to,
        'twilio_diagnostics', coalesce(p_diagnostics, '{}'::jsonb)
      ),
      status = coalesce(v_internal_status, v_message.status),
      sent_at = case when v_internal_status = 'sent' then coalesce(v_message.sent_at, v_now) else v_message.sent_at end,
      delivered_at = case when v_internal_status = 'delivered' then v_now else v_message.delivered_at end,
      failed_at = case when v_internal_status = 'failed' then v_now else v_message.failed_at end,
      error_code = case when v_internal_status in ('sent', 'delivered') then null when v_internal_status = 'failed' then coalesce(p_error_code, 'twilio_undelivered') else v_message.error_code end,
      error_message = case when v_internal_status in ('sent', 'delivered') then null when v_internal_status = 'failed' then coalesce(p_error_message, 'Twilio reported that the SMS could not be delivered.') else v_message.error_message end,
      next_attempt_at = case when v_internal_status is not null then null else v_message.next_attempt_at end
  where id = v_message.id;

  if v_internal_status in ('delivered', 'failed') then
    insert into public.communication_events (
      user_id, client_id, channel, message_type, to_address, to_normalized,
      provider, provider_message_id, status, error_code, error_message, metadata
    ) values (
      v_message.user_id, v_message.client_id, 'sms', v_message.message_type,
      v_message.recipient_phone, v_message.recipient_phone_normalized,
      'twilio', p_provider_message_id, v_internal_status,
      case when v_internal_status = 'failed' then coalesce(p_error_code, 'twilio_undelivered') else null end,
      case when v_internal_status = 'failed' then coalesce(p_error_message, 'Twilio reported that the SMS could not be delivered.') else null end,
      jsonb_build_object('sms_message_id', v_message.id, 'twilio_status', lower(p_message_status),
        'twilio_error_code', p_error_code, 'twilio_diagnostics', coalesce(p_diagnostics, '{}'::jsonb))
    ) on conflict do nothing;
  end if;

  return query select true;
end;
$$;

revoke all on function public.apply_twilio_sms_delivery_status(text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_twilio_sms_delivery_status(text, text, text, text, text, jsonb) to service_role;

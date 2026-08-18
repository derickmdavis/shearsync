-- A provider request may time out locally after Twilio accepts it. In that case
-- the outbox does not know Twilio's SID, so retain later callbacks by exact SID
-- for operator reconciliation. Do not infer an outbox match from a phone number.
create table if not exists public.sms_unmatched_delivery_status_callbacks (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'twilio' check (provider = 'twilio'),
  provider_message_id text not null check (char_length(provider_message_id) between 1 and 255),
  message_status text not null check (char_length(message_status) between 1 and 64),
  to_phone_normalized text,
  error_code text,
  error_message text,
  provider_diagnostics jsonb not null default '{}'::jsonb,
  callback_count integer not null default 1 check (callback_count >= 1),
  first_received_at timestamptz not null default now(),
  last_received_at timestamptz not null default now(),
  resolved_sms_message_id uuid references public.sms_messages(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sms_unmatched_delivery_status_callback_unique unique (provider, provider_message_id),
  constraint sms_unmatched_delivery_status_error_length_check check (
    (error_code is null or char_length(error_code) <= 120)
    and (error_message is null or char_length(error_message) <= 500)
  )
);

create index if not exists sms_unmatched_delivery_status_callbacks_open_idx
  on public.sms_unmatched_delivery_status_callbacks(last_received_at desc)
  where resolved_at is null;

alter table public.sms_unmatched_delivery_status_callbacks enable row level security;

drop function if exists public.apply_twilio_sms_delivery_status(text, text, text, text, text, jsonb);
create function public.apply_twilio_sms_delivery_status(
  p_provider_message_id text,
  p_message_status text,
  p_error_code text default null,
  p_error_message text default null,
  p_to text default null,
  p_diagnostics jsonb default '{}'::jsonb
)
returns table(updated boolean, unmatched boolean)
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

  if not found then
    insert into public.sms_unmatched_delivery_status_callbacks (
      provider, provider_message_id, message_status, to_phone_normalized,
      error_code, error_message, provider_diagnostics, last_received_at
    ) values (
      'twilio', p_provider_message_id, lower(p_message_status), p_to,
      p_error_code, p_error_message, coalesce(p_diagnostics, '{}'::jsonb), v_now
    ) on conflict (provider, provider_message_id) do update
    set message_status = excluded.message_status,
        to_phone_normalized = coalesce(excluded.to_phone_normalized, sms_unmatched_delivery_status_callbacks.to_phone_normalized),
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        provider_diagnostics = excluded.provider_diagnostics,
        callback_count = sms_unmatched_delivery_status_callbacks.callback_count + 1,
        last_received_at = excluded.last_received_at,
        updated_at = v_now;
    return query select false, true;
    return;
  end if;

  if v_message.status in ('delivered', 'failed', 'skipped', 'cancelled') then
    return query select false, false;
    return;
  end if;

  v_internal_status := case lower(p_message_status)
    when 'accepted' then 'sent' when 'queued' then 'sent' when 'sending' then 'sent'
    when 'sent' then 'sent' when 'delivered' then 'delivered'
    when 'failed' then 'failed' when 'undelivered' then 'failed' else null
  end;

  if v_message.status = 'unknown' and v_internal_status = 'sent' then
    return query select false, false;
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

  return query select true, false;
end;
$$;

revoke all on function public.apply_twilio_sms_delivery_status(text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_twilio_sms_delivery_status(text, text, text, text, text, jsonb) to service_role;

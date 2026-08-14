create unique index if not exists sms_messages_provider_message_unique
  on public.sms_messages(provider, provider_message_id)
  where provider is not null and provider_message_id is not null;

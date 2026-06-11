alter table public.communication_events
  drop constraint if exists communication_events_message_type_check;

alter table public.communication_events
  add constraint communication_events_message_type_check
  check (
    message_type is null
    or message_type in (
      'appointment_confirmation',
      'appointment_reminder',
      'appointment_cancelled',
      'appointment_rescheduled',
      'waitlist_update',
      'rebooking_prompt',
      'birthday_reminder',
      'marketing',
      'business_recap'
    )
  );

alter table public.communication_consent_events
  drop constraint if exists communication_consent_events_message_type_check;

alter table public.communication_consent_events
  add constraint communication_consent_events_message_type_check
  check (
    message_type is null
    or message_type in (
      'appointment_confirmation',
      'appointment_reminder',
      'appointment_cancelled',
      'appointment_rescheduled',
      'waitlist_update',
      'rebooking_prompt',
      'birthday_reminder',
      'marketing',
      'business_recap'
    )
  );

alter table public.communication_preference_tokens
  drop constraint if exists communication_preference_tokens_message_type_check;

alter table public.communication_preference_tokens
  add constraint communication_preference_tokens_message_type_check
  check (
    message_type is null
    or message_type in (
      'appointment_confirmation',
      'appointment_reminder',
      'appointment_cancelled',
      'appointment_rescheduled',
      'waitlist_update',
      'rebooking_prompt',
      'birthday_reminder',
      'marketing',
      'business_recap'
    )
  );

alter table public.appointment_email_events
  drop constraint if exists appointment_email_events_email_type_check;

alter table public.appointment_email_events
  add constraint appointment_email_events_email_type_check
  check (email_type in (
    'appointment_scheduled',
    'appointment_pending',
    'appointment_confirmed',
    'appointment_cancelled',
    'appointment_rescheduled',
    'appointment_reminder',
    'rebooking_prompt',
    'birthday_reminder',
    'thank_you_email'
  ));

alter table public.appointment_email_templates
  drop constraint if exists appointment_email_templates_email_type_check;

alter table public.appointment_email_templates
  add constraint appointment_email_templates_email_type_check
  check (email_type in (
    'appointment_scheduled',
    'appointment_pending',
    'appointment_confirmed',
    'appointment_cancelled',
    'appointment_rescheduled',
    'appointment_reminder',
    'rebooking_prompt',
    'birthday_reminder',
    'thank_you_email'
  ));

alter table public.birthday_reminders
  add column if not exists subject_snapshot text,
  add column if not exists custom_message_block_snapshot text;

alter table public.birthday_reminders
  drop constraint if exists birthday_reminders_subject_length_check;

alter table public.birthday_reminders
  add constraint birthday_reminders_subject_length_check
  check (subject_snapshot is null or char_length(subject_snapshot) <= 160);

alter table public.birthday_reminders
  drop constraint if exists birthday_reminders_message_length_check;

alter table public.birthday_reminders
  add constraint birthday_reminders_message_length_check
  check (custom_message_block_snapshot is null or char_length(custom_message_block_snapshot) <= 4000);

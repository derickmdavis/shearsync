alter table public.automation_settings
  drop constraint if exists automation_settings_key_check;

alter table public.automation_settings
  add constraint automation_settings_key_check
  check (
    key in (
      'rebook_nudges',
      'appointment_reminders',
      'email_confirmations',
      'no_show_follow_up',
      'waitlist_match',
      'birthday_reminders',
      'thank_you_emails'
    )
  );

alter table public.activity_events
  drop constraint if exists activity_events_activity_type_check;

alter table public.activity_events
  add constraint activity_events_activity_type_check
  check (
    activity_type in (
      'booking_created',
      'appointment_cancelled',
      'appointment_rescheduled',
      'reminder_sent',
      'waitlist_joined',
      'client_rebook_needed'
    )
  );

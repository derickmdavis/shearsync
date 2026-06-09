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
      'waitlist_match'
    )
  );

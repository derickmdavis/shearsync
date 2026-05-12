alter table public.appointment_email_events
  drop constraint if exists appointment_email_events_email_type_check;

alter table public.appointment_email_events
  add constraint appointment_email_events_email_type_check
  check (
    email_type in (
      'appointment_scheduled',
      'appointment_pending',
      'appointment_confirmed',
      'appointment_cancelled',
      'appointment_rescheduled'
    )
  );

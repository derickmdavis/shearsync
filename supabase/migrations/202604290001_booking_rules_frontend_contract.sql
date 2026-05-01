alter table public.booking_rules
  drop column if exists manual_review_required;

alter table public.booking_rules
  drop constraint if exists booking_rules_new_client_booking_window_days_check;

alter table public.booking_rules
  add constraint booking_rules_new_client_booking_window_days_check
  check (new_client_booking_window_days >= 0);

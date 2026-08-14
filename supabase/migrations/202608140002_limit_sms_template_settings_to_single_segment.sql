-- Existing databases may already have the initial 320-character check.
alter table public.sms_template_settings
  drop constraint if exists sms_template_settings_custom_body_check;

alter table public.sms_template_settings
  add constraint sms_template_settings_custom_body_check
  check (custom_body is null or char_length(custom_body) between 1 and 160) not valid;

-- NOT VALID preserves existing custom copy; the service still rejects it at render
-- time until the account owner shortens it. New or changed rows must meet the limit.

alter table public.clients
  drop column if exists unread_message_count;

alter table public.clients
  alter column tags drop not null,
  alter column tags drop default,
  alter column reminder_consent drop not null,
  alter column reminder_consent drop default,
  alter column total_spend drop default;

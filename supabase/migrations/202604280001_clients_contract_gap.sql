alter table public.clients
  add column if not exists preferred_name text,
  add column if not exists instagram text,
  add column if not exists preferred_contact_method text check (preferred_contact_method in ('text', 'call', 'email', 'instagram')),
  add column if not exists tags text[] not null default '{}',
  add column if not exists source text check (source in ('referral', 'instagram', 'walk-in', 'existing-client', 'other')),
  add column if not exists reminder_consent boolean not null default false,
  add column if not exists unread_message_count integer not null default 0 check (unread_message_count >= 0);

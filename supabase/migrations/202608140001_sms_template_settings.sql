create table public.sms_template_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  template_type text not null check (template_type in ('appointment_reminder')),
  enabled boolean not null default true,
  custom_body text check (custom_body is null or char_length(custom_body) between 1 and 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sms_template_settings_user_type_unique unique (user_id, template_type)
);

create index sms_template_settings_user_id_idx on public.sms_template_settings(user_id);
alter table public.sms_template_settings enable row level security;

create or replace function public.set_sms_template_settings_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger sms_template_settings_set_updated_at
  before update on public.sms_template_settings
  for each row execute function public.set_sms_template_settings_updated_at();

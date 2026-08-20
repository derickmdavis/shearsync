create table if not exists public.in_app_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  rating smallint not null,
  feedback_text text,
  source text not null default 'mobile_app',
  created_at timestamptz not null default now(),
  constraint in_app_feedback_rating_check check (rating between 1 and 3),
  constraint in_app_feedback_text_length_check
    check (feedback_text is null or char_length(feedback_text) <= 4000),
  constraint in_app_feedback_source_check check (source in ('mobile_app'))
);

create index if not exists in_app_feedback_created_at_idx
  on public.in_app_feedback(created_at desc);
create index if not exists in_app_feedback_user_created_at_idx
  on public.in_app_feedback(user_id, created_at desc);
create index if not exists in_app_feedback_rating_created_at_idx
  on public.in_app_feedback(rating, created_at desc);

alter table public.in_app_feedback enable row level security;

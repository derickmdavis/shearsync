with ranked_email_events as (
  select
    id,
    row_number() over (
      partition by idempotency_key
      order by created_at desc nulls last, id desc
    ) as duplicate_rank
  from public.appointment_email_events
)
delete from public.appointment_email_events events
using ranked_email_events ranked
where events.id = ranked.id
  and ranked.duplicate_rank > 1;

create unique index if not exists appointment_email_events_idempotency_key_idx
  on public.appointment_email_events(idempotency_key);

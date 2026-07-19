create table public.campaign_delivery_events (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null,
  campaign_recipient_id uuid not null,
  user_id uuid not null,
  provider text not null,
  provider_event_id text not null,
  provider_message_id text,
  event_type text not null,
  occurred_at timestamptz not null,
  url text,
  is_automated boolean not null default false,
  privacy_limited boolean not null default false,
  provider_payload jsonb,
  created_at timestamptz not null default now(),
  constraint campaign_delivery_events_campaign_fkey foreign key (campaign_id, user_id)
    references public.campaigns(id, user_id) on delete cascade,
  constraint campaign_delivery_events_recipient_fkey foreign key (campaign_recipient_id)
    references public.campaign_recipients(id) on delete cascade,
  constraint campaign_delivery_events_provider_event_unique unique (provider, provider_event_id),
  constraint campaign_delivery_events_type_check check (event_type in ('delivered', 'opened', 'clicked', 'bounced', 'complained')),
  constraint campaign_delivery_events_provider_check check (char_length(trim(provider)) between 1 and 80),
  constraint campaign_delivery_events_provider_event_check check (char_length(trim(provider_event_id)) between 1 and 255),
  constraint campaign_delivery_events_provider_message_check check (provider_message_id is null or char_length(provider_message_id) <= 255),
  constraint campaign_delivery_events_url_check check (url is null or char_length(url) <= 4000)
);

create index campaign_delivery_events_campaign_type_idx
  on public.campaign_delivery_events(campaign_id, event_type, occurred_at desc);
create index campaign_delivery_events_recipient_type_idx
  on public.campaign_delivery_events(campaign_recipient_id, event_type, occurred_at desc);
create index campaign_delivery_events_provider_message_idx
  on public.campaign_delivery_events(provider, provider_message_id)
  where provider_message_id is not null;

alter table public.campaign_delivery_events enable row level security;
create policy campaign_delivery_events_owner_select on public.campaign_delivery_events
  for select using (auth.uid() = user_id);
revoke all on table public.campaign_delivery_events from anon, authenticated;
grant select, insert, update, delete on table public.campaign_delivery_events to service_role;

create or replace function public.get_campaign_reporting_summaries_v2(p_user_id uuid, p_campaign_ids uuid[])
returns table (
  campaign_id uuid, recipient_total bigint, eligible_count bigint, excluded_count bigint, pending_count bigint,
  queued_count bigint, sending_count bigint, sent_count bigint, delivered_count bigint, failed_count bigint,
  skipped_count bigint, cancelled_count bigint, attributed_booking_count bigint, booked_revenue_cents bigint,
  delivered_raw bigint, opens_raw bigint, opens_unique bigint, opens_automated bigint, opens_privacy_limited bigint,
  clicks_raw bigint, clicks_unique bigint, clicks_automated bigint, clicks_privacy_limited bigint
)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then raise exception using errcode = '42501', message = 'campaign_owner_mismatch'; end if;
  return query
  select c.id, coalesce(r.recipient_total, 0), coalesce(r.eligible_count, 0), coalesce(r.excluded_count, 0),
    coalesce(r.pending_count, 0), coalesce(r.queued_count, 0), coalesce(r.sending_count, 0), coalesce(r.sent_count, 0),
    coalesce(r.delivered_count, 0), coalesce(r.failed_count, 0), coalesce(r.skipped_count, 0), coalesce(r.cancelled_count, 0),
    coalesce(a.attributed_booking_count, 0), coalesce(a.booked_revenue_cents, 0),
    coalesce(e.delivered_raw, 0), coalesce(e.opens_raw, 0), coalesce(e.opens_unique, 0), coalesce(e.opens_automated, 0), coalesce(e.opens_privacy_limited, 0),
    coalesce(e.clicks_raw, 0), coalesce(e.clicks_unique, 0), coalesce(e.clicks_automated, 0), coalesce(e.clicks_privacy_limited, 0)
  from public.campaigns c
  left join lateral (
    select count(*)::bigint recipient_total, count(*) filter (where eligibility_status = 'eligible')::bigint eligible_count,
      count(*) filter (where eligibility_status = 'excluded')::bigint excluded_count, count(*) filter (where status = 'pending')::bigint pending_count,
      count(*) filter (where status = 'queued')::bigint queued_count, count(*) filter (where status = 'sending')::bigint sending_count,
      count(*) filter (where status = 'sent')::bigint sent_count, count(*) filter (where status = 'delivered')::bigint delivered_count,
      count(*) filter (where status = 'failed')::bigint failed_count, count(*) filter (where status = 'skipped')::bigint skipped_count,
      count(*) filter (where status = 'cancelled')::bigint cancelled_count
    from public.campaign_recipients r where r.campaign_id = c.id and r.user_id = p_user_id
  ) r on true
  left join lateral (
    select count(*)::bigint attributed_booking_count, coalesce(sum(round(coalesce(a.price, 0) * 100))::bigint, 0)::bigint booked_revenue_cents
    from public.appointments a where a.campaign_id = c.id and a.user_id = p_user_id and a.status <> 'cancelled'
  ) a on true
  left join lateral (
    select count(*) filter (where event_type = 'delivered')::bigint delivered_raw,
      count(*) filter (where event_type = 'opened')::bigint opens_raw, count(distinct campaign_recipient_id) filter (where event_type = 'opened')::bigint opens_unique,
      count(*) filter (where event_type = 'opened' and is_automated)::bigint opens_automated, count(*) filter (where event_type = 'opened' and privacy_limited)::bigint opens_privacy_limited,
      count(*) filter (where event_type = 'clicked')::bigint clicks_raw, count(distinct campaign_recipient_id) filter (where event_type = 'clicked')::bigint clicks_unique,
      count(*) filter (where event_type = 'clicked' and is_automated)::bigint clicks_automated, count(*) filter (where event_type = 'clicked' and privacy_limited)::bigint clicks_privacy_limited
    from public.campaign_delivery_events e where e.campaign_id = c.id and e.user_id = p_user_id
  ) e on true
  where c.user_id = p_user_id and c.id = any(p_campaign_ids);
end;
$$;

insert into public.outreach_schema_versions (component, version, applied_at)
values ('campaign_authoring', 'campaign_delivery_analytics_2026_07_18', now())
on conflict (component) do update set version = excluded.version, applied_at = excluded.applied_at;
revoke all on function public.get_campaign_reporting_summaries_v2(uuid, uuid[]) from public;
grant execute on function public.get_campaign_reporting_summaries_v2(uuid, uuid[]) to authenticated, service_role;

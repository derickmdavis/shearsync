alter table public.appointments
  add column if not exists campaign_id uuid,
  add column if not exists campaign_run_id uuid,
  add column if not exists campaign_recipient_id uuid,
  add column if not exists campaign_attributed_at timestamptz;

alter table public.appointments
  add constraint appointments_campaign_fkey
    foreign key (campaign_id) references public.campaigns(id) on delete set null,
  add constraint appointments_campaign_run_fkey
    foreign key (campaign_run_id) references public.campaign_runs(id) on delete set null,
  add constraint appointments_campaign_recipient_fkey
    foreign key (campaign_recipient_id) references public.campaign_recipients(id) on delete set null;

create index appointments_campaign_attribution_idx
  on public.appointments(campaign_id, campaign_attributed_at desc)
  where campaign_id is not null and status <> 'cancelled';
create index campaign_recipients_tracking_token_idx
  on public.campaign_recipients(booking_tracking_token_hash)
  where booking_tracking_token_hash is not null;

insert into public.outreach_schema_versions (component, version, applied_at)
values ('campaign_authoring', 'campaign_booking_attribution_2026_07_18', now())
on conflict (component) do update set version = excluded.version, applied_at = excluded.applied_at;

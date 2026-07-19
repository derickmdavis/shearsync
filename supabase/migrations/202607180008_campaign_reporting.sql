create or replace function public.get_campaign_reporting_summaries(p_user_id uuid, p_campaign_ids uuid[])
returns table (
  campaign_id uuid,
  recipient_total bigint,
  eligible_count bigint,
  excluded_count bigint,
  pending_count bigint,
  queued_count bigint,
  sending_count bigint,
  sent_count bigint,
  delivered_count bigint,
  failed_count bigint,
  skipped_count bigint,
  cancelled_count bigint,
  attributed_booking_count bigint,
  booked_revenue_cents bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception using errcode = '42501', message = 'campaign_owner_mismatch';
  end if;

  return query
  select
    c.id,
    coalesce(r.recipient_total, 0), coalesce(r.eligible_count, 0), coalesce(r.excluded_count, 0),
    coalesce(r.pending_count, 0), coalesce(r.queued_count, 0), coalesce(r.sending_count, 0),
    coalesce(r.sent_count, 0), coalesce(r.delivered_count, 0), coalesce(r.failed_count, 0),
    coalesce(r.skipped_count, 0), coalesce(r.cancelled_count, 0),
    coalesce(a.attributed_booking_count, 0), coalesce(a.booked_revenue_cents, 0)
  from public.campaigns c
  left join lateral (
    select
      count(*)::bigint as recipient_total,
      count(*) filter (where eligibility_status = 'eligible')::bigint as eligible_count,
      count(*) filter (where eligibility_status = 'excluded')::bigint as excluded_count,
      count(*) filter (where status = 'pending')::bigint as pending_count,
      count(*) filter (where status = 'queued')::bigint as queued_count,
      count(*) filter (where status = 'sending')::bigint as sending_count,
      count(*) filter (where status = 'sent')::bigint as sent_count,
      count(*) filter (where status = 'delivered')::bigint as delivered_count,
      count(*) filter (where status = 'failed')::bigint as failed_count,
      count(*) filter (where status = 'skipped')::bigint as skipped_count,
      count(*) filter (where status = 'cancelled')::bigint as cancelled_count
    from public.campaign_recipients r
    where r.campaign_id = c.id and r.user_id = p_user_id
  ) r on true
  left join lateral (
    select
      count(*)::bigint as attributed_booking_count,
      coalesce(sum(round(coalesce(a.price, 0) * 100))::bigint, 0)::bigint as booked_revenue_cents
    from public.appointments a
    where a.campaign_id = c.id and a.user_id = p_user_id and a.status <> 'cancelled'
  ) a on true
  where c.user_id = p_user_id and c.id = any(p_campaign_ids);
end;
$$;

insert into public.outreach_schema_versions (component, version, applied_at)
values ('campaign_authoring', 'campaign_reporting_2026_07_18', now())
on conflict (component) do update set version = excluded.version, applied_at = excluded.applied_at;

revoke all on function public.get_campaign_reporting_summaries(uuid, uuid[]) from public;
grant execute on function public.get_campaign_reporting_summaries(uuid, uuid[]) to authenticated, service_role;

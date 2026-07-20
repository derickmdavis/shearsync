create or replace function public.get_insights_campaign_aggregate(
  p_user_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz
)
returns table (
  campaign_count bigint,
  active_campaign_count bigint,
  emails_sent bigint,
  appointments_booked bigint,
  attributed_revenue_minor bigint,
  top_campaign_id uuid,
  top_campaign_name text,
  top_campaign_status text,
  top_campaign_appointments_booked bigint,
  top_campaign_attributed_revenue_minor bigint
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
  with sent_by_campaign as (
    select r.campaign_id, count(*)::bigint as emails_sent
    from public.campaign_recipients r
    where r.user_id = p_user_id
      and r.sent_at >= p_start_at
      and r.sent_at < p_end_at
    group by r.campaign_id
  ), attributed_by_campaign as (
    select a.campaign_id,
      count(*)::bigint as appointments_booked,
      coalesce(sum(round(coalesce(a.price, 0) * 100))::bigint, 0)::bigint as attributed_revenue_minor
    from public.appointments a
    where a.user_id = p_user_id
      and a.campaign_id is not null
      and a.status <> 'cancelled'
      and a.campaign_attributed_at >= p_start_at
      and a.campaign_attributed_at < p_end_at
    group by a.campaign_id
  ), period_campaigns as (
    select campaign_id from sent_by_campaign
    union
    select campaign_id from attributed_by_campaign
  ), campaign_metrics as (
    select c.id, c.name, c.status,
      coalesce(sent.emails_sent, 0)::bigint as emails_sent,
      coalesce(attributed.appointments_booked, 0)::bigint as appointments_booked,
      coalesce(attributed.attributed_revenue_minor, 0)::bigint as attributed_revenue_minor
    from period_campaigns period_campaign
    join public.campaigns c on c.id = period_campaign.campaign_id and c.user_id = p_user_id
    left join sent_by_campaign sent on sent.campaign_id = c.id
    left join attributed_by_campaign attributed on attributed.campaign_id = c.id
  ), top_campaign as (
    select * from campaign_metrics
    order by attributed_revenue_minor desc, appointments_booked desc, emails_sent desc, id asc
    limit 1
  )
  select
    (select count(*)::bigint from campaign_metrics),
    (select count(*)::bigint from public.campaigns where user_id = p_user_id and status in ('scheduled', 'sending')),
    coalesce((select sum(emails_sent)::bigint from campaign_metrics), 0)::bigint,
    coalesce((select sum(appointments_booked)::bigint from campaign_metrics), 0)::bigint,
    coalesce((select sum(attributed_revenue_minor)::bigint from campaign_metrics), 0)::bigint,
    (select id from top_campaign),
    (select name from top_campaign),
    (select status from top_campaign),
    coalesce((select appointments_booked from top_campaign), 0)::bigint,
    coalesce((select attributed_revenue_minor from top_campaign), 0)::bigint;
end;
$$;

revoke all on function public.get_insights_campaign_aggregate(uuid, timestamptz, timestamptz) from public;
grant execute on function public.get_insights_campaign_aggregate(uuid, timestamptz, timestamptz) to authenticated, service_role;

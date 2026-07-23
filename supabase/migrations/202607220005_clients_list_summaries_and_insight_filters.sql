create index if not exists appointments_user_client_date_idx
  on public.appointments(user_id, client_id, appointment_date);

create or replace function public.list_clients_with_summaries(
  p_user_id uuid,
  p_search text default null,
  p_page integer default 1,
  p_page_size integer default 25,
  p_sort text default 'updated_at',
  p_direction text default 'desc',
  p_filter text default 'all'
)
returns table (client jsonb, total_count bigint, insights jsonb)
language sql
security definer
set search_path = public
as $$
  with account as (
    select coalesce(u.timezone, 'America/Denver') as timezone,
      coalesce(settings.default_rebook_interval_days, 90) as default_rebook_interval_days
    from public.users u
    left join public.rebook_nudge_settings settings on settings.user_id = u.id
    where u.id = p_user_id
  ), base_clients as (
    select c.*
    from public.clients c
    where c.user_id = p_user_id
      and c.deleted_at is null
      and (
        nullif(btrim(p_search), '') is null
        or c.first_name ilike '%' || btrim(p_search) || '%'
        or c.last_name ilike '%' || btrim(p_search) || '%'
        or c.preferred_name ilike '%' || btrim(p_search) || '%'
        or c.email ilike '%' || btrim(p_search) || '%'
        or c.phone ilike '%' || btrim(p_search) || '%'
        or c.phone_normalized ilike '%' || btrim(p_search) || '%'
        or c.instagram ilike '%' || btrim(p_search) || '%'
        or c.notes ilike '%' || btrim(p_search) || '%'
        or btrim(p_search) = any(coalesce(c.tags, array[]::text[]))
      )
  ), completed_appointments as (
    select a.client_id, a.appointment_date, a.price, a.service_name,
      lag(a.appointment_date) over (partition by a.client_id order by a.appointment_date) as previous_appointment_date
    from public.appointments a
    join base_clients c on c.id = a.client_id
    where a.user_id = p_user_id
      and a.status = 'completed'
      and a.appointment_date <= now()
  ), completed_summaries as (
    select client_id,
      count(*)::integer as completed_visit_count,
      min(appointment_date) as first_completed_visit_at,
      max(appointment_date) as last_completed_visit_at,
      coalesce(sum(price), 0)::numeric(10, 2) as completed_total_spend,
      (array_agg(service_name order by appointment_date desc))[1] as last_service,
      round(avg(extract(epoch from appointment_date - previous_appointment_date) / 86400.0))::integer as average_completed_interval_days
    from completed_appointments
    group by client_id
  ), upcoming_summaries as (
    select a.client_id, min(a.appointment_date) as next_appointment_at
    from public.appointments a
    join base_clients c on c.id = a.client_id
    where a.user_id = p_user_id
      and a.status <> 'cancelled'
      and a.appointment_date > now()
    group by a.client_id
  ), summarized as (
    select c.*, 
      coalesce(completed.completed_visit_count, 0) as completed_visit_count,
      completed.first_completed_visit_at,
      completed.last_completed_visit_at,
      coalesce(completed.completed_total_spend, c.total_spend, 0)::numeric(10, 2) as resolved_total_spend,
      completed.last_service,
      upcoming.next_appointment_at,
      upcoming.next_appointment_at is not null as has_future_appointment,
      coalesce(preference.preferred_interval_days, completed.average_completed_interval_days, account.default_rebook_interval_days) as rebook_interval_days,
      account.timezone
    from base_clients c
    cross join account
    left join completed_summaries completed on completed.client_id = c.id
    left join upcoming_summaries upcoming on upcoming.client_id = c.id
    left join public.client_rebooking_preferences preference
      on preference.user_id = c.user_id and preference.client_id = c.id
  ), classified as (
    select summarized.*,
      completed_visit_count > 0
        and not has_future_appointment
        and (last_completed_visit_at at time zone timezone)::date + rebook_interval_days <= (now() at time zone timezone)::date
        as needs_rebook,
      first_completed_visit_at >= date_trunc('year', now() at time zone timezone) at time zone timezone
        and first_completed_visit_at < (date_trunc('year', now() at time zone timezone) + interval '1 year') at time zone timezone
        as is_first_time,
      row_number() over (order by resolved_total_spend desc, id asc) <= ceil(count(*) over () * 0.10) as is_top_spender
    from summarized
  ), insights_summary as (
    select jsonb_build_object(
      'overdue', jsonb_build_object(
        'count', count(*) filter (where needs_rebook),
        'supportingText', 'Rebooking due'
      ),
      'firstTime', jsonb_build_object(
        'count', count(*) filter (where is_first_time),
        'supportingText', 'This year'
      ),
      'topSpenders', jsonb_build_object(
        'count', count(*) filter (where is_top_spender),
        'supportingText', '$' || to_char(coalesce(min(resolved_total_spend) filter (where is_top_spender), 0), 'FM999G999G999G990D00') || '+ lifetime',
        'thresholdAmount', coalesce(min(resolved_total_spend) filter (where is_top_spender), 0),
        'period', 'lifetime',
        'percentile', 10
      )
    ) as insights
    from classified
  ), filtered as (
    select *, count(*) over () as filtered_total_count
    from classified
    where p_filter in ('all', 'active')
      or (p_filter = 'vip' and is_vip)
      or (p_filter = 'overdue' and needs_rebook)
      or (p_filter = 'first_time' and is_first_time)
      or (p_filter = 'top_spenders' and is_top_spender)
  )
  select
    to_jsonb(filtered) - array['timezone', 'rebook_interval_days', 'resolved_total_spend', 'is_first_time', 'is_top_spender', 'filtered_total_count']
      || jsonb_build_object(
        'total_spend', resolved_total_spend,
        'completed_visit_count', completed_visit_count,
        'first_completed_visit_at', first_completed_visit_at,
        'last_completed_visit_at', last_completed_visit_at,
        'has_future_appointment', has_future_appointment,
        'next_appointment_at', next_appointment_at,
        'needs_rebook', needs_rebook,
        'last_service', last_service
      ),
    filtered_total_count,
    insights_summary.insights
  from filtered
  cross join insights_summary
  order by
    case when p_sort = 'name' and p_direction = 'asc' then last_name end asc nulls last,
    case when p_sort = 'name' and p_direction = 'asc' then first_name end asc nulls last,
    case when p_sort = 'name' and p_direction = 'desc' then last_name end desc nulls last,
    case when p_sort = 'name' and p_direction = 'desc' then first_name end desc nulls last,
    case when p_sort in ('spend', 'total_spend') and p_direction = 'asc' then resolved_total_spend end asc nulls last,
    case when p_sort in ('spend', 'total_spend') and p_direction = 'desc' then resolved_total_spend end desc nulls last,
    case when p_sort in ('last_visit', 'last_visit_at') and p_direction = 'asc' then last_completed_visit_at end asc nulls last,
    case when p_sort in ('last_visit', 'last_visit_at') and p_direction = 'desc' then last_completed_visit_at end desc nulls last,
    case when p_sort in ('updated', 'updated_at') and p_direction = 'asc' then updated_at end asc,
    case when p_sort in ('updated', 'updated_at') and p_direction = 'desc' then updated_at end desc,
    id asc
  limit greatest(1, least(p_page_size, 100))
  offset greatest(0, p_page - 1) * greatest(1, least(p_page_size, 100));
$$;

revoke all on function public.list_clients_with_summaries(uuid, text, integer, integer, text, text, text) from public;
grant execute on function public.list_clients_with_summaries(uuid, text, integer, integer, text, text, text) to service_role;

create or replace function public.claim_campaign_recipients(p_limit integer, p_stale_before timestamptz, p_max_attempts integer default 3)
returns setof public.campaign_recipients language plpgsql security definer set search_path = public as $$
begin
  return query
  with candidates as (
    select r.id
    from public.campaign_recipients r
    join public.campaigns c on c.id = r.campaign_id and c.user_id = r.user_id
    join public.campaign_runs run on run.id = r.campaign_run_id and run.campaign_id = r.campaign_id
    where c.status in ('scheduled', 'sending') and run.status in ('scheduled', 'sending')
      and (run.scheduled_for is null or run.scheduled_for <= now())
      and (r.status = 'queued' or (r.status = 'failed' and r.attempt_count < greatest(1, least(p_max_attempts, 10))) or (r.status = 'sending' and r.sending_started_at < p_stale_before))
    order by coalesce(r.queued_at, r.created_at), r.id
    limit greatest(1, least(p_limit, 100)) for update of r, c, run skip locked
  ), claimed as (
    update public.campaign_recipients r set status = 'sending', attempt_count = attempt_count + 1,
      last_attempt_at = now(), sending_started_at = now(), error_code = null, error_message = null
    from candidates where r.id = candidates.id returning r.*
  ), runs as (
    update public.campaign_runs run set status = 'sending', started_at = coalesce(started_at, now())
    where run.id in (select campaign_run_id from claimed) and run.status = 'scheduled'
  ), campaigns as (
    update public.campaigns c set status = 'sending', sending_started_at = coalesce(sending_started_at, now())
    where c.id in (select campaign_id from claimed) and c.status = 'scheduled'
  ) select * from claimed;
end;
$$;

create or replace function public.validate_campaign_recipient_status_transition()
returns trigger language plpgsql as $$
begin
  if new.status = old.status then return new; end if;
  if not (
    (old.status = 'pending' and new.status in ('queued', 'skipped', 'cancelled'))
    or (old.status = 'queued' and new.status in ('sending', 'skipped', 'cancelled'))
    or (old.status = 'sending' and new.status in ('sent', 'failed', 'skipped'))
    or (old.status = 'sent' and new.status in ('delivered', 'failed'))
    or (old.status = 'failed' and new.status in ('queued', 'sending', 'skipped', 'cancelled'))
  ) then
    raise exception using errcode = '23514', message = 'invalid_campaign_recipient_status_transition';
  end if;
  return new;
end;
$$;

create or replace function public.finalize_campaign_runs(p_run_ids uuid[], p_max_attempts integer default 3)
returns void language plpgsql security definer set search_path = public as $$
declare v_run record; v_pending integer; v_failed integer; v_sent integer; v_status text;
begin
  for v_run in select id, campaign_id, user_id from public.campaign_runs where id = any(p_run_ids) for update loop
    select count(*) filter (where status in ('pending','queued','sending') or (status = 'failed' and attempt_count < greatest(1, least(p_max_attempts, 10)))), count(*) filter (where status = 'failed'), count(*) filter (where status in ('sent','delivered')) into v_pending, v_failed, v_sent from public.campaign_recipients where campaign_run_id = v_run.id;
    if v_pending > 0 then continue; end if;
    v_status := case when v_sent = 0 and v_failed > 0 then 'failed' when v_failed > 0 then 'partially_failed' else 'completed' end;
    update public.campaign_runs set status = v_status, completed_at = now(), pending_count = 0, sending_count = 0, sent_count = v_sent, failed_count = v_failed where id = v_run.id;
    update public.campaigns
    set status = v_status,
        completed_at = now(),
        failure_summary = jsonb_build_object('sent_count', v_sent, 'failed_count', v_failed)
    where id = v_run.campaign_id and user_id = v_run.user_id;
  end loop;
end;
$$;
insert into public.outreach_schema_versions (component, version, applied_at) values ('campaign_authoring', 'campaign_delivery_worker_2026_07_18', now()) on conflict (component) do update set version = excluded.version, applied_at = excluded.applied_at;
grant execute on function public.claim_campaign_recipients(integer, timestamptz, integer) to service_role;
grant execute on function public.finalize_campaign_runs(uuid[], integer) to service_role;

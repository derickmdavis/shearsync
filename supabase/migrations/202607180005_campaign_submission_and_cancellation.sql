-- Campaign submission is intentionally database-atomic: the initial run and
-- every recipient snapshot are committed together, or not at all.

create or replace function public.sync_initial_campaign_run()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.campaign_runs
  set
    status = new.status,
    scheduled_for = case
      when new.send_mode = 'now' and new.status = 'scheduled'
        then coalesce(campaign_runs.scheduled_for, new.scheduled_at, now())
      else new.scheduled_for
    end,
    started_at = case when new.status = 'sending' then new.sending_started_at else started_at end,
    completed_at = case when new.status in ('completed', 'partially_failed', 'failed') then new.completed_at else completed_at end,
    cancelled_at = case when new.status = 'cancelled' then new.cancelled_at else cancelled_at end
  where campaign_id = new.id and user_id = new.user_id and sequence_number = 1;
  return new;
end;
$$;

create or replace function public.submit_campaign(
  p_user_id uuid,
  p_campaign_id uuid,
  p_expected_revision integer,
  p_expected_send_mode text,
  p_validation_nonce_hash text,
  p_idempotency_key text,
  p_request_hash text,
  p_recipients jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.campaigns%rowtype;
  v_run public.campaign_runs%rowtype;
  v_idempotency public.campaign_idempotency_records%rowtype;
  v_response jsonb;
  v_recipient_total integer;
  v_eligible_count integer;
  v_excluded_count integer;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception using errcode = '42501', message = 'campaign_owner_mismatch';
  end if;

  if p_expected_send_mode not in ('now', 'scheduled') then
    raise exception using errcode = '22023', message = 'invalid_campaign_send_mode';
  end if;
  if p_idempotency_key is null or char_length(trim(p_idempotency_key)) = 0 then
    raise exception using errcode = '22023', message = 'campaign_idempotency_key_required';
  end if;

  select * into v_idempotency
  from public.campaign_idempotency_records
  where user_id = p_user_id and scope = 'campaign_submit' and idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_idempotency.request_hash <> p_request_hash then
      raise exception using errcode = 'P0001', message = 'campaign_idempotency_key_reused';
    end if;
    if v_idempotency.completed_at is not null then
      return v_idempotency.response_body;
    end if;
    raise exception using errcode = 'P0001', message = 'campaign_idempotency_in_progress';
  end if;

  insert into public.campaign_idempotency_records (
    user_id, scope, idempotency_key, request_hash, locked_at, expires_at
  ) values (
    p_user_id, 'campaign_submit', p_idempotency_key, p_request_hash, now(), now() + interval '24 hours'
  );

  select * into v_campaign
  from public.campaigns
  where id = p_campaign_id and user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'campaign_draft_not_found';
  end if;
  if v_campaign.status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'campaign_not_draft';
  end if;
  if v_campaign.revision <> p_expected_revision then
    raise exception using errcode = 'P0001', message = 'campaign_revision_conflict',
      detail = json_build_object('current_revision', v_campaign.revision)::text;
  end if;
  if v_campaign.send_mode <> p_expected_send_mode then
    raise exception using errcode = 'P0001', message = 'campaign_send_mode_mismatch';
  end if;
  if v_campaign.validation_nonce_hash is null or v_campaign.validation_nonce_hash <> p_validation_nonce_hash then
    raise exception using errcode = 'P0001', message = 'campaign_validation_invalid';
  end if;
  if v_campaign.name is null or v_campaign.link_type is null
    or v_campaign.subject_snapshot is null or v_campaign.message_snapshot is null
    or (v_campaign.send_mode = 'scheduled' and v_campaign.scheduled_for is null) then
    raise exception using errcode = 'P0001', message = 'campaign_submission_incomplete';
  end if;

  if jsonb_typeof(p_recipients) <> 'array' or jsonb_array_length(p_recipients) = 0 then
    raise exception using errcode = 'P0001', message = 'campaign_has_no_eligible_recipients';
  end if;

  select count(*),
    count(*) filter (where coalesce(value->>'eligibility_status', '') = 'eligible'),
    count(*) filter (where coalesce(value->>'eligibility_status', '') = 'excluded')
  into v_recipient_total, v_eligible_count, v_excluded_count
  from jsonb_array_elements(p_recipients);

  if v_eligible_count = 0 then
    raise exception using errcode = 'P0001', message = 'campaign_has_no_eligible_recipients';
  end if;

  update public.campaigns
  set status = 'scheduled',
      scheduled_at = now(),
      validation_nonce_hash = null
  where id = v_campaign.id and user_id = p_user_id
  returning * into v_campaign;

  select * into v_run
  from public.campaign_runs
  where campaign_id = v_campaign.id and user_id = p_user_id and sequence_number = 1
  for update;

  insert into public.campaign_recipients (
    campaign_id, campaign_run_id, user_id, client_id, recipient_email_snapshot, first_name_snapshot,
    eligibility_status, exclusion_reason, subject_snapshot, rendered_text_snapshot, rendered_html_snapshot,
    render_version, booking_tracking_token_hash, referral_link_id, status, idempotency_key, queued_at, skipped_at
  )
  select
    v_campaign.id,
    v_run.id,
    p_user_id,
    nullif(value->>'client_id', '')::uuid,
    nullif(value->>'recipient_email_snapshot', ''),
    nullif(value->>'first_name_snapshot', ''),
    value->>'eligibility_status',
    nullif(value->>'exclusion_reason', ''),
    nullif(value->>'subject_snapshot', ''),
    nullif(value->>'rendered_text_snapshot', ''),
    nullif(value->>'rendered_html_snapshot', ''),
    coalesce((value->>'render_version')::integer, 1),
    null,
    null,
    case when value->>'eligibility_status' = 'eligible' then 'queued' else 'skipped' end,
    value->>'idempotency_key',
    case when value->>'eligibility_status' = 'eligible' then now() else null end,
    case when value->>'eligibility_status' = 'excluded' then now() else null end
  from jsonb_array_elements(p_recipients);

  update public.campaign_runs
  set status = 'scheduled',
      scheduled_for = case
        when v_campaign.send_mode = 'now' then coalesce(scheduled_for, v_campaign.scheduled_at, now())
        else v_campaign.scheduled_for
      end,
      recipient_total = v_recipient_total,
      eligible_count = v_eligible_count,
      excluded_count = v_excluded_count,
      pending_count = 0,
      sending_count = 0,
      sent_count = 0,
      failed_count = 0
  where id = v_run.id and campaign_id = v_campaign.id and user_id = p_user_id
  returning * into v_run;

  v_response = jsonb_build_object(
    'campaign_id', v_campaign.id,
    'run_id', v_run.id,
    'status', v_campaign.status,
    'send_mode', v_campaign.send_mode,
    'scheduled_for', coalesce(v_campaign.scheduled_for, v_run.scheduled_for),
    'recipient_total', v_recipient_total,
    'eligible_count', v_eligible_count,
    'excluded_count', v_excluded_count
  );

  update public.campaign_idempotency_records
  set response_status = 200,
      response_body = v_response,
      resource_type = 'campaign_run',
      resource_id = v_run.id,
      completed_at = now()
  where user_id = p_user_id and scope = 'campaign_submit' and idempotency_key = p_idempotency_key;

  return v_response;
end;
$$;

create or replace function public.cancel_campaign_submission(
  p_user_id uuid,
  p_campaign_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.campaigns%rowtype;
  v_cancelled_recipients integer;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception using errcode = '42501', message = 'campaign_owner_mismatch';
  end if;

  select * into v_campaign
  from public.campaigns
  where id = p_campaign_id and user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'campaign_not_found';
  end if;
  if v_campaign.status = 'cancelled' then
    return jsonb_build_object('campaign_id', v_campaign.id, 'status', 'cancelled', 'cancelled_recipients', 0);
  end if;
  if v_campaign.status = 'sending' then
    raise exception using errcode = 'P0001', message = 'campaign_already_sending';
  end if;
  if v_campaign.status <> 'scheduled' then
    raise exception using errcode = 'P0001', message = 'campaign_not_cancellable';
  end if;

  update public.campaigns
  set status = 'cancelled', cancelled_at = now(), cancelled_reason = nullif(left(trim(coalesce(p_reason, '')), 1000), '')
  where id = v_campaign.id and user_id = p_user_id;

  update public.campaign_recipients
  set status = 'cancelled', cancelled_at = now()
  where campaign_id = v_campaign.id and user_id = p_user_id and status in ('pending', 'queued');
  get diagnostics v_cancelled_recipients = row_count;

  return jsonb_build_object(
    'campaign_id', v_campaign.id,
    'status', 'cancelled',
    'cancelled_recipients', v_cancelled_recipients
  );
end;
$$;

insert into public.outreach_schema_versions (component, version, applied_at)
values ('campaign_authoring', 'campaign_submission_2026_07_18', now())
on conflict (component) do update
set version = excluded.version,
    applied_at = excluded.applied_at;

revoke all on function public.submit_campaign(uuid, uuid, integer, text, text, text, text, jsonb) from public;
revoke all on function public.cancel_campaign_submission(uuid, uuid, text) from public;
grant execute on function public.submit_campaign(uuid, uuid, integer, text, text, text, text, jsonb) to authenticated, service_role;
grant execute on function public.cancel_campaign_submission(uuid, uuid, text) to authenticated, service_role;

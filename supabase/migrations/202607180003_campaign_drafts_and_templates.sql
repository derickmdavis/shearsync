insert into public.campaign_templates (
  id, name, description, link_type, subject, message, version, active, sort_order, icon_key
)
values
  (
    '10000000-0000-4000-8000-000000000001',
    'Booking Boost',
    'Invite clients to book their next appointment.',
    'booking_link',
    'Ready for your next appointment?',
    E'Hi {{first_name}},\n\nI would love to see you again. Choose a time that works for you below.',
    1, true, 10, 'calendar'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    'Seasonal Special',
    'Share a timely service or seasonal promotion.',
    'booking_link',
    'A seasonal update, just for you',
    E'Hi {{first_name}},\n\nI have something special available for a limited time. Book your next visit below.',
    1, true, 20, 'sun'
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    'Share With a Friend',
    'Invite existing clients to share their personal referral link.',
    'referral_link',
    'Know someone who would love this?',
    E'Hi {{first_name}},\n\nIf someone comes to mind, you can share your personal referral link below.',
    1, true, 30, 'users'
  )
on conflict (id) do nothing;

create or replace function public.create_campaign_draft(
  p_user_id uuid,
  p_timezone text,
  p_template_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_template public.campaign_templates%rowtype;
  v_campaign public.campaigns%rowtype;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception using errcode = '42501', message = 'campaign_owner_mismatch';
  end if;

  if not exists (select 1 from public.users where id = p_user_id) then
    raise exception using errcode = 'P0002', message = 'campaign_owner_not_found';
  end if;

  if p_template_id is not null then
    select * into v_template
    from public.campaign_templates
    where id = p_template_id and active = true;

    if not found then
      raise exception using errcode = 'P0002', message = 'campaign_template_not_found';
    end if;
  end if;

  insert into public.campaigns (
    user_id,
    status,
    campaign_kind,
    send_mode,
    timezone_snapshot,
    link_type,
    template_id,
    template_version,
    subject_snapshot,
    message_snapshot,
    audience_mode
  ) values (
    p_user_id,
    'draft',
    'one_time',
    'now',
    p_timezone,
    v_template.link_type,
    v_template.id,
    v_template.version,
    v_template.subject,
    v_template.message,
    'everyone'
  )
  returning * into v_campaign;

  return to_jsonb(v_campaign);
end;
$$;

create or replace function public.update_campaign_draft(
  p_user_id uuid,
  p_campaign_id uuid,
  p_expected_revision integer,
  p_has_name boolean default false,
  p_name text default null,
  p_has_send_mode boolean default false,
  p_send_mode text default null,
  p_has_scheduled_for boolean default false,
  p_scheduled_for timestamptz default null,
  p_has_timezone boolean default false,
  p_timezone text default null,
  p_has_link_type boolean default false,
  p_link_type text default null,
  p_has_template boolean default false,
  p_template_id uuid default null,
  p_has_subject boolean default false,
  p_subject text default null,
  p_has_message boolean default false,
  p_message text default null,
  p_has_audience boolean default false,
  p_audience_mode text default null,
  p_client_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.campaigns%rowtype;
  v_template public.campaign_templates%rowtype;
  v_client_ids uuid[];
  v_owned_count integer;
  v_effective_send_mode text;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception using errcode = '42501', message = 'campaign_owner_mismatch';
  end if;

  select * into v_campaign
  from public.campaigns
  where id = p_campaign_id and user_id = p_user_id
  for update;

  if not found or v_campaign.status <> 'draft' then
    raise exception using errcode = 'P0002', message = 'campaign_draft_not_found';
  end if;

  if v_campaign.revision <> p_expected_revision then
    raise exception using
      errcode = 'P0001',
      message = 'campaign_revision_conflict',
      detail = jsonb_build_object('current_revision', v_campaign.revision)::text;
  end if;

  if p_has_template and p_template_id is not null then
    select * into v_template
    from public.campaign_templates
    where id = p_template_id and active = true;

    if not found then
      raise exception using errcode = 'P0002', message = 'campaign_template_not_found';
    end if;
  end if;

  v_effective_send_mode = case when p_has_send_mode then p_send_mode else v_campaign.send_mode end;
  if v_effective_send_mode = 'now' and p_has_scheduled_for and p_scheduled_for is not null then
    raise exception using errcode = '23514', message = 'campaign_send_time_not_allowed';
  end if;

  if p_has_audience then
    v_client_ids = coalesce(p_client_ids, array[]::uuid[]);

    if p_audience_mode not in ('everyone', 'specific') then
      raise exception using errcode = '23514', message = 'campaign_audience_mode_invalid';
    end if;
    if p_audience_mode = 'everyone' and cardinality(v_client_ids) > 0 then
      raise exception using errcode = '23514', message = 'campaign_everyone_client_ids_not_allowed';
    end if;
    if cardinality(v_client_ids) <> cardinality(array(select distinct unnest(v_client_ids))) then
      raise exception using errcode = '23505', message = 'campaign_audience_duplicate_client';
    end if;

    select count(*) into v_owned_count
    from public.clients
    where user_id = p_user_id and id = any(v_client_ids);

    if v_owned_count <> cardinality(v_client_ids) then
      raise exception using errcode = '42501', message = 'campaign_audience_client_not_owned';
    end if;
  end if;

  update public.campaigns
  set
    name = case when p_has_name then nullif(trim(p_name), '') else name end,
    send_mode = case when p_has_send_mode then p_send_mode else send_mode end,
    scheduled_for = case
      when p_has_send_mode and p_send_mode = 'now' then null
      when p_has_scheduled_for then p_scheduled_for
      else scheduled_for
    end,
    timezone_snapshot = case when p_has_timezone then p_timezone else timezone_snapshot end,
    link_type = case
      when p_has_link_type then p_link_type
      when p_has_template and p_template_id is not null then v_template.link_type
      else link_type
    end,
    template_id = case when p_has_template then p_template_id else template_id end,
    template_version = case
      when p_has_template and p_template_id is not null then v_template.version
      when p_has_template then null
      else template_version
    end,
    subject_snapshot = case
      when p_has_subject then nullif(trim(p_subject), '')
      when p_has_template and p_template_id is not null then v_template.subject
      else subject_snapshot
    end,
    message_snapshot = case
      when p_has_message then nullif(trim(p_message), '')
      when p_has_template and p_template_id is not null then v_template.message
      else message_snapshot
    end,
    audience_mode = case when p_has_audience then p_audience_mode else audience_mode end,
    revision = revision + 1,
    validated_at = null,
    validation_nonce_hash = null
  where id = p_campaign_id and user_id = p_user_id
  returning * into v_campaign;

  if p_has_audience then
    delete from public.campaign_audience_selections
    where campaign_id = p_campaign_id and user_id = p_user_id;

    if p_audience_mode = 'specific' then
      insert into public.campaign_audience_selections (campaign_id, user_id, client_id)
      select p_campaign_id, p_user_id, client_id
      from unnest(v_client_ids) as client_id;
    end if;
  end if;

  return to_jsonb(v_campaign);
end;
$$;

revoke all on function public.create_campaign_draft(uuid, text, uuid) from public;
revoke all on function public.update_campaign_draft(
  uuid, uuid, integer, boolean, text, boolean, text, boolean, timestamptz,
  boolean, text, boolean, text, boolean, uuid, boolean, text, boolean, text,
  boolean, text, uuid[]
) from public;
grant execute on function public.create_campaign_draft(uuid, text, uuid) to authenticated, service_role;
grant execute on function public.update_campaign_draft(
  uuid, uuid, integer, boolean, text, boolean, text, boolean, timestamptz,
  boolean, text, boolean, text, boolean, uuid, boolean, text, boolean, text,
  boolean, text, uuid[]
) to authenticated, service_role;

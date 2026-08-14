create or replace function public.upsert_sms_template_settings(
  p_user_id uuid,
  p_template_type text,
  p_has_enabled boolean,
  p_enabled boolean,
  p_has_custom_body boolean,
  p_custom_body text
)
returns public.sms_template_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  saved public.sms_template_settings;
begin
  insert into public.sms_template_settings (user_id, template_type, enabled, custom_body)
  values (
    p_user_id,
    p_template_type,
    case when p_has_enabled then p_enabled else true end,
    case when p_has_custom_body then p_custom_body else null end
  )
  on conflict (user_id, template_type) do update
  set
    enabled = case when p_has_enabled then p_enabled else sms_template_settings.enabled end,
    custom_body = case when p_has_custom_body then p_custom_body else sms_template_settings.custom_body end
  returning * into saved;

  return saved;
end;
$$;

revoke all on function public.upsert_sms_template_settings(uuid, text, boolean, boolean, boolean, text) from public;
grant execute on function public.upsert_sms_template_settings(uuid, text, boolean, boolean, boolean, text) to service_role;

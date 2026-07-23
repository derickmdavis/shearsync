-- Repair and make explicit the execution boundary for app-content write RPCs.
-- Safe to apply after migration 003 on databases where default function grants
-- or an earlier partial deployment left `authenticated` execution in place.

revoke all on function public.publish_app_content_locale(text, bigint, uuid, text) from public;
revoke all on function public.publish_app_content_locale(text, bigint, uuid, text) from anon;
revoke all on function public.publish_app_content_locale(text, bigint, uuid, text) from authenticated;

revoke all on function public.rollback_app_content_locale(text, uuid, bigint, uuid, text) from public;
revoke all on function public.rollback_app_content_locale(text, uuid, bigint, uuid, text) from anon;
revoke all on function public.rollback_app_content_locale(text, uuid, bigint, uuid, text) from authenticated;

grant execute on function public.publish_app_content_locale(text, bigint, uuid, text) to service_role;
grant execute on function public.rollback_app_content_locale(text, uuid, bigint, uuid, text) to service_role;

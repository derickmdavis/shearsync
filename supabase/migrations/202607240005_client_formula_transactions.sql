-- Formula and section writes are atomic: a formula can never be persisted without its required sections.
create or replace function public.create_client_formula(
  p_user_id uuid, p_client_id uuid, p_formula jsonb, p_sections jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_formula public.client_formulas%rowtype;
begin
  if not exists (select 1 from public.clients where id = p_client_id and user_id = p_user_id and deleted_at is null) then raise exception 'client_not_found'; end if;
  if jsonb_typeof(p_sections) <> 'array' or jsonb_array_length(p_sections) = 0 then raise exception 'formula_sections_required'; end if;
  if p_formula ? 'appointment_id' and nullif(p_formula->>'appointment_id', '') is not null and not exists (select 1 from public.appointments where id = (p_formula->>'appointment_id')::uuid and user_id = p_user_id and client_id = p_client_id) then raise exception 'appointment_not_found_for_client'; end if;
  if p_formula ? 'service_id' and nullif(p_formula->>'service_id', '') is not null and not exists (select 1 from public.services where id = (p_formula->>'service_id')::uuid and user_id = p_user_id) then raise exception 'service_not_found'; end if;
  insert into public.client_formulas (user_id, client_id, appointment_id, service_id, title, formula_date, service_name_snapshot, processing_notes, result_notes, created_by)
  values (p_user_id, p_client_id, nullif(p_formula->>'appointment_id', '')::uuid, nullif(p_formula->>'service_id', '')::uuid, p_formula->>'title', (p_formula->>'formula_date')::date, p_formula->>'service_name_snapshot', p_formula->>'processing_notes', p_formula->>'result_notes', p_user_id)
  returning * into v_formula;
  insert into public.client_formula_sections (formula_id, type, custom_label, content, sort_order)
  select v_formula.id, s.type, s.custom_label, s.content, s.sort_order from jsonb_to_recordset(p_sections) as s(type text, custom_label text, content text, sort_order integer);
  return to_jsonb(v_formula);
end; $$;

create or replace function public.update_client_formula(
  p_user_id uuid, p_client_id uuid, p_formula_id uuid, p_updates jsonb, p_sections jsonb default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_formula public.client_formulas%rowtype;
begin
  select * into v_formula from public.client_formulas where id = p_formula_id and user_id = p_user_id and client_id = p_client_id and deleted_at is null for update;
  if not found then raise exception 'formula_not_found'; end if;
  if p_sections is not null and (jsonb_typeof(p_sections) <> 'array' or jsonb_array_length(p_sections) = 0) then raise exception 'formula_sections_required'; end if;
  if p_updates ? 'appointment_id' and nullif(p_updates->>'appointment_id', '') is not null and not exists (select 1 from public.appointments where id = (p_updates->>'appointment_id')::uuid and user_id = p_user_id and client_id = p_client_id) then raise exception 'appointment_not_found_for_client'; end if;
  if p_updates ? 'service_id' and nullif(p_updates->>'service_id', '') is not null and not exists (select 1 from public.services where id = (p_updates->>'service_id')::uuid and user_id = p_user_id) then raise exception 'service_not_found'; end if;
  update public.client_formulas set
    appointment_id = case when p_updates ? 'appointment_id' then nullif(p_updates->>'appointment_id', '')::uuid else appointment_id end,
    service_id = case when p_updates ? 'service_id' then nullif(p_updates->>'service_id', '')::uuid else service_id end,
    title = case when p_updates ? 'title' then p_updates->>'title' else title end,
    formula_date = case when p_updates ? 'formula_date' then (p_updates->>'formula_date')::date else formula_date end,
    service_name_snapshot = case when p_updates ? 'service_name_snapshot' then p_updates->>'service_name_snapshot' else service_name_snapshot end,
    processing_notes = case when p_updates ? 'processing_notes' then p_updates->>'processing_notes' else processing_notes end,
    result_notes = case when p_updates ? 'result_notes' then p_updates->>'result_notes' else result_notes end,
    updated_at = now()
  where id = p_formula_id returning * into v_formula;
  if p_sections is not null then
    delete from public.client_formula_sections where formula_id = p_formula_id;
    insert into public.client_formula_sections (formula_id, type, custom_label, content, sort_order)
    select p_formula_id, s.type, s.custom_label, s.content, s.sort_order from jsonb_to_recordset(p_sections) as s(type text, custom_label text, content text, sort_order integer);
  end if;
  return to_jsonb(v_formula);
end; $$;

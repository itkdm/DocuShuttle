-- Flow C: an example-only task is still editable. The first example seeds the
-- Working Document; once a template exists, examples remain reference-only.
create or replace function public.register_source_and_import(
  p_task_id uuid,
  p_role text,
  p_original_name text,
  p_object_key text,
  p_mime_type text,
  p_byte_length bigint,
  p_sha256 text,
  p_inspection jsonb,
  p_manifest_object_key text,
  p_engine_version text
)
returns table(source_file_id uuid, working_document_id uuid, version_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_source uuid;
  v_working uuid;
  v_version uuid;
  v_parent uuid;
  v_number bigint;
  v_has_template boolean;
begin
  if v_owner is null or not exists (
    select 1 from public.tasks t where t.id = p_task_id and t.owner_user_id = v_owner
  ) then
    raise exception 'TASK_NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_role not in ('template', 'example', 'auxiliary') then
    raise exception 'INVALID_SOURCE_ROLE' using errcode = '22023';
  end if;

  insert into public.source_files (
    owner_user_id, task_id, role, original_name, object_key, mime_type,
    byte_length, sha256, inspection, manifest_object_key
  ) values (
    v_owner, p_task_id, p_role, p_original_name, p_object_key, p_mime_type,
    p_byte_length, p_sha256, p_inspection, p_manifest_object_key
  ) returning id into v_source;

  select exists (
    select 1 from public.source_files sf
    where sf.task_id = p_task_id and sf.owner_user_id = v_owner and sf.role = 'template'
  ) into v_has_template;

  if p_role = 'template' or (p_role = 'example' and not v_has_template) then
    insert into public.working_documents (owner_user_id, task_id)
      values (v_owner, p_task_id)
      on conflict (task_id) do nothing;

    select wd.id, wd.current_version_id into v_working, v_parent
      from public.working_documents wd
      where wd.task_id = p_task_id and wd.owner_user_id = v_owner
      for update;

    -- A second example must not replace the first example-derived document.
    if p_role = 'template' or v_parent is null then
      select coalesce(max(version_number), -1) + 1 into v_number
        from public.document_versions
        where working_document_id = v_working and owner_user_id = v_owner;

      insert into public.document_versions (
        owner_user_id, working_document_id, parent_version_id, version_number,
        origin, object_key, manifest_object_key, sha256, engine_version, validation
      ) values (
        v_owner, v_working, v_parent, v_number, 'import', p_object_key,
        p_manifest_object_key, p_sha256, p_engine_version,
        jsonb_build_object('status', 'inspected', 'inspection', p_inspection)
      ) returning id into v_version;

      update public.working_documents
        set current_version_id = v_version, revision = revision + 1, updated_at = now()
        where id = v_working and owner_user_id = v_owner;
    end if;
  end if;

  return query select v_source, v_working, v_version;
end;
$$;

revoke all on function public.register_source_and_import(uuid, text, text, text, text, bigint, text, jsonb, text, text) from public, anon;
grant execute on function public.register_source_and_import(uuid, text, text, text, text, bigint, text, jsonb, text, text) to authenticated;

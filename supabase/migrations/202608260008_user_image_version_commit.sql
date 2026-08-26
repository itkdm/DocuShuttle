create or replace function public.commit_user_document_version(
  p_document_id uuid,
  p_expected_revision text,
  p_derived_revision text,
  p_output_ref text,
  p_manifest_object_key text,
  p_validation jsonb,
  p_operation_log jsonb
) returns jsonb
language plpgsql security invoker set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_document public.working_documents%rowtype;
  v_current public.document_versions%rowtype;
  v_created public.document_versions%rowtype;
begin
  select * into v_document from public.working_documents where id = p_document_id and owner_user_id = v_owner for update;
  if not found then raise exception 'DOCUMENT_NOT_FOUND'; end if;
  select * into v_current from public.document_versions where id = v_document.current_version_id and owner_user_id = v_owner;
  if not found then raise exception 'DOCUMENT_VERSION_NOT_FOUND'; end if;
  if v_current.sha256 <> p_expected_revision then
    return jsonb_build_object('kind', 'revision-conflict', 'actual_revision', v_current.sha256);
  end if;
  insert into public.document_versions (owner_user_id, working_document_id, parent_version_id, version_number, origin, object_key, manifest_object_key, sha256, engine_version, validation, operation_log)
  values (v_owner, p_document_id, v_current.id, v_current.version_number + 1, 'user', p_output_ref, p_manifest_object_key, p_derived_revision, 'paperduck-ooxml-v1', coalesce(p_validation, '{}'::jsonb), coalesce(p_operation_log, '[]'::jsonb))
  returning * into v_created;
  update public.working_documents set current_version_id = v_created.id, updated_at = now() where id = p_document_id and owner_user_id = v_owner;
  return jsonb_build_object('version_id', v_created.id, 'version_number', v_created.version_number);
end;
$$;

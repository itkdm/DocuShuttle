-- Restored versions deliberately reuse immutable artifacts.  Artifact keys are not version IDs.
alter table public.document_versions drop constraint document_versions_object_key_key;
alter table public.document_versions drop constraint document_versions_manifest_object_key_key;
alter table public.exports drop constraint exports_object_key_key;

create or replace function public.restore_document_version(p_task_id uuid, p_source_version_id uuid)
returns table(version_id uuid, version_number bigint, revision text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_document public.working_documents%rowtype;
  v_current public.document_versions%rowtype;
  v_source public.document_versions%rowtype;
  v_created uuid;
begin
  select d.* into v_document from public.working_documents d
  join public.tasks t on t.id = d.task_id
  where d.task_id = p_task_id and d.owner_user_id = v_owner and t.owner_user_id = v_owner
  for update;
  if not found then raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0002'; end if;

  select * into v_current from public.document_versions
  where id = v_document.current_version_id and owner_user_id = v_owner;
  select * into v_source from public.document_versions
  where id = p_source_version_id and owner_user_id = v_owner and working_document_id = v_document.id;
  if not found then raise exception 'VERSION_NOT_FOUND' using errcode = 'P0002'; end if;

  insert into public.document_versions (
    owner_user_id, working_document_id, parent_version_id, version_number, origin,
    object_key, manifest_object_key, sha256, engine_version, validation, operation_log
  ) values (
    v_owner, v_document.id, v_current.id, v_current.version_number + 1, 'restore',
    v_source.object_key, v_source.manifest_object_key, v_source.sha256, v_source.engine_version,
    v_source.validation, jsonb_build_array(jsonb_build_object('kind', 'restore', 'fromVersionId', v_source.id))
  ) returning id into v_created;

  update public.working_documents set current_version_id = v_created, revision = v_document.revision + 1, updated_at = now()
  where id = v_document.id and owner_user_id = v_owner;

  return query select v_created, v_current.version_number + 1, v_source.sha256;
end;
$$;

create or replace function public.record_document_export(p_task_id uuid)
returns table(export_id uuid, version_id uuid, version_number bigint, revision text, object_key text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_version public.document_versions%rowtype;
  v_export uuid;
begin
  select v.* into v_version from public.working_documents d
  join public.document_versions v on v.id = d.current_version_id
  where d.task_id = p_task_id and d.owner_user_id = v_owner and v.owner_user_id = v_owner;
  if not found then raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.exports (owner_user_id, task_id, version_id, object_key, sha256)
  values (v_owner, p_task_id, v_version.id, v_version.object_key, v_version.sha256)
  returning id into v_export;
  return query select v_export, v_version.id, v_version.version_number, v_version.sha256, v_version.object_key;
end;
$$;

revoke all on function public.restore_document_version(uuid, uuid) from public, anon;
revoke all on function public.record_document_export(uuid) from public, anon;
grant execute on function public.restore_document_version(uuid, uuid) to authenticated;
grant execute on function public.record_document_export(uuid) to authenticated;

-- A cancellation wins the run lock before a document side effect can commit.
-- The loop can safely reconcile a receipt after cancellation without creating
-- a document version from a stale in-flight checkpoint.
create or replace function public.commit_loop_document_version(
  p_run_id uuid,
  p_expected_run_version bigint,
  p_document_id uuid,
  p_expected_revision text,
  p_derived_revision text,
  p_output_ref text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_run public.agent_runs%rowtype;
  v_document public.working_documents%rowtype;
  v_current public.document_versions%rowtype;
  v_existing public.document_versions%rowtype;
  v_created uuid;
  v_output jsonb := p_output_ref::jsonb;
  v_next_version bigint;
begin
  select * into v_run from public.agent_runs
  where id = p_run_id and owner_user_id = v_owner for update;
  if not found then raise exception 'RUN_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_run.status = 'cancelled' then
    return jsonb_build_object('kind', 'run-cancelled');
  end if;
  if v_run.lock_version <> p_expected_run_version then
    raise exception 'AGENT_RUN_CONFLICT' using errcode = '40001';
  end if;
  select * into v_document from public.working_documents
  where id = p_document_id and owner_user_id = v_owner for update;
  if not found then raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_current from public.document_versions
  where id = v_document.current_version_id and owner_user_id = v_owner;
  if not found or v_current.sha256 <> p_expected_revision then
    return jsonb_build_object('kind', 'revision-conflict', 'actualRevision', coalesce(v_current.sha256, ''));
  end if;
  select * into v_existing from public.document_versions
  where created_by_run_id = p_run_id
    and sha256 = p_derived_revision
    and operation_log @> jsonb_build_array(jsonb_build_object('idempotencyKey', p_idempotency_key));
  if found then return jsonb_build_object('kind', 'committed', 'versionRef', v_existing.id, 'revision', v_existing.sha256); end if;
  v_next_version := v_current.version_number + 1;
  insert into public.document_versions (
    owner_user_id, working_document_id, parent_version_id, version_number,
    origin, object_key, manifest_object_key, sha256, engine_version,
    created_by_run_id, operation_log
  ) values (
    v_owner, p_document_id, v_current.id, v_next_version,
    'agent', v_output->>'objectKey', v_output->>'manifestObjectKey',
    p_derived_revision, 'paperduck-ooxml-v1', p_run_id,
    coalesce(v_output->'operationLog', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('idempotencyKey', p_idempotency_key))
  ) returning id into v_created;
  update public.working_documents
  set current_version_id = v_created, revision = revision + 1, updated_at = now()
  where id = p_document_id and owner_user_id = v_owner and current_version_id = v_current.id;
  if not found then raise exception 'DOCUMENT_COMMIT_CONFLICT' using errcode = '40001'; end if;
  update public.agent_runs
  set lock_version = lock_version + 1,
      state = jsonb_set(state, '{version}', to_jsonb(lock_version + 1), true),
      updated_at = now()
  where id = p_run_id and owner_user_id = v_owner and lock_version = p_expected_run_version;
  if not found then raise exception 'AGENT_RUN_CONFLICT' using errcode = '40001'; end if;
  return jsonb_build_object('kind', 'committed', 'versionRef', v_created, 'revision', p_derived_revision);
end;
$$;

revoke all on function public.commit_loop_document_version(uuid, bigint, uuid, text, text, text, text) from public, anon;
grant execute on function public.commit_loop_document_version(uuid, bigint, uuid, text, text, text, text) to authenticated;

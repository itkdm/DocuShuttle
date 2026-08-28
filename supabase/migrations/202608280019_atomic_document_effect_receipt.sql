-- Make a document effect and its recovery receipt one durable transaction.
-- Existing migrations are intentionally left unchanged.

drop function if exists public.commit_loop_document_version(uuid, bigint, uuid, text, text, text, text);

create or replace function public.commit_loop_document_version(
  p_run_id uuid,
  p_expected_run_version bigint,
  p_document_id uuid,
  p_expected_revision text,
  p_derived_revision text,
  p_output_ref text,
  p_idempotency_key text,
  p_receipt jsonb
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
  v_existing_receipt public.agent_effect_receipts%rowtype;
  v_existing_version public.document_versions%rowtype;
  v_created uuid;
  v_output jsonb;
  v_next_version bigint;
  v_state jsonb;
begin
  if v_owner is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000';
  end if;
  if p_receipt is null
     or p_receipt->>'idempotencyKey' is distinct from p_idempotency_key
     or nullif(trim(p_receipt->>'callId'), '') is null
     or nullif(trim(p_receipt->>'toolName'), '') is null
     or p_receipt->'output' is null
     or nullif(trim(p_receipt->>'completedAt'), '') is null
     or nullif(trim(p_receipt->>'stepId'), '') is null
     or nullif(trim(p_receipt->>'effect'), '') is null
  then
    raise exception 'EFFECT_RECEIPT_INVALID' using errcode = '22023';
  end if;

  select * into v_run
    from public.agent_runs
   where id = p_run_id and owner_user_id = v_owner
   for update;
  if not found then
    raise exception 'RUN_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Exact recovery must be checked before status, lock-version, or revision
  -- guards. A committed effect remains a success after a lost response.
  select * into v_existing_receipt
    from public.agent_effect_receipts
   where idempotency_key = p_idempotency_key
   for update;
  if found then
    if v_existing_receipt.owner_user_id <> v_owner
       or v_existing_receipt.run_id <> p_run_id
       or v_existing_receipt.receipt->>'callId' is distinct from p_receipt->>'callId'
       or v_existing_receipt.receipt->>'toolName' is distinct from p_receipt->>'toolName'
       or v_existing_receipt.receipt->'output' is distinct from p_receipt->'output'
    then
      raise exception 'EFFECT_RECEIPT_CONFLICT' using errcode = '40001';
    end if;

    select * into v_existing_version
      from public.document_versions
     where created_by_run_id = p_run_id
       and operation_log @> jsonb_build_array(jsonb_build_object('idempotencyKey', p_idempotency_key))
     order by created_at asc
     limit 1;
    if not found then
      raise exception 'EFFECT_RECEIPT_CONFLICT' using errcode = '40001';
    end if;

    return jsonb_build_object(
      'kind', 'committed',
      'replay', true,
      'receipt', v_existing_receipt.receipt,
      'revision', v_existing_version.sha256,
      'lockVersion', v_run.lock_version,
      'versionRef', v_existing_version.id
    );
  end if;

  if v_run.status = 'cancelled' then
    return jsonb_build_object('kind', 'run-cancelled');
  end if;
  if v_run.lock_version <> p_expected_run_version then
    raise exception 'AGENT_RUN_CONFLICT' using errcode = '40001';
  end if;

  select * into v_document
    from public.working_documents
   where id = p_document_id and owner_user_id = v_owner
   for update;
  if not found then
    raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_current
    from public.document_versions
   where id = v_document.current_version_id
     and owner_user_id = v_owner;
  if not found or v_current.sha256 <> p_expected_revision then
    return jsonb_build_object(
      'kind', 'revision-conflict',
      'actualRevision', coalesce(v_current.sha256, '')
    );
  end if;

  v_output := p_output_ref::jsonb;
  v_next_version := v_run.lock_version + 1;

  insert into public.document_versions (
    owner_user_id, working_document_id, parent_version_id, version_number,
    origin, object_key, manifest_object_key, sha256, engine_version,
    created_by_run_id, operation_log
  ) values (
    v_owner, p_document_id, v_current.id, v_current.version_number + 1,
    'agent', v_output->>'objectKey', v_output->>'manifestObjectKey',
    p_derived_revision, 'paperduck-ooxml-v1', p_run_id,
    coalesce(v_output->'operationLog', '[]'::jsonb)
      || jsonb_build_array(jsonb_build_object('idempotencyKey', p_idempotency_key))
  ) returning id into v_created;

  update public.working_documents
     set current_version_id = v_created,
         revision = revision + 1,
         updated_at = now()
   where id = p_document_id
     and owner_user_id = v_owner
     and current_version_id = v_current.id;
  if not found then
    raise exception 'DOCUMENT_COMMIT_CONFLICT' using errcode = '40001';
  end if;

  insert into public.agent_effect_receipts (
    idempotency_key, owner_user_id, run_id, step_id, effect, receipt
  ) values (
    p_idempotency_key, v_owner, p_run_id,
    p_receipt->>'stepId', p_receipt->>'effect', p_receipt
  );

  v_state := coalesce(v_run.state, '{}'::jsonb)
    || jsonb_build_object('version', v_next_version);
  update public.agent_runs
     set lock_version = v_next_version,
         state = v_state,
         updated_at = now()
   where id = p_run_id
     and owner_user_id = v_owner
     and lock_version = p_expected_run_version;
  if not found then
    raise exception 'AGENT_RUN_CONFLICT' using errcode = '40001';
  end if;

  return jsonb_build_object(
    'kind', 'committed',
    'replay', false,
    'receipt', p_receipt,
    'revision', p_derived_revision,
    'lockVersion', v_next_version,
    'versionRef', v_created
  );
end;
$$;

create or replace function public.save_effect_receipt(
  p_run_id uuid,
  p_receipt jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_existing public.agent_effect_receipts%rowtype;
  v_lock_version bigint;
begin
  if v_owner is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000';
  end if;
  if p_receipt is null or nullif(trim(p_receipt->>'idempotencyKey'), '') is null then
    raise exception 'EFFECT_RECEIPT_INVALID' using errcode = '22023';
  end if;

  select * into v_existing
    from public.agent_effect_receipts
   where idempotency_key = p_receipt->>'idempotencyKey'
   for update;
  if found then
    if v_existing.owner_user_id <> v_owner
       or v_existing.run_id <> p_run_id
       or v_existing.receipt->>'callId' is distinct from p_receipt->>'callId'
       or v_existing.receipt->>'toolName' is distinct from p_receipt->>'toolName'
       or v_existing.receipt->'output' is distinct from p_receipt->'output'
    then
      raise exception 'EFFECT_RECEIPT_CONFLICT' using errcode = '40001';
    end if;
    select lock_version into v_lock_version
      from public.agent_runs
     where id = p_run_id and owner_user_id = v_owner;
    if v_lock_version is null then
      raise exception 'RUN_NOT_FOUND' using errcode = 'P0002';
    end if;
    return jsonb_build_object('receipt', v_existing.receipt, 'lockVersion', v_lock_version);
  end if;

  if not exists (
    select 1 from public.agent_runs
     where id = p_run_id and owner_user_id = v_owner
  ) then
    raise exception 'RUN_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.agent_effect_receipts (
    idempotency_key, owner_user_id, run_id, step_id, effect, receipt
  ) values (
    p_receipt->>'idempotencyKey', v_owner, p_run_id,
    coalesce(p_receipt->>'stepId', p_receipt->>'callId'),
    coalesce(p_receipt->>'effect', p_receipt->>'toolName'),
    p_receipt
  ) returning receipt into v_existing.receipt;

  select lock_version into v_lock_version
    from public.agent_runs
   where id = p_run_id and owner_user_id = v_owner;
  return jsonb_build_object('receipt', v_existing.receipt, 'lockVersion', v_lock_version);
end;
$$;

revoke all on function public.commit_loop_document_version(uuid, bigint, uuid, text, text, text, text, jsonb) from public, anon;
grant execute on function public.commit_loop_document_version(uuid, bigint, uuid, text, text, text, text, jsonb) to authenticated;
revoke all on function public.save_effect_receipt(uuid, jsonb) from public, anon;
grant execute on function public.save_effect_receipt(uuid, jsonb) to authenticated;

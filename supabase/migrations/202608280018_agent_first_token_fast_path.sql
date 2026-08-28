-- Collapse the fresh-run and loop bootstrap read paths into database-local
-- operations. The returned state remains the runtime source of truth; events
-- and provider activity are still owned by the application layer.

create or replace function public.create_agent_turn_from_task(
  p_task_id uuid,
  p_run_id uuid,
  p_state jsonb,
  p_goal text,
  p_user_message_id uuid,
  p_user_message text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_task public.tasks%rowtype;
  v_document public.working_documents%rowtype;
  v_revision text;
  v_conversation uuid;
  v_active public.agent_runs%rowtype;
  v_state jsonb;
  v_started timestamptz := clock_timestamp();
  v_active_run_ms numeric := 0;
  v_working_document_ms numeric := 0;
  v_revision_ms numeric := 0;
  v_conversation_ms numeric := 0;
  v_create_turn_ms numeric;
  v_lease_expires_at timestamptz := now() + interval '2 minutes';
begin
  if v_owner is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000';
  end if;

  select * into v_task
    from public.tasks
   where id = p_task_id and owner_user_id = v_owner
   for update;
  if not found then
    raise exception 'TASK_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_active
    from public.agent_runs
   where task_id = p_task_id
     and owner_user_id = v_owner
     and status in ('queued', 'running', 'awaiting_approval', 'awaiting_user', 'awaiting_review')
   order by updated_at desc
   limit 1
   for update;
  v_active_run_ms := extract(epoch from (clock_timestamp() - v_started)) * 1000;
  if found then
    if v_active.status in ('queued', 'running')
       and v_active.lease_expires_at is not null
       and v_active.lease_expires_at <= now() then
      update public.agent_runs
         set status = 'cancelled',
             state = jsonb_set(
               jsonb_set(coalesce(state, '{}'::jsonb), '{status}', '"cancelled"'::jsonb, true),
               '{loopCheckpoint,status}', '"cancelled"'::jsonb, true
             ),
             error_code = 'STALE_RUN_RECOVERED',
             error_message = '运行租约已过期，已安全回收。',
             finished_at = now(),
             updated_at = now(),
             lease_expires_at = null
       where id = v_active.id;
    else
      raise exception 'TURN_NOT_ALLOWED' using errcode = '40001';
    end if;
  end if;

  v_started := clock_timestamp();
  select * into v_document
    from public.working_documents
   where task_id = p_task_id and owner_user_id = v_owner
   for update;
  if not found then
    raise exception 'WORKING_DOCUMENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  v_working_document_ms := extract(epoch from (clock_timestamp() - v_started)) * 1000;

  v_started := clock_timestamp();
  select v.sha256 into v_revision
    from public.document_versions v
   where v.id = v_document.current_version_id
     and v.owner_user_id = v_owner;
  if v_revision is null then
    raise exception 'DOCUMENT_REVISION_NOT_FOUND' using errcode = 'P0002';
  end if;
  v_revision_ms := extract(epoch from (clock_timestamp() - v_started)) * 1000;

  v_started := clock_timestamp();
  select c.id into v_conversation
    from public.conversations c
   where c.task_id = p_task_id and c.owner_user_id = v_owner
   for update;
  if v_conversation is null then
    insert into public.conversations(task_id, owner_user_id)
    values (p_task_id, v_owner)
    returning id into v_conversation;
  end if;
  v_conversation_ms := extract(epoch from (clock_timestamp() - v_started)) * 1000;

  v_started := clock_timestamp();
  v_state := jsonb_set(
    coalesce(p_state, '{}'::jsonb) || jsonb_build_object(
      'id', p_run_id,
      'taskId', p_task_id,
      'documentId', v_document.id,
      'baseRevision', v_revision,
      'status', 'queued',
      'lockVersion', 0,
      'updatedAt', now()
    ),
    '{conversationId}', to_jsonb(v_conversation), true
  );
  insert into public.agent_runs(
    id, owner_user_id, task_id, working_document_id, base_revision,
    status, lock_version, state, lease_expires_at
  ) values (
    p_run_id, v_owner, p_task_id, v_document.id, v_revision,
    'queued', 0, v_state, v_lease_expires_at
  );
  insert into public.messages(
    id, owner_user_id, conversation_id, role, parts, run_id, message_key, delivery_status
  ) values (
    p_user_message_id, v_owner, v_conversation, 'user',
    jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_user_message)),
    p_run_id, p_user_message_id::text, 'sent'
  ) on conflict (conversation_id, message_key) do nothing;
  update public.tasks
     set goal = coalesce(p_goal, goal), updated_at = now()
   where id = p_task_id and owner_user_id = v_owner;
  v_create_turn_ms := extract(epoch from (clock_timestamp() - v_started)) * 1000;

  return jsonb_build_object(
    'run', v_state || jsonb_build_object('leaseExpiresAt', v_lease_expires_at),
    'timings', jsonb_build_object(
      'activeRunCheckMs', round(v_active_run_ms, 2),
      'workingDocumentMs', round(v_working_document_ms, 2),
      'revisionMs', round(v_revision_ms, 2),
      'conversationMs', round(v_conversation_ms, 2),
      'createTurnRpcMs', round(v_active_run_ms + v_working_document_ms + v_revision_ms + v_conversation_ms + v_create_turn_ms, 2)
    )
  );
end;
$$;

revoke all on function public.create_agent_turn_from_task(uuid, uuid, jsonb, text, uuid, text) from public, anon;
grant execute on function public.create_agent_turn_from_task(uuid, uuid, jsonb, text, uuid, text) to authenticated;

create or replace function public.load_agent_loop_bootstrap(p_run_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_run public.agent_runs%rowtype;
  v_conversation uuid;
  v_messages jsonb;
  v_rows integer;
begin
  if v_owner is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000';
  end if;
  select * into v_run
    from public.agent_runs
   where id = p_run_id and owner_user_id = v_owner;
  if not found then
    raise exception 'RUN_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_conversation := nullif(v_run.state->>'conversationId', '')::uuid;
  if v_conversation is null then
    return jsonb_build_object(
      'runId', v_run.id, 'taskId', v_run.task_id,
      'lockVersion', v_run.lock_version,
      'checkpoint', v_run.state->'loopCheckpoint',
      'conversationId', null, 'priorMessages', '[]'::jsonb,
      'loadedCount', 0, 'truncated', false
    );
  end if;

  select count(*)::integer into v_rows
    from (
      select 1
        from public.messages m
       where m.conversation_id = v_conversation
         and m.owner_user_id = v_owner
         and m.run_id is distinct from p_run_id
         and m.role in ('user', 'assistant')
       order by m.created_at desc, m.id desc
       limit 201
    ) recent;

  select coalesce(jsonb_agg(
    jsonb_build_object('role', page.role, 'content', page.content)
    order by page.created_at, page.id
  ), '[]'::jsonb)
    into v_messages
    from (
      select m.id, m.created_at, m.role,
             string_agg(part.value->>'text', E'\n' order by part.ordinality) as content
        from public.messages m
        cross join lateral jsonb_array_elements(coalesce(m.parts, '[]'::jsonb)) with ordinality part(value, ordinality)
       where m.conversation_id = v_conversation
         and m.owner_user_id = v_owner
         and m.run_id is distinct from p_run_id
         and m.role in ('user', 'assistant')
       group by m.id, m.created_at, m.role
       having string_agg(part.value->>'text', E'\n' order by part.ordinality) is not null
       order by m.created_at desc, m.id desc
       limit 200
    ) page;

  return jsonb_build_object(
    'runId', v_run.id,
    'taskId', v_run.task_id,
    'lockVersion', v_run.lock_version,
    'checkpoint', v_run.state->'loopCheckpoint',
    'conversationId', v_conversation,
    'priorMessages', v_messages,
    'loadedCount', jsonb_array_length(v_messages),
    'truncated', v_rows > 200
  );
end;
$$;

revoke all on function public.load_agent_loop_bootstrap(uuid) from public, anon;
grant execute on function public.load_agent_loop_bootstrap(uuid) to authenticated;

create or replace function public.save_agent_loop_checkpoint(
  p_run_id uuid,
  p_expected_lock_version bigint,
  p_checkpoint jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_run public.agent_runs%rowtype;
  v_status text;
  v_next_version bigint;
  v_state jsonb;
  v_lease_expires_at timestamptz;
begin
  if v_owner is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000';
  end if;
  if p_checkpoint is null then
    raise exception 'CHECKPOINT_INVALID' using errcode = '22023';
  end if;
  select * into v_run
    from public.agent_runs
   where id = p_run_id and owner_user_id = v_owner
   for update;
  if not found then raise exception 'RUN_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_run.status = 'cancelled' then raise exception 'RUN_CANCELLED' using errcode = '40001'; end if;
  if v_run.lock_version <> p_expected_lock_version then raise exception 'RUN_VERSION_CONFLICT' using errcode = '40001'; end if;

  v_status := case
    when p_checkpoint->>'status' in ('completed', 'failed', 'cancelled', 'awaiting_approval', 'awaiting_user') then p_checkpoint->>'status'
    else 'running'
  end;
  if v_status = 'cancelled' then raise exception 'RUN_CANCELLED' using errcode = '40001'; end if;
  v_next_version := v_run.lock_version + 1;
  v_lease_expires_at := case when v_status in ('queued', 'running') then now() + interval '2 minutes' else null end;
  v_state := coalesce(v_run.state, '{}'::jsonb)
    || jsonb_build_object(
      'version', v_next_version,
      'status', v_status,
      'loopCheckpoint', p_checkpoint,
      'pendingInteraction', coalesce(p_checkpoint->'pendingInteraction', 'null'::jsonb),
      'pendingResolution', coalesce(p_checkpoint->'pendingResolution', 'null'::jsonb)
    );
  if v_status = 'failed' then
    v_state := v_state || jsonb_build_object('failure', jsonb_build_object(
      'code', 'AGENT_LOOP_FAILED',
      'message', coalesce(p_checkpoint->>'finalText', 'Agent execution failed'),
      'retryable', true
    ));
  else
    v_state := v_state - 'failure';
  end if;
  update public.agent_runs
     set state = v_state,
         status = v_status,
         resume_cursor = p_checkpoint,
         lock_version = v_next_version,
         updated_at = now(),
         lease_expires_at = v_lease_expires_at
   where id = p_run_id and owner_user_id = v_owner and lock_version = p_expected_lock_version and status <> 'cancelled';
  if not found then raise exception 'RUN_VERSION_CONFLICT' using errcode = '40001'; end if;
  return jsonb_build_object('lockVersion', v_next_version, 'checkpoint', p_checkpoint);
end;
$$;

revoke all on function public.save_agent_loop_checkpoint(uuid, bigint, jsonb) from public, anon;
grant execute on function public.save_agent_loop_checkpoint(uuid, bigint, jsonb) to authenticated;

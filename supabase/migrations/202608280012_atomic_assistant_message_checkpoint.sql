-- Persist a semantic assistant message and its runtime checkpoint as one
-- transaction. EventStore projection remains a later, non-blocking step.
create or replace function public.commit_agent_checkpoint_with_message(
  p_run_id uuid,
  p_expected_lock_version bigint,
  p_checkpoint jsonb,
  p_message_key text,
  p_message_text text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_run public.agent_runs%rowtype;
  v_conversation uuid;
  v_status text;
  v_next_version bigint;
  v_state jsonb;
begin
  if v_owner is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000'; end if;
  if p_checkpoint is null or nullif(trim(p_message_key), '') is null or p_message_text is null then
    raise exception 'ASSISTANT_MESSAGE_INVALID' using errcode = '22023';
  end if;

  select * into v_run
  from public.agent_runs
  where id = p_run_id and owner_user_id = v_owner
  for update;
  if not found then raise exception 'RUN_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_run.status = 'cancelled' then raise exception 'RUN_CANCELLED' using errcode = '40001'; end if;
  if v_run.lock_version <> p_expected_lock_version then raise exception 'RUN_VERSION_CONFLICT' using errcode = '40001'; end if;

  v_status := case
    when p_checkpoint->>'status' in ('completed', 'failed', 'cancelled') then p_checkpoint->>'status'
    when p_checkpoint->>'status' in ('awaiting_approval', 'awaiting_user') then p_checkpoint->>'status'
    else 'running'
  end;
  if v_status = 'cancelled' then raise exception 'RUN_CANCELLED' using errcode = '40001'; end if;
  v_conversation := nullif(v_run.state->>'conversationId', '')::uuid;
  if v_conversation is null then raise exception 'CONVERSATION_NOT_FOUND' using errcode = 'P0002'; end if;
  v_next_version := v_run.lock_version + 1;

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

  insert into public.messages(
    id, owner_user_id, conversation_id, role, parts, run_id, message_key, delivery_status
  ) values (
    gen_random_uuid(), v_owner, v_conversation, 'assistant',
    jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_message_text)),
    p_run_id, p_message_key, 'sent'
  ) on conflict (conversation_id, message_key) do update set
    parts = excluded.parts,
    run_id = excluded.run_id,
    delivery_status = excluded.delivery_status;

  update public.agent_runs
  set state = v_state,
      status = v_status,
      resume_cursor = p_checkpoint,
      lock_version = v_next_version,
      updated_at = now(),
      lease_expires_at = case when v_status in ('queued', 'running') then now() + interval '2 minutes' else null end
  where id = p_run_id and owner_user_id = v_owner and lock_version = p_expected_lock_version;
  if not found then raise exception 'RUN_VERSION_CONFLICT' using errcode = '40001'; end if;

  return p_checkpoint;
end;
$$;

revoke all on function public.commit_agent_checkpoint_with_message(uuid, bigint, jsonb, text, text) from public, anon;
grant execute on function public.commit_agent_checkpoint_with_message(uuid, bigint, jsonb, text, text) to authenticated;

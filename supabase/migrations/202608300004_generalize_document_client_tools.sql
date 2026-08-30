-- Generalize the durable client-tool rendezvous for viewport scrolling.
-- Capture keeps the existing asset provenance checks; scroll has no asset.

create or replace function public.resolve_agent_loop_interaction(
  p_run_id uuid, p_interaction_id text, p_interaction_type text,
  p_call_id text default null, p_resolution jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_run public.agent_runs%rowtype;
  v_checkpoint jsonb;
  v_pending jsonb;
  v_resolution jsonb;
  v_next jsonb;
  v_asset record;
begin
  if p_interaction_type not in ('approval', 'user_input', 'client_tool') then raise exception 'INTERACTION_TYPE_INVALID'; end if;
  if p_resolution->>'interactionId' <> p_interaction_id or p_resolution->>'type' <> p_interaction_type then raise exception 'INTERACTION_RESOLUTION_INVALID'; end if;
  if p_interaction_type = 'approval' and (p_resolution->>'callId' is null or p_resolution->>'callId' <> p_call_id or p_resolution->>'decision' not in ('approved', 'rejected')) then raise exception 'INTERACTION_RESOLUTION_INVALID'; end if;
  if p_interaction_type = 'user_input' and (nullif(trim(p_resolution->>'messageId'), '') is null or nullif(trim(p_resolution->>'text'), '') is null) then raise exception 'INTERACTION_RESOLUTION_INVALID'; end if;
  if p_interaction_type = 'client_tool' and (p_resolution->>'callId' is null or p_resolution->>'callId' <> p_call_id or jsonb_typeof(p_resolution->'result') <> 'object') then
    raise exception 'CLIENT_TOOL_RESULT_INVALID' using errcode = '22023';
  end if;

  select * into v_run from public.agent_runs where id = p_run_id and owner_user_id = v_owner for update;
  if not found then raise exception 'RUN_NOT_FOUND'; end if;
  if v_run.status = 'cancelled' then raise exception 'RUN_CANCELLED' using errcode = '40001'; end if;
  v_checkpoint := coalesce(v_run.state->'loopCheckpoint', '{}'::jsonb);
  v_pending := v_checkpoint->'pendingInteraction';
  if v_pending is null or v_pending = 'null'::jsonb then
    if p_interaction_type = 'client_tool'
      and v_checkpoint->'pendingResolution'->>'interactionId' = p_interaction_id
      and v_checkpoint->'pendingResolution'->>'callId' = p_call_id
      and v_checkpoint->'pendingResolution'->'result' = p_resolution->'result' then
      return jsonb_build_object('checkpoint', v_checkpoint, 'lockVersion', v_run.lock_version);
    end if;
    raise exception 'INTERACTION_ALREADY_CLAIMED';
  end if;
  if v_pending->>'interactionId' <> p_interaction_id or v_pending->>'type' <> p_interaction_type or (p_interaction_type in ('approval', 'client_tool') and v_pending->>'callId' <> p_call_id) then raise exception 'INTERACTION_MISMATCH'; end if;

  if p_interaction_type = 'client_tool' and v_pending->>'toolName' = 'capture_document_view' then
    if p_resolution->'result'->>'assetId' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      or p_resolution->'result'->>'mimeType' <> 'image/png'
      or p_resolution->'result'->>'sha256' !~ '^[0-9a-f]{64}$'
      or nullif(p_resolution->'result'->>'revision', '') is null
      or p_resolution->'result'->>'width' !~ '^[1-9][0-9]{0,4}$'
      or p_resolution->'result'->>'height' !~ '^[1-9][0-9]{0,4}$'
      or (select count(*) from jsonb_object_keys(p_resolution->'result')) not in (6, 7) then
      raise exception 'CLIENT_TOOL_RESULT_INVALID' using errcode = '22023';
    end if;
    select id, kind, mime_type, sha256, width, height, document_revision, page_number
      into v_asset
      from public.assets
      where id = (p_resolution->'result'->>'assetId')::uuid
        and owner_user_id = v_owner
        and task_id = v_run.task_id
        and kind = 'preview'
        and provider = 'document_surface';
    if not found or v_asset.mime_type <> 'image/png' or v_asset.sha256 <> p_resolution->'result'->>'sha256' or v_asset.width <> (p_resolution->'result'->>'width')::integer or v_asset.height <> (p_resolution->'result'->>'height')::integer or v_asset.document_revision <> v_pending->>'expectedRevision' or p_resolution->'result'->>'revision' <> v_pending->>'expectedRevision' then
      raise exception 'CLIENT_TOOL_ASSET_MISMATCH' using errcode = '22023';
    end if;
    if v_pending->'input'->>'target' = 'page' and (v_asset.page_number is null or v_asset.page_number <> (v_pending->'input'->>'pageNumber')::integer) then
      raise exception 'CLIENT_TOOL_ASSET_MISMATCH' using errcode = '22023';
    end if;
  elsif p_interaction_type = 'client_tool' and v_pending->>'toolName' = 'scroll_document_view' then
    if (select count(*) from jsonb_object_keys(p_resolution->'result')) <> 8
      or nullif(p_resolution->'result'->>'revision', '') is null
      or p_resolution->'result'->>'revision' <> v_pending->>'expectedRevision'
      or jsonb_typeof(p_resolution->'result'->'beforeScrollTop') <> 'number'
      or jsonb_typeof(p_resolution->'result'->'scrollTop') <> 'number'
      or jsonb_typeof(p_resolution->'result'->'maxScrollTop') <> 'number'
      or jsonb_typeof(p_resolution->'result'->'viewportHeight') <> 'number'
      or (p_resolution->'result'->>'beforeScrollTop')::numeric < 0
      or (p_resolution->'result'->>'scrollTop')::numeric < 0
      or (p_resolution->'result'->>'maxScrollTop')::numeric < 0
      or (p_resolution->'result'->>'viewportHeight')::numeric <= 0
      or (p_resolution->'result'->>'beforeScrollTop')::numeric > (p_resolution->'result'->>'maxScrollTop')::numeric + 0.5
      or (p_resolution->'result'->>'scrollTop')::numeric > (p_resolution->'result'->>'maxScrollTop')::numeric + 0.5
      or jsonb_typeof(p_resolution->'result'->'moved') <> 'boolean'
      or jsonb_typeof(p_resolution->'result'->'atTop') <> 'boolean'
      or jsonb_typeof(p_resolution->'result'->'atBottom') <> 'boolean' then
      raise exception 'CLIENT_TOOL_RESULT_INVALID' using errcode = '22023';
    end if;
  elsif p_interaction_type = 'client_tool' then
    raise exception 'CLIENT_TOOL_INTERACTION_MISMATCH';
  end if;

  v_resolution := case
    when p_interaction_type = 'approval' then jsonb_build_object('interactionId', p_interaction_id, 'type', 'approval', 'callId', v_pending->>'callId', 'toolName', v_pending->>'toolName', 'input', v_pending->'input', 'decision', p_resolution->>'decision')
    when p_interaction_type = 'client_tool' then jsonb_build_object('interactionId', p_interaction_id, 'type', 'client_tool', 'callId', v_pending->>'callId', 'toolName', v_pending->>'toolName', 'input', v_pending->'input', 'expectedRevision', v_pending->>'expectedRevision', 'result', p_resolution->'result')
    else p_resolution
  end;
  v_next := jsonb_set(jsonb_set(jsonb_set(v_checkpoint, '{pendingInteraction}', 'null'::jsonb, true), '{pendingResolution}', v_resolution, true), '{status}', '"running"'::jsonb, true);
  update public.agent_runs set state = jsonb_set(state, '{loopCheckpoint}', v_next, true) || jsonb_build_object('pendingInteraction', null, 'pendingResolution', v_resolution, 'status', 'running'), resume_cursor = v_next, status = 'running', lock_version = lock_version + 1, lease_expires_at = now() + interval '2 minutes', updated_at = now() where id = p_run_id and owner_user_id = v_owner;
  return jsonb_build_object('checkpoint', v_next, 'lockVersion', v_run.lock_version + 1);
end;
$$;

revoke all on function public.resolve_agent_loop_interaction(uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.resolve_agent_loop_interaction(uuid, text, text, text, jsonb) to authenticated;

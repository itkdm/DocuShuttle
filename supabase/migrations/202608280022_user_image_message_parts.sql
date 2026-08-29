-- Persist user image references as safe message parts during the atomic
-- fresh-run transaction. Existing six-argument callers remain unchanged.
create or replace function public.create_agent_turn_from_task(
  p_task_id uuid, p_run_id uuid, p_state jsonb, p_goal text,
  p_user_message_id uuid, p_user_message text, p_user_message_parts jsonb
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
  v_part jsonb;
  v_asset public.assets%rowtype;
  v_images integer := 0;
  v_lease timestamptz := now() + interval '2 minutes';
begin
  if v_owner is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000'; end if;
  if p_user_message_parts is null or jsonb_typeof(p_user_message_parts) <> 'array'
     or jsonb_array_length(p_user_message_parts) > 5 then
    raise exception 'MESSAGE_PARTS_INVALID' using errcode = '22023';
  end if;
  for v_part in select value from jsonb_array_elements(p_user_message_parts) loop
    if v_part->>'type' = 'text' then
      if jsonb_typeof(v_part->'text') <> 'string' then raise exception 'MESSAGE_PARTS_INVALID' using errcode = '22023'; end if;
    elsif v_part->>'type' = 'image' then
      v_images := v_images + 1;
      if v_part ?| array['objectKey','url','data','base64']
         or nullif(v_part->>'assetId', '') is null
         or v_part->>'mimeType' not in ('image/png','image/jpeg','image/webp') then
        raise exception 'MESSAGE_PARTS_INVALID' using errcode = '22023';
      end if;
      select * into v_asset from public.assets
       where id = (v_part->>'assetId')::uuid and owner_user_id = v_owner
         and task_id = p_task_id and kind = 'uploaded_image';
      if not found or v_asset.mime_type <> v_part->>'mimeType' then raise exception 'IMAGE_ASSET_INVALID' using errcode = '22023'; end if;
    else
      raise exception 'MESSAGE_PARTS_INVALID' using errcode = '22023';
    end if;
  end loop;
  if v_images > 4 then raise exception 'MESSAGE_IMAGE_LIMIT' using errcode = '22023'; end if;
  select * into v_task from public.tasks where id = p_task_id and owner_user_id = v_owner for update;
  if not found then raise exception 'TASK_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_active from public.agent_runs where task_id = p_task_id and owner_user_id = v_owner
    and status in ('queued','running','awaiting_approval','awaiting_user','awaiting_review') order by updated_at desc limit 1 for update;
  if found then
    if v_active.status in ('queued','running') and v_active.lease_expires_at <= now() then
      update public.agent_runs set status='cancelled', state=jsonb_set(jsonb_set(coalesce(state,'{}'::jsonb),'{status}','"cancelled"'::jsonb,true),'{loopCheckpoint,status}','"cancelled"'::jsonb,true), finished_at=now(), updated_at=now(), lease_expires_at=null where id=v_active.id;
    else raise exception 'TURN_NOT_ALLOWED' using errcode = '40001'; end if;
  end if;
  select * into v_document from public.working_documents where task_id=p_task_id and owner_user_id=v_owner for update;
  if not found then raise exception 'WORKING_DOCUMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  select sha256 into v_revision from public.document_versions where id=v_document.current_version_id and owner_user_id=v_owner;
  if v_revision is null then raise exception 'DOCUMENT_REVISION_NOT_FOUND' using errcode = 'P0002'; end if;
  select id into v_conversation from public.conversations where task_id=p_task_id and owner_user_id=v_owner for update;
  if v_conversation is null then insert into public.conversations(task_id,owner_user_id) values(p_task_id,v_owner) returning id into v_conversation; end if;
  v_state := jsonb_set(coalesce(p_state,'{}'::jsonb)||jsonb_build_object('id',p_run_id,'taskId',p_task_id,'documentId',v_document.id,'baseRevision',v_revision,'status','queued','lockVersion',0,'updatedAt',now()),'{conversationId}',to_jsonb(v_conversation),true);
  insert into public.agent_runs(id,owner_user_id,task_id,working_document_id,base_revision,status,lock_version,state,lease_expires_at) values(p_run_id,v_owner,p_task_id,v_document.id,v_revision,'queued',0,v_state,v_lease);
  insert into public.messages(id,owner_user_id,conversation_id,role,parts,run_id,message_key,delivery_status) values(p_user_message_id,v_owner,v_conversation,'user',p_user_message_parts,p_run_id,p_user_message_id::text,'sent') on conflict(conversation_id,message_key) do nothing;
  update public.tasks set goal=coalesce(p_goal,goal),updated_at=now() where id=p_task_id and owner_user_id=v_owner;
  return jsonb_build_object('run',v_state||jsonb_build_object('leaseExpiresAt',v_lease),'timings',jsonb_build_object());
end;
$$;
revoke all on function public.create_agent_turn_from_task(uuid,uuid,jsonb,text,uuid,text,jsonb) from public, anon;
grant execute on function public.create_agent_turn_from_task(uuid,uuid,jsonb,text,uuid,text,jsonb) to authenticated;

-- Durable conversation projection. Checkpoints remain model state; these rows
-- are the user-visible, append-only history and are safe to replay.
alter table public.messages add column if not exists message_key text;
update public.messages set message_key = id::text where message_key is null;
alter table public.messages alter column message_key set not null;
create unique index if not exists messages_conversation_key_idx
  on public.messages(conversation_id, message_key);

create or replace function public.create_agent_turn(
  p_task_id uuid, p_run_id uuid, p_working_document_id uuid,
  p_base_revision text, p_state jsonb, p_goal text,
  p_user_message_id uuid, p_user_message text
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_conversation uuid;
begin
  if v_owner is null or not exists (select 1 from public.tasks where id = p_task_id and owner_user_id = v_owner)
    then raise exception 'TASK_NOT_FOUND' using errcode = 'P0002'; end if;
  select id into v_conversation from public.conversations where task_id = p_task_id and owner_user_id = v_owner for update;
  if v_conversation is null then
    insert into public.conversations(task_id, owner_user_id) values (p_task_id, v_owner) returning id into v_conversation;
  end if;
  insert into public.agent_runs(id, owner_user_id, task_id, working_document_id, base_revision, status, lock_version, state, lease_expires_at)
    values (p_run_id, v_owner, p_task_id, p_working_document_id, p_base_revision, 'queued', 0, p_state, now() + interval '2 minutes');
  insert into public.messages(id, owner_user_id, conversation_id, role, parts, run_id, message_key)
    values (p_user_message_id, v_owner, v_conversation, 'user', jsonb_build_array(jsonb_build_object('type','text','text',p_user_message)), p_run_id, p_user_message_id::text)
    on conflict (conversation_id, message_key) do nothing;
  update public.tasks set goal = coalesce(p_goal, goal), updated_at = now() where id = p_task_id and owner_user_id = v_owner;
  return jsonb_set(p_state, '{conversationId}', to_jsonb(v_conversation), true);
end; $$;
revoke all on function public.create_agent_turn(uuid, uuid, uuid, text, jsonb, text) from public, anon;
revoke all on function public.create_agent_turn(uuid, uuid, uuid, text, jsonb, text, uuid, text) from public, anon;
grant execute on function public.create_agent_turn(uuid, uuid, uuid, text, jsonb, text, uuid, text) to authenticated;

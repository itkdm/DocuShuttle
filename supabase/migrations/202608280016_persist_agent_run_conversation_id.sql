-- Persist the conversation identity in the durable Run state before the row is
-- inserted. The RPC return value and agent_runs.state must be identical.
-- Historical rows are repaired only when task + owner maps to exactly one
-- conversation; rows without such a mapping are intentionally left alone.
update public.agent_runs r
set state = jsonb_set(coalesce(r.state, '{}'::jsonb), '{conversationId}', to_jsonb(c.id), true),
    updated_at = now()
from public.conversations c
where not (coalesce(r.state, '{}'::jsonb) ? 'conversationId')
  and c.task_id = r.task_id
  and c.owner_user_id = r.owner_user_id
  and (select count(*) from public.conversations c2 where c2.task_id = r.task_id and c2.owner_user_id = r.owner_user_id) = 1;

create or replace function public.create_agent_turn(
  p_task_id uuid, p_run_id uuid, p_working_document_id uuid,
  p_base_revision text, p_state jsonb, p_goal text,
  p_user_message_id uuid, p_user_message text
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_conversation uuid;
  v_state jsonb;
begin
  if v_owner is null or not exists (select 1 from public.tasks where id = p_task_id and owner_user_id = v_owner)
    then raise exception 'TASK_NOT_FOUND' using errcode = 'P0002'; end if;
  select id into v_conversation
    from public.conversations
   where task_id = p_task_id and owner_user_id = v_owner
   for update;
  if v_conversation is null then
    insert into public.conversations(task_id, owner_user_id)
    values (p_task_id, v_owner)
    returning id into v_conversation;
  end if;

  v_state := jsonb_set(coalesce(p_state, '{}'::jsonb), '{conversationId}', to_jsonb(v_conversation), true);
  insert into public.agent_runs(id, owner_user_id, task_id, working_document_id, base_revision, status, lock_version, state, lease_expires_at)
    values (p_run_id, v_owner, p_task_id, p_working_document_id, p_base_revision, 'queued', 0, v_state, now() + interval '2 minutes');
  insert into public.messages(id, owner_user_id, conversation_id, role, parts, run_id, message_key)
    values (p_user_message_id, v_owner, v_conversation, 'user', jsonb_build_array(jsonb_build_object('type','text','text',p_user_message)), p_run_id, p_user_message_id::text)
    on conflict (conversation_id, message_key) do nothing;
  update public.tasks set goal = coalesce(p_goal, goal), updated_at = now() where id = p_task_id and owner_user_id = v_owner;
  return v_state;
end; $$;

revoke all on function public.create_agent_turn(uuid, uuid, uuid, text, jsonb, text) from public, anon;
revoke all on function public.create_agent_turn(uuid, uuid, uuid, text, jsonb, text, uuid, text) from public, anon;
grant execute on function public.create_agent_turn(uuid, uuid, uuid, text, jsonb, text, uuid, text) to authenticated;

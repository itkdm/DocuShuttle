-- Keep the bootstrap fast path, but return only safe semantic message parts.
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
  if v_owner is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000'; end if;
  select * into v_run from public.agent_runs where id=p_run_id and owner_user_id=v_owner;
  if not found then raise exception 'RUN_NOT_FOUND' using errcode = 'P0002'; end if;
  v_conversation := nullif(v_run.state->>'conversationId','')::uuid;
  if v_conversation is null then
    return jsonb_build_object('runId',v_run.id,'taskId',v_run.task_id,'lockVersion',v_run.lock_version,'checkpoint',v_run.state->'loopCheckpoint','conversationId',null,'priorMessages','[]'::jsonb,'loadedCount',0,'truncated',false);
  end if;
  select count(*)::integer into v_rows from (select 1 from public.messages m where m.conversation_id=v_conversation and m.owner_user_id=v_owner and m.run_id is distinct from p_run_id and m.role in ('user','assistant') order by m.created_at desc,m.id desc limit 201) recent;
  select coalesce(jsonb_agg(jsonb_build_object('role',page.role,'parts',page.parts) order by page.created_at,page.id),'[]'::jsonb) into v_messages
  from (
    select m.id,m.created_at,m.role,
      coalesce(jsonb_agg(case when part.value->>'type'='text' then jsonb_build_object('type','text','text',part.value->>'text') else jsonb_build_object('type','image','assetId',part.value->>'assetId','mimeType',part.value->>'mimeType') end order by part.ordinality) filter (where (part.value->>'type'='text' and jsonb_typeof(part.value->'text')='string') or (part.value->>'type'='image' and part.value->>'assetId' is not null and part.value->>'mimeType' in ('image/png','image/jpeg','image/webp') and exists (select 1 from public.assets a where a.id::text=part.value->>'assetId' and a.owner_user_id=v_owner and a.task_id=v_run.task_id and a.kind='uploaded_image' and a.mime_type=part.value->>'mimeType'))), '[]'::jsonb) parts
    from public.messages m cross join lateral jsonb_array_elements(coalesce(m.parts,'[]'::jsonb)) with ordinality part(value,ordinality)
    where m.conversation_id=v_conversation and m.owner_user_id=v_owner and m.run_id is distinct from p_run_id and m.role in ('user','assistant')
    group by m.id,m.created_at,m.role order by m.created_at desc,m.id desc limit 200
  ) page;
  return jsonb_build_object('runId',v_run.id,'taskId',v_run.task_id,'lockVersion',v_run.lock_version,'checkpoint',v_run.state->'loopCheckpoint','conversationId',v_conversation,'priorMessages',v_messages,'loadedCount',jsonb_array_length(v_messages),'truncated',v_rows>200);
end;
$$;
revoke all on function public.load_agent_loop_bootstrap(uuid) from public, anon;
grant execute on function public.load_agent_loop_bootstrap(uuid) to authenticated;

-- Return one page of conversation history in one authenticated Data API call.
-- The function runs as the caller so the existing table RLS remains active;
-- explicit owner predicates make the intended isolation visible in the query.
create or replace function public.list_conversation_messages_page(
  p_task_id uuid,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 31
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_conversation uuid;
  v_messages jsonb;
begin
  if v_owner is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = 'P0001';
  end if;

  select c.id
    into v_conversation
    from public.conversations c
   where c.task_id = p_task_id
     and c.owner_user_id = v_owner
   limit 1;

  if v_conversation is null then
    return jsonb_build_object('conversationId', null, 'messages', '[]'::jsonb);
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', page.id,
        'role', page.role,
        'parts', page.parts,
        'run_id', page.run_id,
        'created_at', page.created_at,
        'message_key', page.message_key,
        'delivery_status', page.delivery_status
      )
      order by page.created_at desc, page.id desc
    ),
    '[]'::jsonb
  )
    into v_messages
    from (
      select m.id, m.role, m.parts, m.run_id, m.created_at, m.message_key, m.delivery_status
        from public.messages m
       where m.conversation_id = v_conversation
         and m.owner_user_id = v_owner
         and (
           p_before_created_at is null
           or m.created_at < p_before_created_at
           or (m.created_at = p_before_created_at and p_before_id is not null and m.id < p_before_id)
         )
       order by m.created_at desc, m.id desc
       limit greatest(1, least(coalesce(p_limit, 31), 101))
    ) page;

  return jsonb_build_object(
    'conversationId', v_conversation,
    'messages', v_messages
  );
end;
$$;

revoke all on function public.list_conversation_messages_page(uuid, timestamptz, uuid, integer) from public, anon;
grant execute on function public.list_conversation_messages_page(uuid, timestamptz, uuid, integer) to authenticated;

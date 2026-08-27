-- Events are append-only facts, independent from the recovery checkpoint.
-- The run row lock serializes sequence allocation for concurrent/recovered
-- invocations; event ids make retries idempotent.
create or replace function public.append_agent_events(p_run_id uuid, p_events jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_event jsonb;
  v_event_id text;
  v_sequence bigint;
  v_stored jsonb;
begin
  perform 1 from public.agent_runs where id = p_run_id and owner_user_id = v_owner for update;
  if not found then raise exception 'RUN_NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(max(sequence), 0) into v_sequence from public.agent_run_events where run_id = p_run_id;
  for v_event in select value from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    v_event_id := v_event->>'eventId';
    if v_event_id is null or exists (select 1 from public.agent_run_events where id = v_event_id and run_id = p_run_id) then continue; end if;
    v_sequence := v_sequence + 1;
    v_stored := v_event || jsonb_build_object('runId', p_run_id::text, 'sequence', v_sequence);
    insert into public.agent_run_events(id, owner_user_id, run_id, sequence, event, occurred_at)
      values (v_event_id, v_owner, p_run_id, v_sequence, v_stored, coalesce((v_event->>'timestamp')::timestamptz, now()));
  end loop;
end;
$$;

revoke all on function public.append_agent_events(uuid, jsonb) from public, anon;
grant execute on function public.append_agent_events(uuid, jsonb) to authenticated;

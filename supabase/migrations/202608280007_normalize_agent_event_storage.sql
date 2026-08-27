-- Keep database-owned run_id/sequence in physical columns. The JSON event
-- stores only the protocol payload and event identity; the API reconstructs a
-- DurableAgentEvent at the persistence boundary.
update public.agent_run_events
set event = event - 'runId' - 'sequence'
where event ? 'runId' or event ? 'sequence';

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
begin
  perform 1 from public.agent_runs where id = p_run_id and owner_user_id = v_owner for update;
  if not found then raise exception 'RUN_NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(max(sequence), 0) into v_sequence from public.agent_run_events where run_id = p_run_id;
  for v_event in select value from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    v_event_id := v_event->>'eventId';
    if v_event_id is null or exists (select 1 from public.agent_run_events where id = v_event_id and run_id = p_run_id) then continue; end if;
    v_sequence := v_sequence + 1;
    insert into public.agent_run_events(id, owner_user_id, run_id, sequence, event, occurred_at)
      values (v_event_id, v_owner, p_run_id, v_sequence, v_event - 'runId' - 'sequence', coalesce((v_event->>'timestamp')::timestamptz, now()));
  end loop;
end;
$$;

revoke all on function public.append_agent_events(uuid, jsonb) from public, anon;
grant execute on function public.append_agent_events(uuid, jsonb) to authenticated;

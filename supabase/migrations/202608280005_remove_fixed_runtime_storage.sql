-- The product no longer persists fixed workflow steps or proposal/review
-- records. HITL interaction is part of the loop checkpoint and event stream.
drop table if exists public.agent_steps;
drop table if exists public.hitl_decisions;
drop table if exists public.hitl_requests;

alter table public.agent_effect_receipts drop constraint if exists agent_effect_receipts_effect_check;
alter table public.agent_effect_receipts add constraint agent_effect_receipts_effect_check
  check (length(effect) between 1 and 120);

drop function if exists public.save_agent_run(uuid, bigint, jsonb, jsonb);
drop function if exists public.commit_derived_document_version(uuid, bigint, uuid, text, text, text, text);

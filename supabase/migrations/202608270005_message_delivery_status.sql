-- Delivery state belongs to the durable message projection, not the UI.
-- A message inserted by create_agent_turn is already durably accepted; the
-- client may still display an optimistic pending state until the run starts.
alter table public.messages
  add column if not exists delivery_status text not null default 'sent';

alter table public.messages drop constraint if exists messages_delivery_status_check;
alter table public.messages add constraint messages_delivery_status_check
  check (delivery_status in ('pending', 'sent', 'failed'));

create index if not exists messages_conversation_created_idx
  on public.messages(conversation_id, created_at desc, id desc);

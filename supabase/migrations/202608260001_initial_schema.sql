-- PaperDuck initial production schema.
-- Anonymous sign-ins still use auth.users IDs and the authenticated role.

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '我的工作区' check (char_length(title) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id)
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null,
  title text not null check (char_length(title) between 1 and 200),
  goal text not null default '' check (char_length(goal) <= 8000),
  status text not null default 'draft' check (status in ('draft', 'ready', 'running', 'review', 'completed', 'failed', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id),
  foreign key (workspace_id, owner_user_id) references public.workspaces(id, owner_user_id) on delete cascade
);

create table public.source_files (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null,
  role text not null check (role in ('template', 'example', 'auxiliary')),
  original_name text not null check (char_length(original_name) between 1 and 255),
  object_key text not null unique,
  mime_type text not null check (mime_type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  byte_length bigint not null check (byte_length > 0 and byte_length <= 104857600),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  inspection jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (id, owner_user_id),
  foreign key (task_id, owner_user_id) references public.tasks(id, owner_user_id) on delete cascade
);

create table public.working_documents (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null,
  revision bigint not null default 0 check (revision >= 0),
  current_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (task_id),
  unique (id, owner_user_id),
  foreign key (task_id, owner_user_id) references public.tasks(id, owner_user_id) on delete cascade
);

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null,
  working_document_id uuid not null,
  base_revision text not null check (base_revision ~ '^[0-9a-f]{64}$'),
  status text not null default 'queued' check (status in ('queued', 'analyzing', 'awaiting_scope_confirmation', 'generating', 'applying', 'validating', 'awaiting_review', 'completed', 'failed', 'cancelled')),
  resume_cursor jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  lock_version bigint not null default 0 check (lock_version >= 0),
  state jsonb not null default '{}'::jsonb,
  unique (id, owner_user_id),
  foreign key (task_id, owner_user_id) references public.tasks(id, owner_user_id) on delete cascade,
  foreign key (working_document_id, owner_user_id) references public.working_documents(id, owner_user_id) on delete cascade
);

create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  working_document_id uuid not null,
  parent_version_id uuid,
  version_number bigint not null check (version_number >= 0),
  origin text not null check (origin in ('import', 'user', 'agent', 'restore')),
  object_key text not null unique,
  manifest_object_key text not null unique,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  engine_version text not null,
  created_by_run_id uuid,
  validation jsonb not null default '{}'::jsonb,
  operation_log jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (working_document_id, version_number),
  unique (id, owner_user_id),
  foreign key (working_document_id, owner_user_id) references public.working_documents(id, owner_user_id) on delete cascade,
  foreign key (parent_version_id, owner_user_id) references public.document_versions(id, owner_user_id) on delete no action,
  foreign key (created_by_run_id, owner_user_id) references public.agent_runs(id, owner_user_id) on delete no action
);

alter table public.working_documents
  add constraint working_documents_current_version_fk
  foreign key (current_version_id, owner_user_id) references public.document_versions(id, owner_user_id) on delete restrict;

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null,
  kind text not null check (kind in ('generated_image', 'uploaded_image', 'preview')),
  object_key text not null unique,
  mime_type text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  provider text,
  provider_request_id text,
  prompt text,
  created_at timestamptz not null default now(),
  unique (id, owner_user_id),
  foreign key (task_id, owner_user_id) references public.tasks(id, owner_user_id) on delete cascade
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null,
  created_at timestamptz not null default now(),
  unique (task_id),
  unique (id, owner_user_id),
  foreign key (task_id, owner_user_id) references public.tasks(id, owner_user_id) on delete cascade
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null,
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  parts jsonb not null,
  run_id uuid,
  created_at timestamptz not null default now(),
  unique (id, owner_user_id),
  foreign key (conversation_id, owner_user_id) references public.conversations(id, owner_user_id) on delete cascade,
  foreign key (run_id, owner_user_id) references public.agent_runs(id, owner_user_id) on delete no action
);

create table public.agent_steps (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null,
  name text not null,
  idempotency_key text not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'awaiting_user', 'completed', 'failed', 'skipped', 'cancelled')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  input_ref jsonb not null default '{}'::jsonb,
  output_ref jsonb not null default '{}'::jsonb,
  side_effect_receipt jsonb,
  error jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, idempotency_key),
  unique (id, owner_user_id),
  foreign key (run_id, owner_user_id) references public.agent_runs(id, owner_user_id) on delete cascade
);

create table public.agent_effect_receipts (
  idempotency_key text primary key,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null,
  step_id text not null,
  effect text not null check (effect in ('analyze', 'generate', 'apply', 'validate')),
  receipt jsonb not null,
  created_at timestamptz not null default now(),
  foreign key (run_id, owner_user_id) references public.agent_runs(id, owner_user_id) on delete cascade
);

create table public.agent_run_events (
  id text primary key,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null,
  sequence bigint not null check (sequence > 0),
  event jsonb not null,
  occurred_at timestamptz not null,
  unique (run_id, sequence),
  foreign key (run_id, owner_user_id) references public.agent_runs(id, owner_user_id) on delete cascade
);

create table public.hitl_requests (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null,
  base_revision text not null check (base_revision ~ '^[0-9a-f]{64}$'),
  status text not null default 'open' check (status in ('open', 'approved', 'rejected', 'superseded', 'cancelled')),
  proposal jsonb not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (id, owner_user_id),
  foreign key (run_id, owner_user_id) references public.agent_runs(id, owner_user_id) on delete cascade
);

create table public.hitl_decisions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null unique,
  base_revision text not null check (base_revision ~ '^[0-9a-f]{64}$'),
  decision text not null check (decision in ('approve', 'reject', 'revise')),
  frozen_payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (id, owner_user_id),
  foreign key (request_id, owner_user_id) references public.hitl_requests(id, owner_user_id) on delete restrict
);

create table public.exports (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null,
  version_id uuid not null,
  object_key text not null unique,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'ready' check (status in ('preparing', 'ready', 'failed', 'expired')),
  created_at timestamptz not null default now(),
  unique (id, owner_user_id),
  foreign key (task_id, owner_user_id) references public.tasks(id, owner_user_id) on delete cascade,
  foreign key (version_id, owner_user_id) references public.document_versions(id, owner_user_id) on delete restrict
);

create index tasks_owner_updated_idx on public.tasks(owner_user_id, updated_at desc);
create index source_files_task_idx on public.source_files(task_id);
create index document_versions_document_idx on public.document_versions(working_document_id, version_number desc);
create index agent_runs_task_idx on public.agent_runs(task_id, created_at desc);
create index agent_runs_status_idx on public.agent_runs(status) where status not in ('completed', 'failed', 'cancelled');
create index agent_steps_run_idx on public.agent_steps(run_id, created_at);
create index hitl_requests_open_idx on public.hitl_requests(run_id) where status = 'open';
create index messages_conversation_idx on public.messages(conversation_id, created_at);

alter table public.workspaces enable row level security;
alter table public.tasks enable row level security;
alter table public.source_files enable row level security;
alter table public.working_documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.assets enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.agent_runs enable row level security;
alter table public.agent_steps enable row level security;
alter table public.agent_effect_receipts enable row level security;
alter table public.agent_run_events enable row level security;
alter table public.hitl_requests enable row level security;
alter table public.hitl_decisions enable row level security;
alter table public.exports enable row level security;

create policy workspaces_owner_all on public.workspaces for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy tasks_owner_all on public.tasks for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy source_files_owner_all on public.source_files for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy working_documents_owner_all on public.working_documents for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy document_versions_owner_all on public.document_versions for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy assets_owner_all on public.assets for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy conversations_owner_all on public.conversations for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy messages_owner_all on public.messages for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy agent_runs_owner_all on public.agent_runs for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy agent_steps_owner_all on public.agent_steps for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy agent_effect_receipts_owner_all on public.agent_effect_receipts for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy agent_run_events_owner_all on public.agent_run_events for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy hitl_requests_owner_all on public.hitl_requests for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy hitl_decisions_owner_all on public.hitl_decisions for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
create policy exports_owner_all on public.exports for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'paperduck-private',
  'paperduck-private',
  false,
  20971520,
  array[
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/json',
    'image/png',
    'image/jpeg',
    'image/webp'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy paperduck_storage_insert
on storage.objects for insert to authenticated
with check (
  bucket_id = 'paperduck-private'
  and (storage.foldername(name))[1] = 'users'
  and (storage.foldername(name))[2] = (select auth.uid()::text)
);

create policy paperduck_storage_select
on storage.objects for select to authenticated
using (
  bucket_id = 'paperduck-private'
  and owner_id = (select auth.uid()::text)
  and (storage.foldername(name))[1] = 'users'
  and (storage.foldername(name))[2] = (select auth.uid()::text)
);

create policy paperduck_storage_delete
on storage.objects for delete to authenticated
using (
  bucket_id = 'paperduck-private'
  and owner_id = (select auth.uid()::text)
  and (storage.foldername(name))[1] = 'users'
  and (storage.foldername(name))[2] = (select auth.uid()::text)
);

create or replace function public.register_source_and_import(
  p_task_id uuid,
  p_role text,
  p_original_name text,
  p_object_key text,
  p_mime_type text,
  p_byte_length bigint,
  p_sha256 text,
  p_inspection jsonb,
  p_manifest_object_key text,
  p_engine_version text
)
returns table(source_file_id uuid, working_document_id uuid, version_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_source uuid;
  v_working uuid;
  v_version uuid;
begin
  if v_owner is null or not exists (
    select 1 from public.tasks t where t.id = p_task_id and t.owner_user_id = v_owner
  ) then
    raise exception 'TASK_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.source_files (
    owner_user_id, task_id, role, original_name, object_key, mime_type,
    byte_length, sha256, inspection
  ) values (
    v_owner, p_task_id, p_role, p_original_name, p_object_key, p_mime_type,
    p_byte_length, p_sha256, p_inspection
  ) returning id into v_source;

  if p_role in ('template', 'example') then
    insert into public.working_documents (owner_user_id, task_id)
      values (v_owner, p_task_id)
      on conflict (task_id) do nothing;

    select wd.id into v_working
      from public.working_documents wd
      where wd.task_id = p_task_id and wd.owner_user_id = v_owner;

    if exists (
      select 1 from public.working_documents wd
      where wd.id = v_working and wd.current_version_id is null
    ) then
      insert into public.document_versions (
        owner_user_id, working_document_id, version_number, origin, object_key,
        manifest_object_key, sha256, engine_version, validation
      ) values (
        v_owner, v_working, 0, 'import', p_object_key,
        p_manifest_object_key, p_sha256, p_engine_version,
        jsonb_build_object('status', 'inspected', 'inspection', p_inspection)
      ) returning id into v_version;

      update public.working_documents
        set current_version_id = v_version, revision = revision + 1, updated_at = now()
        where id = v_working and owner_user_id = v_owner and current_version_id is null;
    end if;
  end if;

  return query select v_source, v_working, v_version;
end;
$$;

revoke all on function public.register_source_and_import(uuid, text, text, text, text, bigint, text, jsonb, text, text) from public, anon;
grant execute on function public.register_source_and_import(uuid, text, text, text, text, bigint, text, jsonb, text, text) to authenticated;

create or replace function public.save_agent_run(
  p_run_id uuid,
  p_expected_version bigint,
  p_state jsonb,
  p_events jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_event jsonb;
begin
  update public.agent_runs
  set
    status = p_state->>'status',
    base_revision = p_state->>'baseRevision',
    resume_cursor = coalesce(p_state->'checkpoint', '{}'::jsonb),
    error_code = p_state->'failure'->>'code',
    error_message = p_state->'failure'->>'message',
    lock_version = (p_state->>'version')::bigint,
    state = p_state,
    started_at = case when started_at is null and p_state->>'status' <> 'queued' then now() else started_at end,
    finished_at = case when p_state->>'status' in ('completed', 'failed', 'cancelled') then now() else null end,
    updated_at = now()
  where id = p_run_id
    and owner_user_id = v_owner
    and lock_version = p_expected_version;

  if not found then
    raise exception 'AGENT_RUN_CONFLICT' using errcode = '40001';
  end if;

  for v_event in select value from jsonb_array_elements(coalesce(p_events, '[]'::jsonb))
  loop
    insert into public.agent_run_events (
      id, owner_user_id, run_id, sequence, event, occurred_at
    ) values (
      v_event->>'id', v_owner, p_run_id, (v_event->>'sequence')::bigint,
      v_event, (v_event->>'occurredAt')::timestamptz
    );
  end loop;

  return p_state;
end;
$$;

create or replace function public.save_effect_receipt(
  p_run_id uuid,
  p_receipt jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_existing jsonb;
begin
  if not exists (
    select 1 from public.agent_runs r where r.id = p_run_id and r.owner_user_id = v_owner
  ) then
    raise exception 'RUN_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.agent_effect_receipts (
    idempotency_key, owner_user_id, run_id, step_id, effect, receipt
  ) values (
    p_receipt->>'idempotencyKey', v_owner, p_run_id,
    p_receipt->>'stepId', p_receipt->>'effect', p_receipt
  ) on conflict (idempotency_key) do nothing;

  select receipt into v_existing
  from public.agent_effect_receipts
  where idempotency_key = p_receipt->>'idempotencyKey'
    and owner_user_id = v_owner
    and run_id = p_run_id;

  if v_existing is null then
    raise exception 'EFFECT_RECEIPT_CONFLICT' using errcode = '23505';
  end if;
  return v_existing;
end;
$$;

create or replace function public.get_current_document_revision(p_document_id uuid)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select v.sha256
  from public.working_documents d
  join public.document_versions v on v.id = d.current_version_id
  where d.id = p_document_id and d.owner_user_id = auth.uid()
$$;

create or replace function public.commit_derived_document_version(
  p_run_id uuid,
  p_expected_run_version bigint,
  p_document_id uuid,
  p_expected_revision text,
  p_derived_revision text,
  p_output_ref text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_run public.agent_runs%rowtype;
  v_document public.working_documents%rowtype;
  v_current public.document_versions%rowtype;
  v_existing public.document_versions%rowtype;
  v_created uuid;
  v_output jsonb;
begin
  select * into v_run from public.agent_runs
  where id = p_run_id and owner_user_id = v_owner for update;
  if not found then raise exception 'RUN_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_run.status = 'cancelled' then return jsonb_build_object('kind', 'run-cancelled'); end if;
  if v_run.lock_version <> p_expected_run_version or v_run.status <> 'applying' then
    raise exception 'AGENT_RUN_CONFLICT' using errcode = '40001';
  end if;

  select * into v_existing from public.document_versions
  where created_by_run_id = p_run_id and sha256 = p_derived_revision
  order by created_at asc limit 1;
  if found then
    return jsonb_build_object('kind', 'committed', 'versionRef', v_existing.id);
  end if;

  select * into v_document from public.working_documents
  where id = p_document_id and owner_user_id = v_owner for update;
  if not found then raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_current from public.document_versions
  where id = v_document.current_version_id and owner_user_id = v_owner;
  if not found or v_current.sha256 <> p_expected_revision then
    return jsonb_build_object(
      'kind', 'revision-conflict',
      'actualRevision', coalesce(v_current.sha256, '')
    );
  end if;

  v_output := p_output_ref::jsonb;
  insert into public.document_versions (
    owner_user_id, working_document_id, parent_version_id, version_number,
    origin, object_key, manifest_object_key, sha256, engine_version,
    created_by_run_id, operation_log
  ) values (
    v_owner, p_document_id, v_current.id, v_current.version_number + 1,
    'agent', v_output->>'objectKey', v_output->>'manifestObjectKey',
    p_derived_revision, 'paperduck-ooxml-v1', p_run_id,
    coalesce(v_output->'operationLog', '[]'::jsonb)
  ) returning id into v_created;

  update public.working_documents
  set current_version_id = v_created, revision = revision + 1, updated_at = now()
  where id = p_document_id and owner_user_id = v_owner and current_version_id = v_current.id;
  if not found then
    raise exception 'DOCUMENT_COMMIT_CONFLICT' using errcode = '40001';
  end if;

  return jsonb_build_object('kind', 'committed', 'versionRef', v_created);
end;
$$;

revoke all on function public.save_agent_run(uuid, bigint, jsonb, jsonb) from public, anon;
revoke all on function public.save_effect_receipt(uuid, jsonb) from public, anon;
revoke all on function public.get_current_document_revision(uuid) from public, anon;
revoke all on function public.commit_derived_document_version(uuid, bigint, uuid, text, text, text, text) from public, anon;
grant execute on function public.save_agent_run(uuid, bigint, jsonb, jsonb) to authenticated;
grant execute on function public.save_effect_receipt(uuid, jsonb) to authenticated;
grant execute on function public.get_current_document_revision(uuid) to authenticated;
grant execute on function public.commit_derived_document_version(uuid, bigint, uuid, text, text, text, text) to authenticated;

grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.workspaces,
  public.tasks,
  public.source_files,
  public.working_documents,
  public.document_versions,
  public.assets,
  public.conversations,
  public.messages,
  public.agent_runs,
  public.agent_steps,
  public.agent_effect_receipts,
  public.agent_run_events,
  public.hitl_requests,
  public.hitl_decisions,
  public.exports
to authenticated;

revoke all on all tables in schema public from anon;

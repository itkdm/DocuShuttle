create table if not exists public.image_generation_jobs (
  id uuid primary key,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null,
  run_id uuid not null,
  call_id text not null,
  idempotency_key text not null unique,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  provider text not null,
  model text,
  status text not null check (status in ('created','submitting','submitted','completed','failed','ambiguous')),
  provider_task_id text,
  candidate_asset_id uuid not null,
  safe_request jsonb not null default '{}'::jsonb,
  result jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, call_id),
  foreign key (task_id, owner_user_id) references public.tasks(id, owner_user_id) on delete cascade,
  foreign key (run_id, owner_user_id) references public.agent_runs(id, owner_user_id) on delete cascade
);
create index if not exists image_generation_jobs_owner_idx on public.image_generation_jobs(owner_user_id, created_at desc);
create index if not exists image_generation_jobs_run_idx on public.image_generation_jobs(run_id);
alter table public.image_generation_jobs enable row level security;
drop policy if exists image_generation_jobs_owner_all on public.image_generation_jobs;
create policy image_generation_jobs_owner_all on public.image_generation_jobs for all to authenticated using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);

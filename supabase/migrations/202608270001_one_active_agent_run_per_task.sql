-- A task is a single Conversation/Thread.  Runs remain immutable records,
-- but only one run may own the active turn at a time.  This closes the race
-- where two browser requests both read the same completed run and fork the
-- next conversation turn before either insert becomes visible.
create unique index if not exists agent_runs_one_active_per_task_idx
  on public.agent_runs(task_id)
  where status in (
    'queued', 'analyzing', 'awaiting_scope_confirmation', 'generating',
    'applying', 'validating', 'awaiting_review'
  );

*** Delete File: D:\develop\project\纸上鸭\supabase\migrations\202608260010_one_active_agent_run_per_task.sql

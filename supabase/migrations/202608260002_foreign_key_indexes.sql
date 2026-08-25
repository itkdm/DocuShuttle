-- Cover ownership and composite foreign-key lookups used by RLS and cascading deletes.

create index workspaces_owner_idx on public.workspaces(owner_user_id);
create index tasks_workspace_owner_idx on public.tasks(workspace_id, owner_user_id);
create index source_files_owner_idx on public.source_files(owner_user_id);
create index source_files_task_owner_idx on public.source_files(task_id, owner_user_id);

create index working_documents_owner_idx on public.working_documents(owner_user_id);
create index working_documents_task_owner_idx on public.working_documents(task_id, owner_user_id);
create index working_documents_current_version_owner_idx on public.working_documents(current_version_id, owner_user_id);

create index document_versions_owner_idx on public.document_versions(owner_user_id);
create index document_versions_working_owner_idx on public.document_versions(working_document_id, owner_user_id);
create index document_versions_parent_owner_idx on public.document_versions(parent_version_id, owner_user_id);
create index document_versions_run_owner_idx on public.document_versions(created_by_run_id, owner_user_id);

create index assets_owner_idx on public.assets(owner_user_id);
create index assets_task_owner_idx on public.assets(task_id, owner_user_id);
create index conversations_owner_idx on public.conversations(owner_user_id);
create index conversations_task_owner_idx on public.conversations(task_id, owner_user_id);

create index messages_owner_idx on public.messages(owner_user_id);
create index messages_conversation_owner_idx on public.messages(conversation_id, owner_user_id);
create index messages_run_owner_idx on public.messages(run_id, owner_user_id);

create index agent_runs_owner_idx on public.agent_runs(owner_user_id);
create index agent_runs_task_owner_idx on public.agent_runs(task_id, owner_user_id);
create index agent_runs_document_owner_idx on public.agent_runs(working_document_id, owner_user_id);
create index agent_steps_owner_idx on public.agent_steps(owner_user_id);
create index agent_steps_run_owner_idx on public.agent_steps(run_id, owner_user_id);
create index agent_effect_receipts_owner_idx on public.agent_effect_receipts(owner_user_id);
create index agent_effect_receipts_run_owner_idx on public.agent_effect_receipts(run_id, owner_user_id);
create index agent_run_events_owner_idx on public.agent_run_events(owner_user_id);
create index agent_run_events_run_owner_idx on public.agent_run_events(run_id, owner_user_id);

create index hitl_requests_owner_idx on public.hitl_requests(owner_user_id);
create index hitl_requests_run_owner_idx on public.hitl_requests(run_id, owner_user_id);
create index hitl_decisions_owner_idx on public.hitl_decisions(owner_user_id);
create index hitl_decisions_request_owner_idx on public.hitl_decisions(request_id, owner_user_id);

create index exports_owner_idx on public.exports(owner_user_id);
create index exports_task_owner_idx on public.exports(task_id, owner_user_id);
create index exports_version_owner_idx on public.exports(version_id, owner_user_id);

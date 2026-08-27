# PaperDuck observability

PaperDuck keeps three streams separate: Engineering Log is structured diagnostic/performance data, Agent Trace is the user-visible resumable execution timeline, and Business Event is the durable audit/state-machine stream. Engineering logs may correlate with the other streams by IDs but never replace them.

The server logger lives in `src/infrastructure/observability`. It uses Pino, AsyncLocalStorage context, centralized redaction, and `measure()`/`createTimer()` for consistent durations. Stable dotted events use the form `area.operation.outcome`, such as `http.request.completed`, `agent.model.failed`, and `document.inspect.completed`. Context fields include `requestId`, `taskId`, `runId`, `conversationId`, `documentId`, `callId`, `toolName`, `revision`, and `versionId`.

Development writes NDJSON to `.paperduck/logs/` and emits trace-level console output. Production writes JSON to stdout at info level and never creates local log files. Sensitive fields are summarized by length or redacted; content preview is development-only and opt-in with `PAPERDUCK_LOG_CONTENT=preview`.

Use `pnpm logs:summary`, `pnpm logs:slow`, `pnpm logs:errors`, or `pnpm logs:trace <id>` to inspect local NDJSON without a database. Future OpenTelemetry integration should adapt this logger/context boundary to spans and exporters; Pino remains the stable application API until trace sampling and deployment exporters are defined.

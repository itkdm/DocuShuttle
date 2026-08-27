# PaperDuck observability

PaperDuck keeps four boundaries separate: Checkpoint is the resumable execution snapshot,
EventStore is the durable structural activity projection, Live Stream is transient connection
transport, and Engineering Log is structured diagnostic/performance data. Logs may correlate
with the other boundaries by IDs but never replace them.

The server logger lives in `src/infrastructure/observability`. It uses Pino, AsyncLocalStorage context, centralized redaction, and `measure()`/`createTimer()` for consistent durations. Stable dotted events use the form `area.operation.outcome`, such as `http.request.completed`, `agent.model.failed`, and `document.inspect.completed`. Context fields include `requestId`, `taskId`, `runId`, `conversationId`, `documentId`, `callId`, `toolName`, `revision`, and `versionId`.

Development writes NDJSON to `.paperduck/logs/` and emits trace-level console output. Production writes JSON to stdout at info level and never creates local log files. Sensitive fields are summarized by length or redacted; content preview is development-only and opt-in with `PAPERDUCK_LOG_CONTENT=preview`.

Slow thresholds are centralized in `server/logger.ts`; `measure()` emits both the completed record with `slow: true` and a dedicated `.slow` warning when a threshold is exceeded. Log sinks are injectable in tests and can later be adapted to OpenTelemetry without changing application call sites.

Use `pnpm logs:summary`, `pnpm logs:slow`, `pnpm logs:errors`, or `pnpm logs:trace <id>` to inspect local NDJSON without a database. Future OpenTelemetry integration should adapt this logger/context boundary to spans and exporters; Pino remains the stable application API until trace sampling and deployment exporters are defined.

# Agent Execution Trace V1

This directory contains development-only, local forensic records for real PaperDuck Agent runs. Trace files use `schemaVersion: 1` and are safe to commit when they contain only test data.

Each run contains `run.json`, `conversation-history.json`, `trace.ndjson`, and materialized `iterations/NNN.json` files. The intended layers are:

- `durableConversationHistory`: the complete read-only semantic conversation history.
- `runtimeLoadedHistory`: the bounded history actually returned to the Runner.
- `freshRunSeed`: the exact result of the existing compaction policy used to seed a fresh checkpoint.
- Iteration files: checkpoint before compaction, exact model input after compaction, provider request, model decision, and tool raw/model/event-facing outputs.

Trace is separate from Checkpoint, EventStore, Conversation Messages, and Engineering Logs. It records facts only and never changes the runtime context or policy. Credentials, signed URLs, object keys, binary bytes, base64 image data, and private reasoning are redacted or described by metadata.

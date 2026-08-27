# PaperDuck architecture rules

## Dependency direction

Use the dependency flow `UI/API -> application use cases -> domain -> ports`, with provider adapters implementing ports. Domain and application code must not import Supabase, OSS, DeepSeek, APIMart, Vercel, Cloudflare, or a concrete DOCX engine.

Keep Next.js route handlers thin: validate/authenticate input, call one use case, translate the result. Do not place workflow orchestration, OOXML mutation, or provider retry logic in routes or React components.

## Bounded contexts

- **Identity and tenancy** owns users, anonymous sessions, workspaces, and RLS ownership.
- **Documents** owns source assets, Working Documents, stable block/selection identity, versions, exports, and provenance.
- **Agent runs** owns plans, steps, checkpoints, tool calls, resumability, usage, and terminal status.
- **Review** owns proposals, confidence, keep/regenerate/uncertain classifications, HITL decisions, comments, and acceptance.
- **Generation** owns provider-neutral text/image requests, policy, structured outputs, retries, and cost records.

Cross-context communication uses IDs and explicit use-case DTOs. Avoid shared mutable provider objects and database-row-shaped domain models.

## Document engine boundary

Define a provider-neutral document engine port before adopting SuperDoc or custom OOXML code. It must cover import/inspect, stable addressing, text/table/image mutation, render/preview, export, reopen validation, diagnostics, and capability reporting.

Keep original DOCX bytes immutable. Every mutation creates a derived artifact or version. Record the source checksum, engine/version, operation log, and output checksum so a result can be reproduced and audited.

For OOXML source indexing, use a namespace-aware, source-preserving tree with one documented coordinate system (currently JavaScript UTF-16 code-unit offsets). Keep raw source spans and unknown XML in infrastructure; semantic nodes and Agent tools must not depend on parser AST types. Never use a generic XML serializer for an authoritative write path.

Do not claim format fidelity from HTML preview alone. Inspect the exported OOXML package and reopen the DOCX. Where visual rendering is available, compare representative pages as an additional signal.

## Agent execution

Model each run as a persisted, resumable state machine rather than one long serverless request. Suggested states are `queued`, `analyzing`, `awaiting_confirmation`, `generating`, `applying`, `verifying`, `completed`, `failed`, and `cancelled`; transitions must be explicit and idempotent.

Each side effect needs an idempotency key. Persist checkpoints before acknowledging progress. Retrying a step must not duplicate versions, uploads, proposals, usage records, or provider charges.

Treat model output as untrusted structured input. Validate schemas, limit operations to the current document and user, and require confirmation for low-confidence or broad destructive changes.

## Data and storage

Supabase PostgreSQL stores metadata, state, decisions, and audit records. A private Supabase Storage bucket stores source DOCX, derived DOCX, previews, manifests, and generated media. Store object keys rather than public URLs; issue short-lived signed URLs after authorization.

Uploads should go directly from the browser to Supabase Storage through signed upload URLs. Enforce bucket RLS, size, extension, MIME signature, tenant prefix, expiration, and checksum. Do not proxy large document bodies through Vercel functions.

Enable RLS on every user-owned table and test cross-user denial. Service-role access is server-only and must remain narrow and auditable.

## Provider configuration

Centralize provider/model selection, timeouts, retry policy, and limits. Keep model names out of UI components and domain logic. Normalize provider errors into stable application error types while preserving redacted diagnostics for logs.

Use explicit budgets for prompt size, output size, image generation, run duration, retries, and stored artifacts. A partial failure must be resumable or reversible from the latest checkpoint.

# PaperDuck quality gates

## Real DOCX fixture matrix

Use the workspace's real documents plus sanitized repository fixtures. At minimum cover:

- a blank table-based template;
- the matching completed example with an image;
- a generated or derived template;
- the larger multi-table, multi-image experiment report.

Never commit a fixture until it has been checked for personal data and secrets. Keep sensitive originals local and generate sanitized equivalents for CI.

## Document engine acceptance

For each representative DOCX:

1. Open and enumerate paragraphs, runs, tables, relationships, headers/footers, media, styles, sections, and unsupported constructs.
2. Apply targeted text, table-cell, and image operations without unrelated changes.
3. Export, reopen, and repeat a second edit round.
4. Verify ZIP/package integrity, relationship targets, XML validity, stable addressing, and absence of lost required parts.
5. Compare structural fingerprints before/after and inspect visual pages where a renderer is available.
6. Report unsupported or changed constructs plainly; do not silently flatten them.

Adopt an external engine only if it passes this matrix, supports the production runtime, has an acceptable recorded license path, and remains replaceable behind the port.

## Automated test layers

- Unit tests cover domain rules, state transitions, address resolution, validation, and provider error mapping.
- Contract tests run each adapter against deterministic fakes and, where credentials exist, a narrow live smoke test.
- Integration tests cover database migrations/RLS, signed-upload constraints, checkpoint/idempotency behavior, and document round trips.
- Browser tests cover upload, analysis, HITL review, generation progress, editing/version recovery, export, refresh/resume, cancellation, and visible error recovery.

Tests must assert outputs and durable state, not only status codes or screenshots.

## Review and release

- Run formatting, linting, type checking, unit/integration tests, production build, dependency/license audit, and secret scan.
- Use an independent reviewer for architecture-sensitive or broad changes. Resolve findings or record an explicit exception.
- Before declaring the product complete, use DevTools MCP against the deployed PaperDuck site and execute the full real user flow. Inspect the DOM, console, network, API responses, persistent state, refresh/resume behavior, and exported DOCX; an isolated browser without third-party console login state is not a reason to skip PaperDuck testing.
- Verify the deployed production URL, core flow, API health, logs, database writes, private Storage objects, and exported DOCX.
- Confirm Cloudflare and Vercel routing, HTTPS, environment separation, least-privilege credentials, RLS, upload limits, rate limits, and safe error messages.
- Record deployment identity, migration version, rollback procedure, known limitations, and any browser step requiring the user.

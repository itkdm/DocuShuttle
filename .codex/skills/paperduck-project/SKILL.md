---
name: paperduck-project
description: Guard PaperDuck product development and deployment. Use for any task that changes this repository's requirements, architecture, DOCX engine, Agent workflow, data model, tests, integrations, or production deployment.
---

# PaperDuck Project

## Product goal

Build PaperDuck (纸上鸭) as a production Word document agent, not a demo. A user supplies a template, an example, or both; the system creates a Working Document, identifies what to keep or regenerate, asks for targeted human confirmation, generates and edits content, preserves versions, verifies the result, and exports a high-fidelity DOCX. The release target is a live `itkdm.com` subdomain.

## Authority order

When sources disagree, use this order:

1. The user's latest explicit decision.
2. Current canonical product, architecture, and ADR documents in this repository.
3. Executable tests and observations from the repository's real DOCX fixtures.
4. Current official documentation for external services and libraries.
5. Historical documents under audit or archive directories.

Never treat the historical remote repository as authoritative without reconciling it with the current documents.

## Non-negotiable invariants

- Keep the product Agent-first and Document-native. The document is the shared artifact; chat is a control surface.
- Preserve stable document selection/block identities across analysis, confirmation, regeneration, versions, and export.
- Make uncertain or destructive edits explicit HITL decisions. Persist every accepted decision and checkpoint.
- Use TypeScript end to end with Next.js Fullstack on Vercel, Supabase for PostgreSQL/Auth/RLS/private Storage, DeepSeek for text reasoning, and GPT Image 2 through APIMart for images.
- Put Cloudflare in front for DNS and edge protection. Do not introduce Docker into the required development or deployment path.
- Keep secrets only in ignored local or managed environment variables. Never print, commit, copy into fixtures, or expose credentials from the private local configuration document.
- Do not add a fixed paid-license dependency. A copyleft engine is acceptable only after a recorded product/license decision and successful real-document testing.

## Required workflow

1. Before choosing architecture, APIs, libraries, or interaction patterns, research their current official documentation and relevant production products. Record decisions that could become stale in an ADR.
2. Read [architecture-rules.md](references/architecture-rules.md) before changing application boundaries, providers, persistence, or the document engine.
3. Read [quality-gates.md](references/quality-gates.md) before implementation or release verification.
4. For independently bounded work, use parallel subagents when requested: assign disjoint scopes, keep shared-file ownership explicit, use a separate reviewer for material changes, and let the primary agent integrate and verify.
5. Make the smallest coherent vertical slice, then prove it through the real document lifecycle. Do not count mock-only or unit-only success as feature completion.
6. If browser login state or an external console blocks UI automation, continue all safe code/API verification and report the exact remaining manual action instead of weakening the acceptance criteria.

## Active delivery contract

This project is being delivered as a complete production product, not as a visual prototype. The current objective is the live PaperDuck product on an `itkdm.com` subdomain, with the product requirements in `docs/product/prd.md` treated as the feature source of truth.

- The Agent must use a provider-neutral model-driven Tool Loop. A fixed `analyze → generate → apply → validate` route may remain only as a compatibility transaction boundary while its capabilities are migrated into tools; it must not decide the user's semantic workflow.
- Agent tools must be independently composable and typed, with explicit read/write/approval capabilities. Document writes always go through the document engine, immutable derived versions, validation, and revision CAS.
- Every vertical slice must include its use case, adapter boundary, failure behavior, durable state, documentation, tests, and a real DOCX fixture round trip. Mock-only UI success is never completion evidence.
- Keep layers `UI/API → application → domain → ports → adapters`; do not put provider calls, OOXML mutation, orchestration, or persistence policy in React components or route handlers.
- Use parallel subagents for disjoint implementation and review scopes when available. The primary agent owns integration, shared-file conflict resolution, final tests, and release decisions. A reviewer must inspect architecture-sensitive changes before release.
- Research current official documentation and comparable products before making framework or interaction decisions. Record durable decisions in ADRs with links and a reason for not adopting alternatives.
- During the current delivery phase, browser automation may be temporarily skipped by explicit user instruction. Substitute deterministic API, fixture, export/reopen, persistence, and simulated browser-state checks; retain the browser acceptance checklist and report it as an outstanding release gate rather than claiming it passed.
- Deployment is part of the objective: verify Vercel build configuration, Supabase migrations/RLS/Storage, Cloudflare DNS and HTTPS, environment variables, health checks, and rollback information. Any console action that requires the user must be listed with the exact values and expected result.

## Definition of done

A feature is complete only when implementation, relevant automated tests, failure handling, documentation, and real-fixture validation agree. Production work additionally requires a successful deployed flow, observability sufficient to diagnose failures, no leaked secrets, and a documented rollback path.

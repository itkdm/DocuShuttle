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

## Definition of done

A feature is complete only when implementation, relevant automated tests, failure handling, documentation, and real-fixture validation agree. Production work additionally requires a successful deployed flow, observability sufficient to diagnose failures, no leaked secrets, and a documented rollback path.

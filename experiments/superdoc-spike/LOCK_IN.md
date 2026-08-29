# Lock-in and Adoption Gates

## Current recommendation

**Conditional no-go for production replacement.** SuperDoc v2 is technically viable as an isolated editor/adapter candidate for basic DOCX editing, but the spike does not establish production-grade OOXML fidelity or licensing clearance.

## Evidence and limitations

- Browser package tested: `superdoc` 2.10.0. It loaded a real Chinese, table-heavy DOCX in Chrome, accepted a keyboard edit, and exported a non-empty DOCX.
- Headless package exercised by the existing POC: `@superdoc/sdk` 2.5.0. Its public APIs handled text search/replacement, table cell edits, image replacement/alt text, save, reopen, and inspection across four real DOCX fixtures.
- Current registry versions were queried on 2026-08-29: `superdoc` 2.10.0, `@superdoc/sdk` 2.7.0, and `@superdoc/react` 2.5.0. The headless POC was not silently upgraded because the local pnpm install was blocked by the repository's safe-delete hook; this version gap must be closed before any adoption decision.
- Package round-trip diff found removed `word/footnotes.xml` and `word/endnotes.xml` parts in the completed and derived fixtures, plus relationship/content-type changes. The source parts are present and non-empty. This is a fidelity blocker until SuperDoc behavior is explained or preserved.
- Tracked replacement survived save/reopen, but `trackChanges.decide()` returned `TARGET_NOT_FOUND` for a generated tracked-change ID in SDK 2.5. The POC therefore records direct mutation separately; approval/review semantics are not proven.
- Browser load of the completed fixture took about 12.4 seconds in the local DevTools run. This is a spike observation, not a production performance benchmark.
- Browser page screenshots were captured through Chrome DevTools MCP at page 1 and a middle scroll position. The observed page boundary is a SuperDoc DOM class, not a stable PaperDuck contract.

## Required gates before a real adapter

1. Confirm the exact package versions and public API behavior after a clean install.
2. Resolve the AGPLv3/commercial-license decision with project counsel/owner. This is not a legal determination: the official project states that open-source use is AGPLv3 and proprietary/commercial deployment requires its commercial licensing path.
3. Build a provider-neutral adapter behind `DocumentEnginePort`; do not expose SuperDoc types.
4. Define an OOXML fidelity corpus including headers/footers, comments, footnotes/endnotes, numbering, drawings, embedded objects, tracked changes, fields, and custom XML.
5. Compare source and exported packages structurally and visually, with explicit allowlists for intentional changes.
6. Prove approval/review operations, concurrent revision behavior, atomic save, and rollback against PaperDuck contracts.
7. Establish browser capture through a supported API or accept and isolate the DOM fallback.

## Replacement risk

Adapter replacement is bounded because no production dependency or persisted format has changed. The principal risks are OOXML part loss, review semantics, performance, and license obligations—not runtime integration coupling.

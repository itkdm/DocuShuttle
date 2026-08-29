# SuperDoc Adoption Gate

Date: 2026-08-29
Branch: `feature/spike-superdoc-adoption-gate`
Scope: validation only; production `docx-preview` remains unchanged.

## Decision

**LIMITED_GO** for a future, capability-aware adapter only. **Not approved for a silent production replacement.** Basic DOCX browser editing/export and headless text/table/image operations are viable, but latest Node SDK execution on Windows is blocked by the missing official platform binary, and a real footnote/endnote fixture was unavailable in this environment. Those gates must be closed before implementation.

## A. Versions and public API

| Surface | Result |
| --- | --- |
| Browser | `superdoc` 2.10.0; browser load/edit/export verified in Chrome |
| Headless declaration | `@superdoc/sdk` 2.7.0 |
| Headless executable actually available | 2.5.0 Windows runtime only, used as a compatibility comparison |
| React | Not installed or used; official package is `@superdoc/react` |
| Public API | `SuperDoc`, `SuperDocClient`, `doc.info`, `doc.blocks.list`, `doc.find`, `doc.replace`, `doc.tables.setCellText`, `doc.images.*`, `doc.footnotes.list`, `doc.trackChanges.*`, `doc.save`, `doc.export` |

The official docs recommend `@superdoc/sdk` for Node.js and explicitly exclude `@superdoc/headless` and `@superdoc/document-api-v2-adapter`. The 2.7.0 SDK package declares a Windows optional binary, but the registry currently exposes `@superdoc/sdk-windows-x64` only through 2.5.0. Running the declared latest package therefore fails with `CLI_BINARY_MISSING` (`target: windows-x64`, `packageName: @superdoc/sdk-windows-x64`). This is an environment/package publication blocker, not an inferred engine defect.

## B. Semantic footnote audit

The new `audit:notes` script inspects `word/document.xml`, note parts, relationships, and content types rather than equating ZIP-part removal with semantic loss.

For the three available real fixtures and their SuperDoc round-trips:

| Fixture | Source refs | Export refs | Semantic loss |
| --- | ---: | ---: | --- |
| completed example | footnote 0, endnote 0 | footnote 0, endnote 0 | No evidence of user-note loss |
| derived template | footnote 0, endnote 0 | footnote 0, endnote 0 | No evidence of user-note loss |
| large report | footnote 0, endnote 0 | footnote 0, endnote 0 | No evidence of user-note loss |

The source packages contain reserved/empty note parts but no body references. The package diff still reports those reserved parts removed on export; it is a structural change, not proven semantic user-content loss. Relationships/content types were normalized with the removed parts.

## C. Real-footnote fixture

**Unverified / blocked.** No existing sanitized fixture with a positive footnote or endnote reference was found. Microsoft Word and LibreOffice executables were not available on this host. I did not hand-write a fake OOXML fixture because that would invalidate this gate. A real Word/LibreOffice-created fixture is required before adoption.

Consequently, `doc.footnotes.list()` was invoked against an available fixture and returned an empty list, but listing/inserting/reopening a real user footnote was not claimed as passed.

## D. Track Changes (latest public contract)

| Operation | Result |
| --- | --- |
| Tracked create/list/reopen | Pass in the available 2.5.0 Windows runtime |
| Accept/reject by generated ID | **Fail in 2.5.0**: `TARGET_NOT_FOUND` after reopen |
| `target: { kind: "all" }` | Not verified with the declared 2.7.0 runtime |
| Latest 2.7.0 runtime | Blocked before document open by missing Windows binary |

The prior POC failure was captured with SDK version, operation, target IDs, and error details; direct-edit fallback remains separate evidence and does not mask review failure. A fixture originally containing tracked changes was not available, so the existing-change workflow remains unverified.

## E. Programmatic screenshot

Backend: `html-to-image` 1.11.13, isolated inside the browser harness. SuperDoc has no public page-to-PNG API used here.

`capturePage(pageNumber): Promise<Blob>` is now implemented in the harness. It temporarily converts SuperDoc `blob:` image resources to data URLs, calls `html-to-image.toBlob`, and restores the live editor DOM.

| Capture | Result |
| --- | --- |
| Page 1 | **PASS** — `image/png`, 130,141 bytes; Chinese/table content present |
| Middle page (page 2) | **PASS** — `image/png`, 108,876 bytes; Chinese/table/image content present |
| Dirty editor state | **PASS** — capture ran after browser keyboard edit without exporting first |
| DevTools comparison | **PASS** — Chrome DevTools MCP showed matching page 1 and middle-page layout; DevTools was used only for observation, not PNG generation |
| Private DOM dependency | **WARN** — `.superdoc-page`/`data-page-number` used only inside the spike adapter |
| Zoom independence | **Unverified** — no product zoom implementation; follow-up needed |

## F. Updated fidelity matrix

| Area | Result | Evidence/guard |
| --- | --- | --- |
| Basic text, Chinese render | Pass | Browser and headless checks |
| Tables | Pass for exercised cell edits | Need merged/border/alignment corpus |
| Images | Pass for exercised list/replace/alt and browser capture | Need broader wrap/crop corpus |
| Headers/footers | Warn | Header part changed in diff; semantic comparison pending |
| Footnotes/endnotes | Guard required | No real-note fixture; reserved part removal observed |
| Tracked changes | Guard required | Decision target failure in 2.5; latest Windows runtime unavailable |
| Programmatic PNG | Pass | JS Blob, page 1 and middle page verified |
| Load performance | Warn | Completed fixture took 3.7–15.1 seconds in local runs |

## G. Capability-aware adoption rule

The future adapter may expose `text`, `table`, `image`, `render`, and `export` only after clean-version and fidelity gates pass. Until then, documents with footnotes/endnotes or tracked changes must either use the current PaperDuck kernel or be read-only. Silent OOXML loss is not acceptable; explicit capability refusal is acceptable.

## Blocking issues and next steps

1. Obtain a published Windows binary compatible with the chosen latest SDK, or validate the latest SDK on a supported runtime and record the deployment implication.
2. Add sanitized, genuinely Word/LibreOffice-generated F1/F2/F3 fixtures and rerun no-op and mutation round-trips.
3. Resolve tracked-change accept/reject semantics with the current runtime, including ID and `all` targets.
4. Compare screenshot output at controlled zoom values.
5. Only after those gates, implement the provider-neutral adapter on a new branch; never expose SuperDoc types in PaperDuck domain/application code.

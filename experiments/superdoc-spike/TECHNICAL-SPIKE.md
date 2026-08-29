# SuperDoc v2 Unified Document Engine Technical Spike

Date: 2026-08-29
Scope: validation only; no production migration

## Result

SuperDoc v2 successfully rendered and edited a real DOCX in Chrome and the public headless SDK completed basic text/table/image operations across four real fixtures. It is a credible candidate for a future adapter, but it is not approved to replace the current engine because the package diff exposed removed footnote/endnote parts and tracked-change decision behavior is unresolved. See [LOCK_IN.md](./LOCK_IN.md) for the gates.

## Tested artifacts

Fixtures:

- blank template
- completed Chinese experiment report
- derived template
- larger report fixture used by the existing POC

The fixture files and generated DOCX files remain local/ignored. The POC lives at [research/document-engine/poc-superdoc](../../research/document-engine/poc-superdoc) and uses only the public `@superdoc/sdk` surface.

## Browser verification (Chrome DevTools MCP)

The isolated Vite harness was loaded at `http://127.0.0.1:4173/?fixture=completed-example.docx`.

Observed:

1. `superdoc` 2.10.0 loaded the real DOCX and reported ready in approximately 12,387 ms.
2. The rendered page showed Chinese text, a multi-column table, and an embedded chart image.
3. The browser editor accepted `Control+End` followed by `[Browser edit verified]`; the text appeared in the editor accessibility snapshot.
4. `Export DOCX` returned a 63,610-byte Blob and completed in 33 ms.
5. DevTools MCP captured the first viewport and a middle scroll position containing the chart/table content and the edited text.
6. Console had no SuperDoc error/exception; only Vite debug output, a Vue feature-flag warning, and a missing form id issue in the harness.

Basic browser edit/export is therefore **PASS**. Table formatting fidelity and complex review interactions remain **UNVERIFIED** in the browser.

## Headless verification

The existing POC ran:

- API export inspection and target inspection
- text search with stable target references
- image enumeration
- open/save/reopen round trips for all four fixtures
- tracked text replacement and reopen
- table cell edits
- image replacement and alt-text changes
- final export/reopen content checks

Round-trip and mutation reports were successful for the exercised operations. `trackChanges.decide()` failed with `TARGET_NOT_FOUND` after a generated tracked replacement, so the POC records this as a warning and does not claim review-decision compatibility.

## Fidelity matrix

| Area | Result | Notes |
| --- | --- | --- |
| Chinese text render | Pass | Browser and headless content checks succeeded |
| Basic text replace | Pass | Search target and exported content verified |
| Tables | Pass for exercised cell edits; visual exactness pending | Borders/alignment/merged-cell corpus still needed |
| Images | Pass for exercised list/replace/alt operations | Full layout corpus still needed |
| Headers | Warning | Output changed `word/header1.xml`; needs semantic comparison |
| Footnotes/endnotes | Blocker | Output removed `word/footnotes.xml` and `word/endnotes.xml` for affected fixtures |
| Tracked changes | Warning | Listing/reopen works; decision returned `TARGET_NOT_FOUND` in SDK 2.5 |
| Browser page capture | Pass as DevTools observation | `.superdoc-page` is a DOM observation, not a supported PaperDuck API |
| Load performance | Observation only | Approximately 12.4 s for the completed fixture in local Chrome |

## Provider-neutral mapping

The future adapter should map PaperDuck operations to public SuperDoc APIs only: `info`/`blocks.list`, `find`, `replace`, `tables.setCellText`, `images.list`, `images.replaceSource`, `images.setAltText`, `save`, and `export`. Tool, event, checkpoint, approval, receipt, lease, and document revision semantics stay in PaperDuck and are not delegated to SuperDoc.

## Version and license record

The browser spike used `superdoc` 2.10.0. The existing headless POC used `@superdoc/sdk` 2.5.0; the current registry query reported 2.7.0. The official v2 migration documentation identifies `superdoc` as the browser package and `@superdoc/react` as the React wrapper, and warns against private v2 packages.

The official project documents AGPLv3 for the open-source project and a commercial licensing option for proprietary deployments. PaperDuck must obtain an explicit licensing decision before distributing a SuperDoc-based production adapter.

## Decision

Keep the current production document engine. Preserve this spike as an isolated evidence base and, if the gates in [LOCK_IN.md](./LOCK_IN.md) are satisfied, implement a provider-neutral adapter on a separate branch. Do not start that implementation as part of this commit.

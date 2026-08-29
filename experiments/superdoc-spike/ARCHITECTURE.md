# SuperDoc v2 Spike Architecture

This directory is an isolated technical spike. It is not imported by the production Task route and does not change the current `docx-preview` canvas or the existing document mutation contracts.

## Boundary

```text
PaperDuck document application
        |
        v
DocumentEnginePort (provider-neutral)
        |
        +-- current production adapter: docx-preview + OoxmlPreservationKernel
        `-- future candidate adapter: SuperDoc v2 (spike only)
```

The production port must expose PaperDuck concepts (`DocumentSnapshot`, `DocumentMutation`, `DocumentRevision`, `DocumentValidation`) and must not expose SuperDoc classes, SDK handles, DOM selectors, or SuperDoc-specific IDs. A production adapter would own conversion, error mapping, validation, and save/export policy.

## Candidate surfaces

| PaperDuck capability | SuperDoc public surface observed in the spike | Confidence |
| --- | --- | --- |
| Open/render DOCX | Browser `new SuperDoc({ selector, document, documentMode })` | High |
| Inspect document | SDK `document.info()` and `document.blocks.list()` | High |
| Find stable text target | SDK `document.find()` | High |
| Text mutation | SDK `document.replace({ ref, text, changeMode })` | High |
| Batch text mutation | Repeated public replace operations coordinated by adapter | Medium |
| Table cell mutation | SDK `document.tables.setCellText()` | High |
| Image inspection/mutation | SDK `document.images.list()`, `replaceSource()`, `setAltText()` | High |
| Track-change listing | SDK `document.trackChanges.list()` | Medium |
| Track-change decision | `trackChanges.decide()` is public but failed to resolve the generated ID in SDK 2.5 | Low; investigate before adoption |
| Export | Browser `instance.export({ exportType: ['docx'], triggerDownload: false })`; SDK `document.save()` | High |
| Browser editing | SuperDoc browser editor DOM and keyboard interaction | High for basic edit |
| Page capture | DevTools MCP viewport capture; page boundary currently observed as `.superdoc-page` | Medium; selector is not a supported PaperDuck contract |

## Proposed adapter ports

The following are design targets, not production code:

```ts
interface DocumentEnginePort {
  open(source: DocumentSource): Promise<DocumentHandle>;
  inspect(handle: DocumentHandle): Promise<DocumentInspection>;
  query(handle: DocumentHandle, query: DocumentQuery): Promise<DocumentQueryResult>;
  apply(handle: DocumentHandle, mutation: DocumentMutation): Promise<MutationReceipt>;
  export(handle: DocumentHandle, options?: ExportOptions): Promise<Uint8Array>;
  validate(bytes: Uint8Array): Promise<DocumentValidation>;
  capabilities(): DocumentEngineCapabilities;
}

interface DocumentSurfacePort {
  getState(): DocumentSurfaceState;
  captureVisible(): Promise<Uint8Array>;
  capturePage(page: number): Promise<Uint8Array>;
  navigate(page: number): void;
}
```

These interfaces intentionally contain no SuperDoc imports. The browser surface should use a supported public page/capture API if one becomes available; relying on `.superdoc-page` would be an adapter-local fallback only.

## Lock-in controls

- All experimental imports are under `experiments/superdoc-spike`.
- No SuperDoc package is added to the root production dependency graph.
- No SuperDoc-specific value is persisted in runtime state, checkpoints, events, receipts, or database rows.
- The existing `docx-preview` renderer and OoxmlPreservationKernel remain authoritative.
- Browser fixture copies and generated exports/screenshots are ignored.

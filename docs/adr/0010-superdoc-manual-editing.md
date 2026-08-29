# ADR 0010: SuperDoc browser manual editing adapter

## Status

Accepted for the manual-edit MVP.

## Decision

Use `superdoc` version `2.10.0` as a browser-only editor adapter. The
provider-neutral application boundary is `DocumentEditorPort`; SuperDoc types
do not cross that boundary. The existing `DocumentSurfacePort` remains the
capture/preview boundary, and the default read-only surface remains
`docx-preview`.

The adapter uses the public v2 constructor with `documentMode: "editing"`,
the public toolbar container, `onReady`, `onEditorUpdate`, `onContentError`,
`onException`, `export({ exportType: ["docx"], triggerDownload: false })`, and
`destroy()`.

The package metadata currently declares `AGPL-3.0`. Any future licensing or
deployment decision must be made separately; replacing the browser adapter
does not require changing the document application ports.

## References

- https://docs.superdoc.dev/editor/quickstart/
- https://docs.superdoc.dev/editor/configuration/
- https://docs.superdoc.dev/editor/export-options/
- https://docs.superdoc.dev/editor/lifecycle-and-events/
- https://docs.superdoc.dev/editor/migrate-from-v1/removed-apis/

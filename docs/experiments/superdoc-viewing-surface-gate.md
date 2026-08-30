# SuperDoc viewing surface gate

Date: 2026-08-30
Branch: `feature/superdoc-viewing-surface-gate`
SuperDoc: `2.10.0`

## Scope and decision

This is a development-only viewing experiment. The production surface remains
`docx-preview`; SuperDoc is selected only when development localStorage contains
`paperduck.documentSurface=superdoc`. Missing or invalid values resolve to
`docx-preview`.

Decision: **LIMITED_GO**. The read-only surface is suitable for continued
evaluation, but it is not approved as the production default until fidelity,
manual-editor handoff, and real screenshot-tool coverage are completed against
the project's representative document fixtures.

## Implementation evidence

- `SuperDocDocumentViewer` is a Browser-only adapter using the public
  `documentMode: "viewing"`, `role: "viewer"`, `ui: false`,
  `hyperlinks: false`, and `viewing.comments: false` configuration.
- The adapter reports `dirty: false` and binds `renderedRevision` to the opened
  document revision. It does not fabricate `pageCount`.
- Viewer and editor mounts are separate; changing task, revision, or mode
  destroys the prior instance. `captureVisible` uses the shared viewport
  capture primitive and therefore follows the current `.paper-stage` scroll
  position rather than capturing the whole document.
- Development instrumentation emits mount started/ready/failed with engine,
  task, revision, byte count, and duration only.

## Browser verification

Using the local development server and a real historical `fixture.docx` task:

- SuperDoc viewer mounted and rendered the real document text and table content.
- The `.paper-stage` had a scrollable document (`scrollHeight 6979`, viewport
  `1026 x 766`); scrolling to `scrollTop 420` was retained by the surface.
- No content-editable element or SuperDoc toolbar was present in viewing mode.
- Switching the preference back to `docx-preview` restored the existing preview
  path without a database change.
- One Vue feature-flag warning was observed in the browser console from the
  SuperDoc bundle. No application error was observed.

## Known limitations / unverified

- A complete live `capture_document_view` Agent run was not repeated in this
  gate because the selected historical task already had an active pending
  interaction; the viewport adapter is covered by unit tests, but a fresh
  tool-call E2E remains unverified.
- Representative visual fidelity comparison, unsupported tracked-change/
  footnote fixtures, viewer-to-editor discard flow, task/revision rapid-switch
  cleanup, and screenshot asset upload were not claimed as passed here.

## References

- [SuperDoc configuration](https://docs.superdoc.dev/editor/configuration/)
- [SuperDoc editor and viewing modes](https://docs.superdoc.dev/editor/)

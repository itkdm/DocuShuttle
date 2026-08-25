# Document Engine evaluation

SuperDoc is a candidate, not a committed dependency. The POC is isolated here and must satisfy [the product acceptance matrix](../../docs/testing/acceptance.md) before an ADR selects it.

Pinned evaluation versions (observed 2026-08-26):

- `superdoc@2.9.0`
- `@superdoc/react@2.4.0` (peer-pins `superdoc@2.9.0`)
- `@superdoc/sdk@2.5.0`

The initially evaluated `@superdoc/sdk@2.6.0` declares platform packages at `2.6.0`, but those packages were not published to npm (their latest available version was `2.5.0`). The POC therefore uses the newest installable complete SDK set, `2.5.0`. This release skew and incomplete publication are direct evidence of project risk. Production code may only depend on a provider-neutral Document Engine port.

The POC uses private local documents by path and writes reports under ignored output directories. It must never copy personal documents into committed fixtures.

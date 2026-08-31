# Targeted Agent Execution Trace Test Report

This report indexes real browser runs performed with the same-origin DOCX fixture. It records observed facts only; no runtime behavior was changed during the test run.

| Case | Task ID | Run ID | Status | Iterations | Result | Notes |
|---|---|---|---|---:|---|---|
| A precise field mutation | `7eea0bab-d693-483a-98f9-9c5634859f69` | `03a353a3-8356-48ab-a3b2-e15ec224e047` | completed | 6 | completed successfully | `inspect_document → list_document_regions → read_document_region ×2 → apply_text_changes (error, retry, success)`; approval required and approved |
| B vague tail mutation | `4200fcc5-a201-4034-bfdf-43537cfdce0f` | `4968fa2d-7597-4f72-abba-6252b4fa62c8` | running at capture | 5 | in progress | tail pagination observed before offset 250; target title found, then `read_document_region` |
| C explicit title mutation | `09dc73ed-b142-4e36-9114-5d0d4d60af22` | `3225938e-4760-4299-9dbe-8c5e635eb1c1` | running at capture | 1 | in progress | real browser run started; no terminal result captured |
| D read-only tail | `9d08e406-4ff5-4d78-95af-ad0da0b5b9b1` | — | not materialized at capture | — | unverified | task was created in browser, but no matching trace directory was available at capture |
| E long 1000-word summary | `bf1e7b4c-0ace-4e13-89ee-69328e38c4fb` | `e73efea7-9437-4652-a29c-f6343f403c99` | running at capture | 4 | in progress | real browser run started; no terminal result captured |
| F cross-run continuity | — | — | not run | — | unverified | not started in this capture window |

Fixture used through same-origin browser fetch: `public/devtools-upload-real.docx` (temporary, untracked; not for commit). The browser received it as `2310250478-孔德明-实验1.2.docx`.

Observed hypothesis evidence so far: Case B showed repeated tail-region pagination before locating the explicit title. Model-facing truncation, context compaction, and redundant `plan_text_change` were not claimed without completed Trace evidence.

import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { CommitManualDocumentEdit, MANUAL_EDIT_DOCX_MIME } from "../commit-manual-document-edit";

const inspection = (revision: string) => ({ manifest: { revision, entries: [], nodes: [] }, capabilities: { replaceText: true, setCellText: true, replaceImage: true, trackedChanges: false }, diagnostics: [], paragraphs: [], tableCells: [], images: [] } as const);
async function bytes() { const zip = new JSZip(); zip.file("word/document.xml", "<w:document><w:body><w:p>changed</w:p></w:body></w:document>"); return new Uint8Array(await zip.generateAsync({ type: "uint8array" })); }
const input = async (revision: string) => ({ taskId: "11111111-1111-4111-8111-111111111111", ownerUserId: "user-1", expectedRevision: revision, bytes: await bytes(), mimeType: MANUAL_EDIT_DOCX_MIME, fileName: "edited.docx" });

function harness(result: "success" | "conflict" | "error" = "success") {
  const storage = { put: vi.fn(async () => undefined), remove: vi.fn(async () => undefined), get: vi.fn(), createSignedUpload: vi.fn(), createSignedDownload: vi.fn() };
  const versions = { commit: vi.fn(async () => result === "conflict" ? { kind: "revision-conflict" as const, actualRevision: "other" } : result === "error" ? Promise.reject(new Error("response lost")) : { versionId: "v1", versionNumber: 2 }) };
  const documents = { load: vi.fn(async () => ({ documentId: "d1", objectKey: "old", revision: "a".repeat(64) })) };
  const engine = { validate: vi.fn(async () => inspection("b".repeat(64))), inspect: vi.fn(async () => inspection("b".repeat(64))), mutate: vi.fn() };
  return { storage, versions, documents, engine, useCase: new CommitManualDocumentEdit(documents, versions, storage, engine) };
}

describe("CommitManualDocumentEdit", () => {
  it("commits one validated version and performs reopen validation", async () => {
    const h = harness();
    await expect(h.useCase.execute(await input("a".repeat(64)))).resolves.toMatchObject({ versionId: "v1", noChange: false });
    expect(h.engine.validate).toHaveBeenCalledOnce(); expect(h.engine.inspect).toHaveBeenCalledOnce(); expect(h.versions.commit).toHaveBeenCalledOnce();
  });

  it("does not write or create storage for a no-op", async () => {
    const h = harness(); h.engine.validate.mockResolvedValue(inspection("a".repeat(64))); h.engine.inspect.mockResolvedValue(inspection("a".repeat(64)));
    await expect(h.useCase.execute(await input("a".repeat(64)))).resolves.toMatchObject({ noChange: true });
    expect(h.storage.put).not.toHaveBeenCalled(); expect(h.versions.commit).not.toHaveBeenCalled();
  });

  it("cleans uploaded objects on a known CAS conflict", async () => {
    const h = harness("conflict"); await expect(h.useCase.execute(await input("a".repeat(64)))).rejects.toMatchObject({ code: "DOCUMENT_REVISION_MISMATCH" });
    expect(h.storage.remove).toHaveBeenCalledTimes(2);
  });

  it("keeps objects when the commit response is uncertain", async () => {
    const h = harness("error"); await expect(h.useCase.execute(await input("a".repeat(64)))).rejects.toThrow("response lost");
    expect(h.storage.remove).not.toHaveBeenCalled();
  });
});

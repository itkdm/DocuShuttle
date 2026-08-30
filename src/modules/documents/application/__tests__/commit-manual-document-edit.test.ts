import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { CommitManualDocumentEdit, MANUAL_EDIT_DOCX_MIME } from "../commit-manual-document-edit";
import type { DocumentRoundTripSentinelPort } from "../document-round-trip-sentinel-port";
import { OoxmlPreservationKernel } from "../../infrastructure/ooxml/ooxml-preservation-kernel";
import { OoxmlRoundTripPreservationSentinel } from "../../infrastructure/ooxml/round-trip-preservation-sentinel";
import { createDocx } from "../../infrastructure/ooxml/__tests__/fixture";
import type { DocumentInspection } from "../../domain/types";

const inspection = (revision: string): DocumentInspection => ({ manifest: { revision, entries: [], nodes: [] }, capabilities: { replaceText: true, setCellText: true, replaceImage: true, trackedChanges: false }, diagnostics: [], paragraphs: [], tableCells: [], images: [], validation: { valid: true, tiers: [{ tier: "identity", status: "passed", diagnostics: [] }] } });
async function bytes() { const zip = new JSZip(); zip.file("word/document.xml", "<w:document><w:body><w:p>changed</w:p></w:body></w:document>"); return new Uint8Array(await zip.generateAsync({ type: "uint8array" })); }
async function unsupportedSourceBytes() { const zip = new JSZip(); zip.file("word/document.xml", "<w:document><w:body><w:p><w:r><w:footnoteReference w:id=\"1\"/></w:r></w:p></w:body></w:document>"); zip.file("word/footnotes.xml", "<w:footnotes><w:footnote w:id=\"1\"><w:p>note</w:p></w:footnote></w:footnotes>"); return new Uint8Array(await zip.generateAsync({ type: "uint8array" })); }
async function embeddedObjectSourceBytes() { const zip = new JSZip(); zip.file("word/document.xml", "<w:document><w:body><w:p><w:r><w:object><v:shape><v:imagedata/></v:shape><o:OLEObject Type=\"Embed\"/></w:object></w:r></w:p></w:body></w:document>"); return new Uint8Array(await zip.generateAsync({ type: "uint8array" })); }
const input = async (revision: string) => ({ taskId: "11111111-1111-4111-8111-111111111111", ownerUserId: "user-1", expectedRevision: revision, bytes: await bytes(), mimeType: MANUAL_EDIT_DOCX_MIME, fileName: "edited.docx" });

function harness(result: "success" | "conflict" | "error" = "success", source: "clean" | "unsupported" = "clean") {
  const storage = { put: vi.fn(async () => undefined), remove: vi.fn(async () => undefined), get: vi.fn(async () => source === "unsupported" ? unsupportedSourceBytes() : bytes()), createSignedUpload: vi.fn(), createSignedDownload: vi.fn() };
  const versions = { commit: vi.fn(async () => result === "conflict" ? { kind: "revision-conflict" as const, actualRevision: "other" } : result === "error" ? Promise.reject(new Error("response lost")) : { versionId: "v1", versionNumber: 2 }) };
  const documents = { load: vi.fn(async () => ({ documentId: "d1", objectKey: "old", revision: "a".repeat(64) })) };
  const engine = { validate: vi.fn(async () => inspection("b".repeat(64))), inspect: vi.fn(async () => inspection("b".repeat(64))), mutate: vi.fn() };
  const sentinel: DocumentRoundTripSentinelPort = { verify: vi.fn(async () => ({ safe: true, issues: [] })) };
  return { storage, versions, documents, engine, sentinel, useCase: new CommitManualDocumentEdit(documents, versions, storage, engine, sentinel) };
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

  it("rejects an unsupported authoritative source even when exported output is clean", async () => {
    const h = harness("success", "unsupported");
    await expect(h.useCase.execute(await input("a".repeat(64)))).rejects.toMatchObject({ code: "MANUAL_EDIT_UNSUPPORTED_FEATURE" });
    expect(h.versions.commit).not.toHaveBeenCalled(); expect(h.storage.put).not.toHaveBeenCalled();
  });

  it("rejects an embedded-object source before creating a version", async () => {
    const h = harness(); h.storage.get.mockResolvedValue(await embeddedObjectSourceBytes());
    await expect(h.useCase.execute(await input("a".repeat(64)))).rejects.toMatchObject({ code: "MANUAL_EDIT_UNSUPPORTED_FEATURE" });
    expect(h.versions.commit).not.toHaveBeenCalled(); expect(h.storage.put).not.toHaveBeenCalled();
  });

  it("rejects an unsupported exported output after a clean source guard", async () => {
    const h = harness();
    const output = await unsupportedSourceBytes();
    await expect(h.useCase.execute({ ...(await input("a".repeat(64))), bytes: output })).rejects.toMatchObject({ code: "MANUAL_EDIT_UNSUPPORTED_FEATURE" });
    expect(h.sentinel.verify).not.toHaveBeenCalled(); expect(h.versions.commit).not.toHaveBeenCalled(); expect(h.storage.put).not.toHaveBeenCalled();
  });

  it("rejects an unsafe round trip before engine validation or persistence", async () => {
    const h = harness();
    vi.mocked(h.sentinel.verify).mockResolvedValue({ safe: false, issues: [{ code: "ROUND_TRIP_PART_MISSING", entry: "customXml/item1.bin", reason: "protected source part is missing from output" }] });
    await expect(h.useCase.execute(await input("a".repeat(64)))).rejects.toMatchObject({ code: "MANUAL_EDIT_ROUND_TRIP_UNSAFE" });
    expect(h.engine.validate).not.toHaveBeenCalled(); expect(h.engine.inspect).not.toHaveBeenCalled();
    expect(h.storage.put).not.toHaveBeenCalled(); expect(h.versions.commit).not.toHaveBeenCalled();
  });

  it("rejects a failed engine validation before reopen or persistence", async () => {
    const h = harness();
    h.engine.validate.mockResolvedValue({ ...inspection("b".repeat(64)), validation: { valid: false, tiers: [{ tier: "identity", status: "failed", diagnostics: [] }] } });
    await expect(h.useCase.execute(await input("a".repeat(64)))).rejects.toMatchObject({ code: "MANUAL_EDIT_VALIDATION_FAILED" });
    expect(h.engine.inspect).not.toHaveBeenCalled();
    expect(h.storage.put).not.toHaveBeenCalled(); expect(h.versions.commit).not.toHaveBeenCalled();
  });

  it("does not invoke the sentinel after a source capability failure", async () => {
    const h = harness("success", "unsupported");
    await expect(h.useCase.execute(await input("a".repeat(64)))).rejects.toMatchObject({ code: "MANUAL_EDIT_UNSUPPORTED_FEATURE" });
    expect(h.sentinel.verify).not.toHaveBeenCalled();
  });

  it("lets the real package validator reject managed-only corruption after Sentinel passes", async () => {
    const source = await createDocx();
    const engine = new OoxmlPreservationKernel();
    const sourceInspection = await engine.inspect(source);
    const outputZip = await JSZip.loadAsync(source);
    outputZip.remove("_rels/.rels");
    const output = new Uint8Array(await outputZip.generateAsync({ type: "uint8array" }));
    const storage = {
      get: vi.fn(async () => source),
      put: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      createSignedUpload: vi.fn(),
      createSignedDownload: vi.fn(),
    };
    const versions = { commit: vi.fn() };
    const documents = { load: vi.fn(async () => ({ documentId: "d1", objectKey: "source", revision: sourceInspection.manifest.revision })) };
    const useCase = new CommitManualDocumentEdit(documents, versions, storage, engine, new OoxmlRoundTripPreservationSentinel());
    const validate = vi.spyOn(engine, "validate");
    const inspect = vi.spyOn(engine, "inspect");

    await expect(useCase.execute({
      taskId: "11111111-1111-4111-8111-111111111111",
      ownerUserId: "user-1",
      expectedRevision: sourceInspection.manifest.revision,
      bytes: output,
      mimeType: MANUAL_EDIT_DOCX_MIME,
      fileName: "edited.docx",
    })).rejects.toMatchObject({ code: "MANUAL_EDIT_VALIDATION_FAILED" });
    expect(validate).toHaveBeenCalledOnce(); expect(inspect).toHaveBeenCalledOnce();
    expect(storage.put).not.toHaveBeenCalled(); expect(versions.commit).not.toHaveBeenCalled();
  });

  it("does not read source bytes after a source revision mismatch", async () => {
    const h = harness(); h.documents.load.mockResolvedValue({ documentId: "d1", objectKey: "old", revision: "b".repeat(64) });
    await expect(h.useCase.execute(await input("a".repeat(64)))).rejects.toMatchObject({ code: "DOCUMENT_REVISION_MISMATCH" });
    expect(h.storage.get).not.toHaveBeenCalled();
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

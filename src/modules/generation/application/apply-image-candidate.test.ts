import { describe, expect, it } from "vitest";
import { ApplyImageCandidate } from "./apply-image-candidate";

const address = { nodeId: "img-1", kind: "image" as const, sourceRevision: "a".repeat(64), fingerprint: "b".repeat(64), entry: "word/document.xml", path: "/w:drawing[1]", relationshipId: "rId1", mediaEntry: "word/media/image1.png", mediaReferenceCount: 1 };
const inspection = { manifest: { revision: "a".repeat(64), entries: [], nodes: [address] }, paragraphs: [], tableCells: [], images: [{ address, contentType: "image/png", byteLength: 2 }], diagnostics: [], capabilities: { replaceText: true as const, setCellText: true as const, replaceImage: true as const, trackedChanges: false as const } };

class Storage { objects = new Map<string, Uint8Array>(); async get(key: string) { return this.objects.get(key) ?? new Uint8Array([1]); } async put(key: string, bytes: Uint8Array) { this.objects.set(key, bytes); } async remove(key: string) { this.objects.delete(key); } async createSignedDownload() { return ""; } async createSignedUpload(): Promise<never> { throw new Error("unused"); } }

describe("ApplyImageCandidate", () => {
  it("creates a validated immutable version for the selected node", async () => {
    const storage = new Storage();
    const engine = { inspect: async () => inspection, validate: async () => ({ ...inspection, manifest: { ...inspection.manifest, revision: "c".repeat(64) } }), mutate: async () => ({ bytes: new Uint8Array([2]), manifest: { ...inspection.manifest, revision: "c".repeat(64) }, changedEntries: ["word/media/image1.png"], diagnostics: [] }) };
    const result = await new ApplyImageCandidate(
      { load: async () => ({ objectKey: "users/u/tasks/t/assets/a.png", mimeType: "image/png" }) },
      { load: async () => ({ documentId: "d", objectKey: "users/u/tasks/t/versions/current.docx", revision: "a".repeat(64), versionNumber: 1 }) },
      { commit: async () => ({ versionId: "v", versionNumber: 2 }) }, storage, engine,
    ).execute({ taskId: "11111111-1111-4111-8111-111111111111", assetId: "22222222-2222-4222-8222-222222222222", targetNodeId: "img-1", expectedRevision: "a".repeat(64), ownerUserId: "u" });
    expect(result.versionId).toBe("v");
    expect(storage.objects.size).toBe(2);
  });
});

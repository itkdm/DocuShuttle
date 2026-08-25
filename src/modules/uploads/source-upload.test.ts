import { describe, expect, it, vi } from "vitest";

import type { DocumentEnginePort, DocumentInspection } from "@/modules/documents";
import { sha256 } from "@/modules/documents/infrastructure/ooxml/hash";
import type { PrivateObjectStoragePort } from "@/modules/storage/ports";
import type { TaskRepositoryPort } from "@/modules/tasks/ports";

import { CompleteSourceUpload } from "./complete-source-upload";
import { CreateSourceUpload } from "./create-source-upload";

const ownerUserId = "1e56a54a-5e96-4cc0-9430-702a68b21c63";
const taskId = "0872a73c-d403-429c-9ca7-d0e629b36c69";

const createTasks = (): TaskRepositoryPort => ({
  create: vi.fn(),
  belongsToOwner: vi.fn().mockResolvedValue(true),
  registerSource: vi.fn().mockResolvedValue({ sourceFileId: "source-1", workingDocumentId: "working-1", versionId: "version-1" }),
});

const createStorage = (bytes = new Uint8Array([1, 2, 3])): PrivateObjectStoragePort => ({
  createSignedUpload: vi.fn(async (input) => ({
    objectKey: input.objectKey,
    method: "PUT" as const,
    url: "https://oss.example/upload",
    headers: { "content-type": input.mimeType },
    expiresAt: new Date().toISOString(),
    maxBytes: input.maxBytes,
  })),
  createSignedDownload: vi.fn(),
  put: vi.fn(),
  get: vi.fn().mockResolvedValue(bytes),
  remove: vi.fn(),
});

const inspection = {
  manifest: { revision: "revision", entries: [] },
  paragraphs: [],
  tableCells: [],
  images: [],
  diagnostics: [],
  capabilities: { replaceText: true, setCellText: true, replaceImage: true, trackedChanges: false },
} satisfies DocumentInspection;

it("scopes a signed upload to the authenticated task", async () => {
  const result = await new CreateSourceUpload(createTasks(), createStorage()).execute({
    ownerUserId,
    taskId,
    role: "template",
    originalName: "实验模板.docx",
    byteLength: 1024,
  });

  expect(result.upload.objectKey).toMatch(new RegExp(`^users/${ownerUserId}/tasks/${taskId}/sources/.+\\.docx$`));
  expect(result.upload.url).toBe("https://oss.example/upload");
});

describe("complete source upload", () => {
  it("verifies bytes and inspection before registering metadata", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const tasks = createTasks();
    const storage = createStorage(bytes);
    const documents = { inspect: vi.fn().mockResolvedValue(inspection) } as unknown as DocumentEnginePort;
    const result = await new CompleteSourceUpload(tasks, storage, documents).execute({
      ownerUserId,
      taskId,
      role: "template",
      originalName: "实验模板.docx",
      objectKey: `users/${ownerUserId}/tasks/${taskId}/sources/source.docx`,
      expectedBytes: bytes.byteLength,
      expectedSha256: await sha256(bytes),
    });

    expect(result.sourceFileId).toBe("source-1");
    expect(tasks.registerSource).toHaveBeenCalledOnce();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("removes an object whose checksum does not match", async () => {
    const storage = createStorage();
    const useCase = new CompleteSourceUpload(createTasks(), storage, {} as DocumentEnginePort);
    await expect(useCase.execute({
      ownerUserId,
      taskId,
      role: "template",
      originalName: "实验模板.docx",
      objectKey: `users/${ownerUserId}/tasks/${taskId}/sources/source.docx`,
      expectedBytes: 3,
      expectedSha256: "0".repeat(64),
    })).rejects.toThrow("UPLOAD_CHECKSUM_MISMATCH");
    expect(storage.remove).toHaveBeenCalledOnce();
  });
});

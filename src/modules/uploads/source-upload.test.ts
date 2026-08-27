import { describe, expect, it, vi } from "vitest";

import type { DocumentEnginePort, DocumentInspection } from "@/modules/documents";
import { sha256 } from "@/modules/documents/infrastructure/ooxml/hash";
import type { PrivateObjectStoragePort } from "@/modules/storage/ports";
import type { TaskRepositoryPort } from "@/modules/tasks/ports";

import { CompleteSourceUpload } from "./complete-source-upload";
import { CreateSourceUpload } from "./create-source-upload";
import { emptySourceRegistrationState, isWorkingDocumentUpload, reduceSourceRegistration } from "./source-role-semantics";

const ownerUserId = "1e56a54a-5e96-4cc0-9430-702a68b21c63";
const taskId = "0872a73c-d403-429c-9ca7-d0e629b36c69";

const createTasks = (): TaskRepositoryPort => ({
  create: vi.fn(),
  listByOwner: vi.fn().mockResolvedValue([]),
  getWorkspace: vi.fn(),
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
  manifest: { revision: "revision", entries: [], nodes: [] },
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
    expect(result.role).toBe("template");
    expect(result.originalName).toBe("实验模板.docx");
    expect(tasks.registerSource).toHaveBeenCalledOnce();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("keeps example uploads as references without establishing a working document", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const tasks = createTasks();
    vi.mocked(tasks.registerSource).mockResolvedValueOnce({ sourceFileId: "example-1" });
    const storage = createStorage(bytes);
    const documents = { inspect: vi.fn().mockResolvedValue(inspection) } as unknown as DocumentEnginePort;
    const result = await new CompleteSourceUpload(tasks, storage, documents).execute({
      ownerUserId,
      taskId,
      role: "example",
      originalName: "完成示例.docx",
      objectKey: `users/${ownerUserId}/tasks/${taskId}/sources/example.docx`,
      expectedBytes: bytes.byteLength,
      expectedSha256: await sha256(bytes),
    });

    expect(result.role).toBe("example");
    expect(result.workingDocumentId).toBeUndefined();
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

  it("rejects documents with unsafe inspection diagnostics", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const tasks = createTasks();
    const storage = createStorage(bytes);
    const documents = {
      inspect: vi.fn().mockResolvedValue({
        ...inspection,
        diagnostics: [{ severity: "error", code: "RELATIONSHIP_TARGET_MISSING", message: "broken relationship" }],
      }),
    } as unknown as DocumentEnginePort;

    await expect(new CompleteSourceUpload(tasks, storage, documents).execute({
      ownerUserId,
      taskId,
      role: "template",
      originalName: "损坏模板.docx",
      objectKey: `users/${ownerUserId}/tasks/${taskId}/sources/broken.docx`,
      expectedBytes: bytes.byteLength,
      expectedSha256: await sha256(bytes),
    })).rejects.toThrow("DOCX_INSPECTION_FAILED");
    expect(tasks.registerSource).not.toHaveBeenCalled();
    expect(storage.remove).toHaveBeenCalledOnce();
  });

  it("accepts documents whose only diagnostics are unsupported but preserved constructs", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const tasks = createTasks();
    const storage = createStorage(bytes);
    const documents = {
      inspect: vi.fn().mockResolvedValue({
        ...inspection,
        diagnostics: [
          { severity: "warning", code: "NESTED_TABLE_UNSUPPORTED", message: "nested" },
          { severity: "warning", code: "COMPLEX_CONTENT_UNSUPPORTED", message: "textbox" },
        ],
      }),
    } as unknown as DocumentEnginePort;

    await expect(new CompleteSourceUpload(tasks, storage, documents).execute({
      ownerUserId,
      taskId,
      role: "template",
      originalName: "实验报告.docx",
      objectKey: `users/${ownerUserId}/tasks/${taskId}/sources/source.docx`,
      expectedBytes: bytes.byteLength,
      expectedSha256: await sha256(bytes),
    })).resolves.toMatchObject({ sourceFileId: "source-1" });
    expect(tasks.registerSource).toHaveBeenCalledOnce();
    expect(storage.remove).not.toHaveBeenCalled();
  });
});

describe("template/example ordering", () => {
  const registration = (role: "template" | "example", id: string, workingDocumentId?: string) => ({
    sourceFileId: id,
    role,
    originalName: `${role}.docx`,
    workingDocumentId,
    versionId: workingDocumentId ? `${id}-version` : undefined,
  });

  it("does not let an example uploaded after a template change the working source", () => {
    const template = registration("template", "template-1", "working-1");
    const afterTemplate = reduceSourceRegistration(emptySourceRegistrationState(), template);
    const afterExample = reduceSourceRegistration(afterTemplate, registration("example", "example-1"));

    expect(afterExample.workingDocumentId).toBe("working-1");
    expect(afterExample.workingTemplateSourceId).toBe("template-1");
    expect(afterExample.template?.sourceFileId).toBe("template-1");
    expect(afterExample.example?.sourceFileId).toBe("example-1");
  });

  it("allows an example-first task to acquire a working document when the template arrives", () => {
    const afterExample = reduceSourceRegistration(emptySourceRegistrationState(), registration("example", "example-1"));
    const afterTemplate = reduceSourceRegistration(afterExample, registration("template", "template-1", "working-1"));

    expect(afterExample.workingDocumentId).toBeUndefined();
    expect(afterTemplate.workingDocumentId).toBe("working-1");
    expect(afterTemplate.example?.sourceFileId).toBe("example-1");
  });

  it("tracks a later template replacement without losing the reference example", () => {
    const seeded = reduceSourceRegistration(
      reduceSourceRegistration(emptySourceRegistrationState(), registration("template", "template-1", "working-1")),
      registration("example", "example-1"),
    );
    const replaced = reduceSourceRegistration(seeded, registration("template", "template-2", "working-1"));

    expect(replaced.workingDocumentId).toBe("working-1");
    expect(replaced.workingTemplateSourceId).toBe("template-2");
    expect(replaced.example?.sourceFileId).toBe("example-1");
  });

  it("allows the first example to seed the editable document", () => {
    const firstExample = registration("example", "example-1", "working-1");
    const state = reduceSourceRegistration(emptySourceRegistrationState(), firstExample);

    expect(state.workingDocumentId).toBe("working-1");
    expect(isWorkingDocumentUpload("example", firstExample)).toBe(true);
  });
});

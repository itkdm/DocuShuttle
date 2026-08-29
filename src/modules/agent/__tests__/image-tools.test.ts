import { describe, expect, it } from "vitest";

import { createImageInspectionTools } from "../application/image-tools";
import type { ImageVisionPort } from "../application/vision";
import type { DocumentEnginePort } from "@/modules/documents/application/document-engine-port";

const imageBytes = Uint8Array.from([1, 2, 3]);
const documents: DocumentEnginePort = {
  inspect: async () => { throw new Error("unused"); },
  mutate: async () => { throw new Error("unused"); },
  validate: async () => { throw new Error("unused"); },
  readImage: async (bytes, nodeId) => ({ nodeId, revision: "rev-1", contentType: "image/png", byteLength: bytes.byteLength, fingerprint: "fingerprint", bytes: Uint8Array.from(imageBytes) }),
};
const working = { load: async () => ({ bytes: imageBytes, revision: "rev-1" }), commit: async () => ({ revision: "rev-2" }) };
const sources = { list: async () => [], load: async () => ({ bytes: imageBytes, revision: "source-rev", descriptor: { sourceFileId: "file-1", role: "auxiliary" as const, originalName: "source.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", byteLength: imageBytes.byteLength, sha256: "sha", createdAt: "2026-08-29T00:00:00.000Z" } }) };
const context = { runId: "run-1", callId: "call-1", idempotencyKey: "idem-1", attempt: 1 };
const vision: ImageVisionPort = { analyze: async () => ({ summary: "表格截图", type: "screenshot", visibleText: ["表头"], importantElements: ["表格"], generationHints: [] }) };

describe("inspect_image tool", () => {
  it("reads working-document images and returns metadata plus structured analysis only", async () => {
    const [tool] = createImageInspectionTools("task-1", documents, working, sources, vision);
    const result = await tool.execute({ source: "working-document", nodeId: "image-node" }, context);
    expect(result).toEqual(expect.objectContaining({ source: "working-document", nodeId: "image-node", revision: "rev-1", mimeType: "image/png", byteLength: 3 }));
    expect(result).toHaveProperty("analysis.summary", "表格截图");
    expect(JSON.stringify(result)).not.toContain("base64");
    expect(result).not.toHaveProperty("bytes");
    expect(result).not.toHaveProperty("url");
    expect(result).not.toHaveProperty("objectKey");
  });

  it("loads source-document bytes through the task-scoped source port", async () => {
    let loadedTask: string | undefined;
    let loadedFile: string | undefined;
    const sourcePort = { list: async () => [], load: async (taskId: string, sourceFileId: string) => { loadedTask = taskId; loadedFile = sourceFileId; return { bytes: imageBytes, revision: "source-rev", descriptor: { sourceFileId, role: "auxiliary" as const, originalName: "source.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", byteLength: imageBytes.byteLength, sha256: "sha", createdAt: "2026-08-29T00:00:00.000Z" } }; } };
    const [tool] = createImageInspectionTools("task-2", documents, working, sourcePort, vision);
    await tool.execute({ source: "source-document", sourceFileId: "file-1", nodeId: "image-node" }, context);
    expect({ loadedTask, loadedFile }).toEqual({ loadedTask: "task-2", loadedFile: "file-1" });
  });
});

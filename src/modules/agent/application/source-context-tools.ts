import { z } from "zod";

import type { DocumentEnginePort } from "@/modules/documents/application/document-engine-port";
import type { DocumentInspection } from "@/modules/documents/domain/types";
import type { SourceRole } from "@/modules/tasks/domain";

import type { AgentTool } from "./loop";

/** Metadata the model may use to choose a source. Storage keys are deliberately omitted. */
export type SourceDocumentDescriptor = {
  sourceFileId: string;
  role: SourceRole;
  originalName: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
  createdAt: string;
  inspection?: unknown;
};

export type SourceDocumentPayload = {
  descriptor: SourceDocumentDescriptor;
  bytes: Uint8Array;
};

/** Provider-neutral source context boundary. Implementations enforce task ownership. */
export interface SourceDocumentContextPort {
  list(taskId: string): Promise<readonly SourceDocumentDescriptor[]>;
  load(taskId: string, sourceFileId: string): Promise<SourceDocumentPayload | null>;
}

const sourceIdSchema = z.string().trim().min(1).max(200);
const listSourceSchema = z.object({ role: z.enum(["template", "example", "auxiliary"]).optional() });
const readSourceSchema = z.object({
  sourceFileId: sourceIdSchema,
  maxCharacters: z.number().int().min(500).max(50_000).default(12_000),
});

const inspectionSummary = (inspection: DocumentInspection) => ({
  revision: inspection.manifest.revision,
  counts: {
    paragraphs: inspection.paragraphs.length,
    tableCells: inspection.tableCells.length,
    images: inspection.images.length,
  },
  diagnostics: inspection.diagnostics,
});

const persistedInspectionSummary = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const manifest = record.manifest && typeof record.manifest === "object" && !Array.isArray(record.manifest)
    ? record.manifest as Record<string, unknown>
    : undefined;
  const listLength = (key: string) => Array.isArray(record[key]) ? record[key].length : 0;
  return {
    revision: typeof manifest?.revision === "string" ? manifest.revision : undefined,
    counts: {
      paragraphs: listLength("paragraphs"),
      tableCells: listLength("tableCells"),
      images: listLength("images"),
    },
    diagnostics: Array.isArray(record.diagnostics) ? record.diagnostics.slice(0, 20) : [],
  };
};

const compactInspection = (inspection: DocumentInspection, maxCharacters: number) => {
  const sections = [
    ...inspection.paragraphs.map((paragraph) => ({
      nodeId: paragraph.address.nodeId,
      kind: "paragraph" as const,
      text: paragraph.text,
    })),
    ...inspection.tableCells.map((cell) => ({
      nodeId: cell.address.nodeId,
      kind: "table-cell" as const,
      text: cell.text,
    })),
  ];
  const result: typeof sections = [];
  let used = 0;
  for (const section of sections) {
    if (used >= maxCharacters) break;
    const remaining = maxCharacters - used;
    const text = section.text.length > remaining ? `${section.text.slice(0, Math.max(0, remaining - 1))}…` : section.text;
    result.push({ ...section, text });
    used += text.length;
  }
  return result;
};

/**
 * Source context tools are read-only. They let the model compare template,
 * example and auxiliary material without conflating any of them with the
 * editable Working Document.
 */
export function createSourceContextTools(
  taskId: string,
  sources: SourceDocumentContextPort,
  documents: DocumentEnginePort,
): readonly AgentTool[] {
  const list: AgentTool<typeof listSourceSchema> = {
    name: "list_source_documents",
    description: "List the task's uploaded source documents and their roles (template, example, or auxiliary). This never changes the Working Document.",
    inputSchema: listSourceSchema,
    async execute(input) {
      const descriptors = await sources.list(taskId);
      return {
        documents: descriptors
          .filter((descriptor) => !input.role || descriptor.role === input.role)
          .map(({ sourceFileId, role, originalName, mimeType, byteLength, sha256, createdAt, inspection }) => ({
            sourceFileId,
            role,
            originalName,
            mimeType,
            byteLength,
            sha256,
            createdAt,
            inspection: persistedInspectionSummary(inspection),
          })),
      };
    },
  };

  const read: AgentTool<typeof readSourceSchema> = {
    name: "read_source_document",
    description: "Read one uploaded source document's structure and text for comparison. The source role is included so template, example and auxiliary material stay distinct; this never modifies a document.",
    inputSchema: readSourceSchema,
    async execute(input) {
      const payload = await sources.load(taskId, input.sourceFileId);
      if (!payload) throw new Error("SOURCE_DOCUMENT_NOT_FOUND");
      const inspection = await documents.inspect(payload.bytes);
      if (inspection.diagnostics.some(({ severity }) => severity === "error")) {
        throw new Error("SOURCE_DOCUMENT_INSPECTION_FAILED");
      }
      return {
        sourceFileId: payload.descriptor.sourceFileId,
        role: payload.descriptor.role,
        originalName: payload.descriptor.originalName,
        revision: inspection.manifest.revision,
        summary: inspectionSummary(inspection),
        regions: compactInspection(inspection, input.maxCharacters),
      };
    },
  };

  return [list, read];
}

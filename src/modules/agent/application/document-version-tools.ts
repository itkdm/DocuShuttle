import { z } from "zod";

import type { AgentTool } from "./loop";

/**
 * The version boundary deliberately knows nothing about Supabase, storage, or
 * HTTP. An infrastructure adapter binds it to one task/run before tools are
 * registered. This keeps the Agent loop composable and makes version actions
 * available to other runtimes (local fixtures, jobs, or another database).
 */
export type DocumentVersionSummary = {
  id: string;
  number: number;
  origin: "import" | "user" | "agent" | "restore";
  revision: string;
  createdAt: string;
};

export type DocumentVersionAccessPort = {
  list(): Promise<{
    currentVersionId: string;
    versions: readonly DocumentVersionSummary[];
  }>;
  /** Records an export for the current immutable version and returns a short-lived URL. */
  exportCurrent(): Promise<{
    exportId: string;
    versionId: string;
    versionNumber: number;
    revision: string;
    downloadUrl: string;
  }>;
  /** Creates a new restore version; the source version itself remains immutable. */
  restore(input: {
    versionId: string;
    expectedRevision?: string;
  }): Promise<{
    versionId: string;
    versionNumber: number;
    revision: string;
  }>;
};

const emptySchema = z.object({});
const restoreSchema = z.object({
  versionId: z.string().trim().min(1).max(200),
  expectedRevision: z.string().trim().min(1).max(300).optional(),
});

export function createDocumentVersionTools(
  versions: DocumentVersionAccessPort,
): readonly AgentTool[] {
  const listVersions: AgentTool<typeof emptySchema> = {
    name: "list_document_versions",
    description:
      "List immutable versions of the current Word document, including the active version, origin, revision and creation time. Read-only.",
    inputSchema: emptySchema,
    async execute() {
      return versions.list();
    },
  };

  const exportDocument: AgentTool<typeof emptySchema> = {
    name: "export_document",
    description:
      "Export the current immutable document version and return a short-lived download URL. This does not modify document content.",
    inputSchema: emptySchema,
    async execute() {
      return versions.exportCurrent();
    },
  };

  const restoreDocumentVersion: AgentTool<typeof restoreSchema> = {
    name: "restore_document_version",
    description:
      "Restore a selected immutable document version by creating a new restore version. The source version is never overwritten and this action requires user approval.",
    requiresApproval: true,
    inputSchema: restoreSchema,
    async execute(input) {
      return versions.restore(input);
    },
  };

  return [listVersions, exportDocument, restoreDocumentVersion];
}

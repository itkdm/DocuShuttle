import { z } from "zod";

import type { DocumentEnginePort } from "@/modules/documents/application/document-engine-port";
import type { DocumentInspection, MutationRequest, ParagraphAddress, TableCellAddress } from "@/modules/documents/domain/types";
import { blockingPackageErrors } from "@/modules/documents/infrastructure/ooxml/diagnostic-policy";

import type { AgentTool } from "./loop";

export type WorkingDocumentAccessPort = {
  load(): Promise<{ bytes: Uint8Array; revision: string }>;
  commit(input: {
    expectedRevision: string;
    bytes: Uint8Array;
    revision: string;
    changedEntries: readonly string[];
  }): Promise<{ revision: string }>;
};

const nodeIdSchema = z.string().trim().min(1).max(300);
const emptySchema = z.object({});
const regionListSchema = z.object({
  kind: z.enum(["all", "paragraph", "table-cell", "image"]).default("all"),
  offset: z.number().int().min(0).max(10_000).default(0),
  limit: z.number().int().min(1).max(80).default(80),
});
const regionReadSchema = z.object({ nodeId: nodeIdSchema });
const textChangeSchema = z.object({
  nodeId: nodeIdSchema,
  expectedRevision: z.string().trim().min(1).max(300),
  expectedText: z.string().min(1).max(20_000),
  replacement: z.string().min(1).max(20_000),
  formatPolicy: z.enum(["inherit-start"]).optional(),
});
const textChangesSchema = z.object({
  expectedRevision: z.string().trim().min(1).max(300),
  changes: z.array(z.object({
    nodeId: nodeIdSchema,
    expectedText: z.string().min(1).max(20_000),
    replacement: z.string().min(1).max(20_000),
    formatPolicy: z.enum(["inherit-start"]).optional(),
  })).min(2).max(30),
});

const planTextChangeSchema = textChangeSchema;

const summarizeInspection = (inspection: DocumentInspection) => ({
  revision: inspection.manifest.revision,
  counts: {
    paragraphs: inspection.paragraphs.length,
    tableCells: inspection.tableCells.length,
    images: inspection.images.length,
  },
  diagnostics: inspection.diagnostics,
  validation: inspection.validation,
});

async function inspectCurrent(
  documents: DocumentEnginePort,
  working: WorkingDocumentAccessPort,
): Promise<{ bytes: Uint8Array; inspection: DocumentInspection }> {
  const current = await working.load();
  const inspection = await documents.inspect(current.bytes);
  if (inspection.manifest.revision !== current.revision) {
    throw new Error("WORKING_DOCUMENT_REVISION_MISMATCH");
  }
  if (blockingPackageErrors(inspection.diagnostics).length > 0) {
    throw new Error("WORKING_DOCUMENT_INSPECTION_FAILED");
  }
  return { bytes: current.bytes, inspection };
}

async function planIfAvailable(
  documents: DocumentEnginePort,
  bytes: Uint8Array,
  request: MutationRequest,
) {
  return documents.planMutation ? documents.planMutation(bytes, request) : undefined;
}

export function createDocumentTools(
  documents: DocumentEnginePort,
  working: WorkingDocumentAccessPort,
): readonly AgentTool[] {
  const inspectDocument: AgentTool<typeof emptySchema> = {
    name: "inspect_document",
    description: "Read the current Word document structure, counts, diagnostics and revision without modifying it.",
    inputSchema: emptySchema,
    async execute() {
      const { inspection } = await inspectCurrent(documents, working);
      return summarizeInspection(inspection);
    },
  };

  const listRegions: AgentTool<typeof regionListSchema> = {
    name: "list_document_regions",
    description: "List one bounded page (maximum 80) of stable document nodes and short text previews. Use offset to inspect another page; do not request the entire document unless necessary.",
    inputSchema: regionListSchema,
    async execute(input) {
      const { inspection } = await inspectCurrent(documents, working);
      const matched = inspection.manifest.nodes.filter((node) => input.kind === "all" || node.kind === input.kind);
      const nodes = matched.slice(input.offset, input.offset + input.limit);
      const textByNodeId = new Map([
        ...inspection.paragraphs.map((paragraph) => [paragraph.address.nodeId, paragraph.text] as const),
        ...inspection.tableCells.map((cell) => [cell.address.nodeId, cell.text] as const),
      ]);
      return {
        revision: inspection.manifest.revision,
        total: matched.length,
        offset: input.offset,
        hasMore: input.offset + nodes.length < matched.length,
        nodes: nodes.map((node) => {
          const text = textByNodeId.get(node.nodeId);
          return {
            nodeId: node.nodeId,
            kind: node.kind,
            story: node.locator?.story,
            fingerprint: node.fingerprint,
            capabilities: node.capabilities,
            ...(text === undefined ? {} : { text: text.length > 240 ? `${text.slice(0, 240)}…` : text }),
          };
        }),
      };
    },
  };

  const readRegion: AgentTool<typeof regionReadSchema> = {
    name: "read_document_region",
    description: "Read the current text for one stable paragraph or table-cell node.",
    inputSchema: regionReadSchema,
    async execute(input) {
      const { inspection } = await inspectCurrent(documents, working);
      const paragraph = inspection.paragraphs.find(({ address }) => address.nodeId === input.nodeId);
      if (paragraph) return { revision: inspection.manifest.revision, nodeId: input.nodeId, kind: "paragraph", text: paragraph.text };
      const cell = inspection.tableCells.find(({ address }) => address.nodeId === input.nodeId);
      if (cell) return { revision: inspection.manifest.revision, nodeId: input.nodeId, kind: "table-cell", text: cell.text };
      throw new Error("DOCUMENT_REGION_NOT_FOUND");
    },
  };

  const planTextChange: AgentTool<typeof planTextChangeSchema> = {
    name: "plan_text_change",
    description: "Dry-run one exact text replacement and return the targets, changed parts, risk and validation diagnostics. This never writes the document and does not require approval.",
    inputSchema: planTextChangeSchema,
    async execute(input) {
      const current = await inspectCurrent(documents, working);
      if (current.inspection.manifest.revision !== input.expectedRevision) throw new Error("DOCUMENT_REVISION_CONFLICT");
      const paragraph = current.inspection.paragraphs.find(({ address }) => address.nodeId === input.nodeId);
      const cell = current.inspection.tableCells.find(({ address }) => address.nodeId === input.nodeId);
      if (!paragraph && !cell) throw new Error("DOCUMENT_REGION_NOT_FOUND");
      const operation = paragraph
        ? { kind: "replace-text" as const, address: paragraph.address as ParagraphAddress, expectedText: input.expectedText, replacement: input.replacement, ...(input.formatPolicy ? { formatPolicy: input.formatPolicy } : {}) }
        : { kind: "set-cell-text" as const, address: cell!.address as TableCellAddress, expectedText: input.expectedText, text: input.replacement };
      if (!documents.planMutation) throw new Error("DOCUMENT_DRY_RUN_UNAVAILABLE");
      const plan = await documents.planMutation(current.bytes, { expectedRevision: input.expectedRevision, operations: [operation] });
      return {
        baseRevision: plan.baseRevision,
        targets: plan.targets,
        operations: plan.operations.map((planned) => ({
          kind: planned.kind,
          nodeId: planned.address.nodeId,
          ...(planned.kind === "replace-text"
            ? { expectedText: planned.expectedText, replacement: planned.replacement }
            : planned.kind === "set-cell-text"
              ? { expectedText: planned.expectedText, replacement: planned.text }
              : {}),
        })),
        affectedPartCount: plan.changedParts.length,
        riskLevel: plan.riskLevel,
        expectedPostconditions: plan.expectedPostconditions,
        diagnostics: plan.diagnostics,
      };
    },
  };

  const applyTextChange: AgentTool<typeof textChangeSchema> = {
    name: "apply_text_change",
    description: "Apply one exact text replacement to a paragraph or table cell after the user approves it. Creates one immutable derived document version.",
    requiresApproval: true,
    inputSchema: textChangeSchema,
    async execute(input) {
      const current = await inspectCurrent(documents, working);
      if (current.inspection.manifest.revision !== input.expectedRevision) throw new Error("DOCUMENT_REVISION_CONFLICT");
      const paragraph = current.inspection.paragraphs.find(({ address }) => address.nodeId === input.nodeId);
      const cell = current.inspection.tableCells.find(({ address }) => address.nodeId === input.nodeId);
      if (!paragraph && !cell) throw new Error("DOCUMENT_REGION_NOT_FOUND");
      const operation = paragraph
        ? { kind: "replace-text" as const, address: paragraph.address as ParagraphAddress, expectedText: input.expectedText, replacement: input.replacement, ...(input.formatPolicy ? { formatPolicy: input.formatPolicy } : {}) }
        : { kind: "set-cell-text" as const, address: cell!.address as TableCellAddress, expectedText: input.expectedText, text: input.replacement };
      const plan = await planIfAvailable(documents, current.bytes, { expectedRevision: input.expectedRevision, operations: [operation] });
      const mutation = await documents.mutate(current.bytes, { expectedRevision: input.expectedRevision, operations: [operation] });
      const validated = await documents.validate(mutation.bytes);
      if (blockingPackageErrors(validated.diagnostics).length > 0) throw new Error("DERIVED_DOCUMENT_VALIDATION_FAILED");
      const committed = await working.commit({ expectedRevision: input.expectedRevision, bytes: mutation.bytes, revision: mutation.manifest.revision, changedEntries: mutation.changedEntries });
      return {
        nodeId: input.nodeId,
        previousRevision: input.expectedRevision,
        revision: committed.revision,
        changedEntries: mutation.changedEntries,
        riskLevel: plan?.riskLevel,
        validation: mutation.validation ? { valid: mutation.validation.valid, tiers: mutation.validation.tiers.map(({ tier, status }) => ({ tier, status })) } : undefined,
      };
    },
  };

  const applyTextChanges: AgentTool<typeof textChangesSchema> = {
    name: "apply_text_changes",
    description: "Atomically apply two to thirty exact text replacements to known paragraph or table-cell nodes. Validates every target first, then creates one immutable derived version. Use this for a bounded multi-location edit.",
    requiresApproval: true,
    inputSchema: textChangesSchema,
    async execute(input) {
      const current = await inspectCurrent(documents, working);
      if (current.inspection.manifest.revision !== input.expectedRevision) throw new Error("DOCUMENT_REVISION_CONFLICT");
      const seen = new Set<string>();
      const operations = input.changes.map((change) => {
        if (seen.has(change.nodeId)) throw new Error("DUPLICATE_DOCUMENT_REGION");
        seen.add(change.nodeId);
        const paragraph = current.inspection.paragraphs.find(({ address }) => address.nodeId === change.nodeId);
        const cell = current.inspection.tableCells.find(({ address }) => address.nodeId === change.nodeId);
        if (!paragraph && !cell) throw new Error("DOCUMENT_REGION_NOT_FOUND");
        return paragraph
          ? { kind: "replace-text" as const, address: paragraph.address as ParagraphAddress, expectedText: change.expectedText, replacement: change.replacement, ...(change.formatPolicy ? { formatPolicy: change.formatPolicy } : {}) }
          : { kind: "set-cell-text" as const, address: cell!.address as TableCellAddress, expectedText: change.expectedText, text: change.replacement };
      });
      const plan = await planIfAvailable(documents, current.bytes, { expectedRevision: input.expectedRevision, operations });
      const mutation = await documents.mutate(current.bytes, { expectedRevision: input.expectedRevision, operations });
      const validated = await documents.validate(mutation.bytes);
      if (blockingPackageErrors(validated.diagnostics).length > 0) throw new Error("DERIVED_DOCUMENT_VALIDATION_FAILED");
      const committed = await working.commit({ expectedRevision: input.expectedRevision, bytes: mutation.bytes, revision: mutation.manifest.revision, changedEntries: mutation.changedEntries });
      return {
        changedCount: input.changes.length,
        nodeIds: input.changes.map((change) => change.nodeId),
        previousRevision: input.expectedRevision,
        revision: committed.revision,
        changedEntries: mutation.changedEntries,
        riskLevel: plan?.riskLevel,
        validation: mutation.validation ? { valid: mutation.validation.valid, tiers: mutation.validation.tiers.map(({ tier, status }) => ({ tier, status })) } : undefined,
      };
    },
  };

  return [inspectDocument, listRegions, readRegion, planTextChange, applyTextChange, applyTextChanges];
}

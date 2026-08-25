import { z } from "zod";

export const regionIntentSchema = z.enum([
  "keep",
  "regenerate",
  "uncertain",
  "locked",
]);

export const documentPlanSchema = z.object({
  summary: z.string().min(1).max(2_000),
  scope: z.enum(["local", "multi_region", "document_wide"]),
  requiresApproval: z.boolean(),
  regions: z
    .array(
      z.object({
        nodeId: z.string().min(1),
        intent: regionIntentSchema,
        reason: z.string().min(1).max(1_000),
        instruction: z.string().max(4_000).optional(),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(500),
  questions: z.array(z.string().min(1).max(1_000)).max(20),
  risks: z.array(z.string().min(1).max(1_000)).max(50),
});

export type DocumentPlan = z.infer<typeof documentPlanSchema>;

export type DocumentContextRegion = {
  nodeId: string;
  kind: "paragraph" | "tableCell" | "image";
  text?: string;
  locked: boolean;
  support: "editable" | "read_only" | "unsupported";
};

export type PlanDocumentInput = {
  goal: string;
  baseRevision: string;
  templateRules?: string;
  regions: DocumentContextRegion[];
};

export type GeneratedImage = {
  mimeType: string;
  bytes?: Uint8Array;
  remoteUrl?: string;
  revisedPrompt?: string;
  providerRequestId?: string;
};

export const generatedRegionTextSchema = z.object({
  replacement: z.string().min(1).max(12_000),
  rationale: z.string().min(1).max(1_000),
});

export type GeneratedRegionText = z.infer<typeof generatedRegionTextSchema>;

import type { SupabaseClient } from "@supabase/supabase-js";

import type { StepExecutionContext, StepExecutionResult, AgentStepExecutor } from "../application/ports";
import { StepExecutionError } from "../domain/errors";
import type { SideEffectReceipt } from "../domain/model";
import type {
  DocumentEnginePort,
  DocumentInspection,
  DocumentMutation,
  StableDocumentAddress,
} from "@/modules/documents";
import type { TextReasoningPort } from "@/modules/generation/ports";
import { buildTaskObjectKey } from "@/modules/storage/object-key";
import type { PrivateObjectStoragePort } from "@/modules/storage/ports";

type RegionSnapshot = {
  nodeId: string;
  kind: "paragraph" | "tableCell";
  text: string;
  address: StableDocumentAddress;
};

type AnalysisOutput = {
  taskId: string;
  goal: string;
  plan: Awaited<ReturnType<TextReasoningPort["planDocument"]>>;
  regions: RegionSnapshot[];
};

type GenerationOutput = {
  taskId: string;
  operations: DocumentMutation[];
  rationale: string;
};

const parseReceipt = <T>(receipts: readonly SideEffectReceipt[], effect: SideEffectReceipt["effect"]): T => {
  const receipt = receipts.find((candidate) => candidate.effect === effect);
  if (!receipt) throw new StepExecutionError("PRIOR_STEP_RECEIPT_MISSING", `Missing ${effect} receipt.`, false);
  try {
    return JSON.parse(receipt.outputRef) as T;
  } catch {
    throw new StepExecutionError("PRIOR_STEP_OUTPUT_INVALID", `Invalid ${effect} output.`, false);
  }
};

const ensureInspectionIsWritable = (inspection: DocumentInspection) => {
  const errors = inspection.diagnostics.filter(({ severity }) => severity === "error");
  if (errors.length) {
    throw new StepExecutionError(
      "DOCUMENT_UNSAFE_TO_EDIT",
      "The document contains unsupported or invalid OOXML constructs.",
      false,
      { codes: errors.map(({ code }) => code).join(",") },
    );
  }
};

export class PaperDuckStepExecutor implements AgentStepExecutor {
  constructor(
    private readonly client: SupabaseClient,
    private readonly storage: PrivateObjectStoragePort,
    private readonly documents: DocumentEnginePort,
    private readonly reasoning: TextReasoningPort,
  ) {}

  async executeOnce(context: StepExecutionContext): Promise<StepExecutionResult> {
    switch (context.step.kind) {
      case "analyze": return this.analyze(context);
      case "generate": return this.generate(context);
      case "apply": return this.apply(context);
      case "validate": return this.validate(context);
    }
  }

  private async analyze(context: StepExecutionContext): Promise<StepExecutionResult> {
    const current = await this.loadCurrentDocument(context.run.documentId);
    const bytes = await this.storage.get(current.objectKey);
    const inspection = await this.documents.inspect(bytes);
    ensureInspectionIsWritable(inspection);
    const regions: RegionSnapshot[] = [
      ...inspection.tableCells
        .filter(({ text }) => text.trim().length > 0)
        .slice(0, 60)
        .map((region) => ({ nodeId: region.address.nodeId, kind: "tableCell" as const, text: region.text, address: region.address })),
      ...inspection.paragraphs
        .filter(({ text, address }) => text.trim().length > 0 && address.entry === "word/document.xml")
        .slice(0, 60)
        .map((region) => ({ nodeId: region.address.nodeId, kind: "paragraph" as const, text: region.text, address: region.address })),
    ];
    if (!regions.length) throw new StepExecutionError("NO_EDITABLE_REGION", "No editable text region was found.", false);

    const plan = await this.reasoning.planDocument({
      goal: current.goal,
      baseRevision: context.run.baseRevision,
      regions: regions.map((region) => ({
        nodeId: region.nodeId,
        kind: region.kind,
        text: region.text,
        locked: false,
        support: "editable" as const,
      })),
    });
    const output: AnalysisOutput = { taskId: current.taskId, goal: current.goal, plan, regions };
    return {
      outputRef: JSON.stringify(output),
      proposal: {
        id: crypto.randomUUID(),
        baseRevision: context.run.baseRevision,
        summary: plan.summary,
        risk: plan.requiresApproval || plan.scope !== "local" ? "high" : "low",
      },
    };
  }

  private async generate(context: StepExecutionContext): Promise<StepExecutionResult> {
    const analysis = parseReceipt<AnalysisOutput>(context.run.receipts, "analyze");
    const targets = analysis.plan.regions
      .filter(({ intent, nodeId }) =>
        (intent === "regenerate" || intent === "uncertain") && analysis.regions.some((region) => region.nodeId === nodeId),
      )
      .slice(0, 40);
    if (!targets.length) {
      throw new StepExecutionError("NO_GENERATION_TARGET", "The approved plan contains no regeneratable region.", false);
    }
    const operations: DocumentMutation[] = [];
    const rationales: string[] = [];
    for (const desired of targets) {
      const target = analysis.regions.find(({ nodeId }) => nodeId === desired.nodeId);
      if (!target) continue;
      const generated = await this.reasoning.generateRegionText({
        goal: analysis.goal,
        currentText: target.text,
        regionKind: target.kind,
        instruction: desired.instruction,
      });
      operations.push(target.kind === "tableCell"
        ? {
            kind: "set-cell-text",
            address: target.address as Extract<StableDocumentAddress, { kind: "table-cell" }>,
            expectedText: target.text,
            expectedHash: target.address.fingerprint,
            text: generated.replacement,
          }
        : {
            kind: "replace-text",
            address: target.address as Extract<StableDocumentAddress, { kind: "paragraph" }>,
            expectedText: target.text,
            replacement: generated.replacement,
          });
      rationales.push(`${target.nodeId}: ${generated.rationale}`);
    }
    if (!operations.length) throw new StepExecutionError("NO_GENERATION_TARGET", "No plan region could be resolved in the current document.", false);
    const output: GenerationOutput = { taskId: analysis.taskId, operations, rationale: rationales.join("\n") };
    return { outputRef: JSON.stringify(output) };
  }

  private async apply(context: StepExecutionContext): Promise<StepExecutionResult> {
    const generated = parseReceipt<GenerationOutput>(context.run.receipts, "generate");
    const current = await this.loadCurrentDocument(context.run.documentId);
    const source = await this.storage.get(current.objectKey);
    const request = {
      expectedRevision: context.run.baseRevision,
      operations: generated.operations,
    } as const;
    const plan = this.documents.planMutation ? await this.documents.planMutation(source, request) : undefined;
    const result = await this.documents.mutate(source, request);
    const fileId = crypto.randomUUID();
    const objectKey = buildTaskObjectKey({
      userId: current.ownerUserId,
      taskId: generated.taskId,
      category: "versions",
      fileName: `${fileId}.docx`,
    });
    const manifestObjectKey = buildTaskObjectKey({
      userId: current.ownerUserId,
      taskId: generated.taskId,
      category: "manifests",
      fileName: `${fileId}.json`,
    });
    await this.storage.put(objectKey, result.bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    try {
      await this.storage.put(manifestObjectKey, new TextEncoder().encode(JSON.stringify(result.manifest)), "application/json");
    } catch (error) {
      await this.storage.remove(objectKey);
      throw error;
    }
    return {
      outputRef: JSON.stringify({
        objectKey,
        manifestObjectKey,
        operationLog: generated.operations.map((operation) => ({ kind: operation.kind, rationale: generated.rationale })),
        riskLevel: plan?.riskLevel,
      }),
      derivedRevision: result.manifest.revision,
    };
  }

  private async validate(context: StepExecutionContext): Promise<StepExecutionResult> {
    const apply = context.run.receipts.find((receipt) => receipt.effect === "apply");
    if (!apply) throw new StepExecutionError("APPLY_RECEIPT_MISSING", "Cannot validate without an applied artifact.", false);
    let artifact: { objectKey?: string };
    try {
      artifact = JSON.parse(apply.outputRef) as { objectKey?: string };
    } catch {
      throw new StepExecutionError("APPLY_OUTPUT_INVALID", "The applied artifact receipt is invalid.", false);
    }
    if (!artifact.objectKey) throw new StepExecutionError("APPLY_OBJECT_MISSING", "The applied artifact has no object key.", false);
    const inspection = await this.documents.validate(await this.storage.get(artifact.objectKey));
    ensureInspectionIsWritable(inspection);
    return {
      outputRef: JSON.stringify({
        revision: inspection.manifest.revision,
        paragraphs: inspection.paragraphs.length,
        tableCells: inspection.tableCells.length,
        images: inspection.images.length,
      }),
    };
  }

  private async loadCurrentDocument(documentId: string) {
    const document = await this.client
      .from("working_documents")
      .select("owner_user_id, task_id, current_version_id")
      .eq("id", documentId)
      .single();
    if (document.error || !document.data) throw new StepExecutionError("DOCUMENT_NOT_FOUND", "Working document was not found.", false);
    const version = await this.client
      .from("document_versions")
      .select("object_key")
      .eq("id", document.data.current_version_id)
      .single();
    if (version.error || !version.data) throw new StepExecutionError("DOCUMENT_VERSION_NOT_FOUND", "Current document version was not found.", false);
    const task = await this.client.from("tasks").select("goal").eq("id", document.data.task_id).single();
    if (task.error || !task.data) throw new StepExecutionError("TASK_NOT_FOUND", "Task was not found.", false);
    return {
      ownerUserId: document.data.owner_user_id as string,
      taskId: document.data.task_id as string,
      objectKey: version.data.object_key as string,
      goal: task.data.goal as string,
    };
  }
}

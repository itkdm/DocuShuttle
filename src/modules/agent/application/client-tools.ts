import { z } from "zod";

import type { AgentTool } from "./loop";

export const captureDocumentViewInputSchema = z.object({ target: z.literal("visible") }).strict();
export const scrollDocumentViewInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("relative"), direction: z.enum(["up", "down"]), amount: z.enum(["small", "viewport"]) }).strict(),
  z.object({ kind: z.literal("edge"), target: z.enum(["top", "bottom"]) }).strict(),
]);

/** Client tool declarations are intentionally execution-free on the server. */
export function createClientDocumentTools(): readonly AgentTool[] {
  const captureDocumentView: AgentTool<typeof captureDocumentViewInputSchema> = {
    name: "capture_document_view",
    description: "只捕获当前 Working Document 的可视区域，并返回一个 screenshot asset；它本身不执行视觉理解。如果需要判断排版、图片、表格、重叠、对齐等视觉内容，截图成功后继续调用 inspect_image，source=asset，assetId 使用截图结果。普通文本内容应优先使用文档读取工具。",
    inputSchema: captureDocumentViewInputSchema,
    clientExecution: true,
    async execute() {
      throw new Error("CLIENT_TOOL_EXECUTION_REQUIRED");
    },
  };
  const scrollDocumentView: AgentTool<typeof scrollDocumentViewInputSchema> = {
    name: "scroll_document_view",
    description: "只移动当前 Working Document 的浏览视口，不读取文档、不截图、不执行 Vision、不修改 DOCX、不产生 Document Version。滚动后如需观察新区域，请继续调用 capture_document_view，再调用 inspect_image。到达 atBottom=true 或 atTop=true 时不要继续向该方向滚动。视觉浏览长文档时应按 capture_document_view → inspect_image → scroll_document_view → capture_document_view → inspect_image 的顺序进行。",
    inputSchema: scrollDocumentViewInputSchema,
    clientExecution: true,
    async execute() {
      throw new Error("CLIENT_TOOL_EXECUTION_REQUIRED");
    },
  };
  return [captureDocumentView, scrollDocumentView];
}

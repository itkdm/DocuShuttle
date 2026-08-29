import { z } from "zod";

import type { AgentTool } from "./loop";

export const captureDocumentViewInputSchema = z.object({ target: z.literal("visible") }).strict();

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
  return [captureDocumentView];
}

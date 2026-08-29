import { z } from "zod";

import type { AgentTool } from "./loop";

export const captureDocumentViewInputSchema = z.discriminatedUnion("target", [
  z.object({ target: z.literal("visible"), expectedRevision: z.string().min(1).max(200) }),
  z.object({ target: z.literal("page"), pageNumber: z.number().int().positive().max(10_000), expectedRevision: z.string().min(1).max(200) }),
]);

/** Client tool declarations are intentionally execution-free on the server. */
export function createClientDocumentTools(): readonly AgentTool[] {
  const captureDocumentView: AgentTool<typeof captureDocumentViewInputSchema> = {
    name: "capture_document_view",
    description: "查看 Working Document 的实际视觉布局，用于检查排版、字体、表格、图片、页眉页脚、分页、空白、对齐或重叠问题；普通文本内容应优先使用文档读取工具。",
    inputSchema: captureDocumentViewInputSchema,
    clientExecution: true,
    async execute() {
      throw new Error("CLIENT_TOOL_EXECUTION_REQUIRED");
    },
  };
  return [captureDocumentView];
}

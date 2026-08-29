// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AgentImageActivity } from "./agent-image-activity";
import type { AgentActivity } from "./agent-thread-projection";

const activity = (overrides: Partial<Extract<AgentActivity, { type: "tool" }>>) => ({
  type: "tool" as const, id: "activity-1", callId: "call-1", name: "generate_image", state: "completed" as const, ...overrides,
});

describe("Agent image activity", () => {
  afterEach(() => cleanup());

  it("renders a generated asset through the authenticated same-origin preview", () => {
    render(<AgentImageActivity taskId="task-1" activity={activity({ output: { assetId: "asset-1", purpose: "similar", referenceCount: 2 } })} deciding={false} />);
    expect(screen.getByText("生成图片")).toBeTruthy();
    expect(screen.queryByText(/保持参考图片风格|参考 2 张图片/)).toBeNull();
    expect(screen.getByAltText("生成结果").getAttribute("src")).toContain("/api/tasks/task-1/images/asset-1");
    fireEvent.click(screen.getByText("工具详情"));
    expect(screen.getByText(/"purpose":\s*"similar"/)).toBeTruthy();
    expect(screen.getByText(/"referenceCount":\s*2/)).toBeTruthy();
    expect(screen.queryByText(/候选|应用此/)).toBeNull();
  });

  it("keeps inspect rich results minimal while preserving raw analysis details", () => {
    render(<AgentImageActivity taskId="task-1" activity={activity({ name: "inspect_image", output: { source: "asset", assetId: "asset-1", analysis: { summary: "深色终端截图", type: "终端截图", style: "深色", visibleText: ["one"] }, } })} deciding={false} />);
    expect(screen.queryByText("终端截图 · 深色")).toBeNull();
    expect(screen.queryByText("深色终端截图")).toBeNull();
    expect(screen.queryByText("one")).toBeNull();
    expect(screen.queryByText("internal prompt")).toBeNull();
    expect(screen.getByText("工具详情")).toBeTruthy();
    expect(screen.queryByText("技术详情")).toBeNull();
    fireEvent.click(screen.getByText("工具详情"));
    expect(screen.getByText(/"summary":\s*"深色终端截图"/)).toBeTruthy();
    expect(screen.getByText(/"one"/)).toBeTruthy();
  });

  it("renders replace approval with before/after previews and existing decisions", () => {
    const onApproval = () => undefined;
    render(<AgentImageActivity taskId="task-1" activity={activity({ name: "replace_document_image", state: "approval", input: { targetNodeId: "node-1", assetId: "asset-1", expectedRevision: "rev-1" } })} onApproval={onApproval} deciding={false} />);
    expect(screen.getByText("替换文档图片")).toBeTruthy();
    expect(screen.getByText("等待你的确认")).toBeTruthy();
    expect(screen.getByText("批准并替换")).toBeTruthy();
    expect(screen.getByText("拒绝")).toBeTruthy();
    expect(screen.getByText("当前图片")).toBeTruthy();
    expect(screen.getByText("替换为")).toBeTruthy();
    expect(screen.queryByText("确认后会把当前图片替换为生成结果。")).toBeNull();
    expect(screen.getByAltText("当前文档图片").getAttribute("src")).toContain("/api/tasks/task-1/document/images/node-1?revision=rev-1");
    expect(screen.getByAltText("生成替换图片").getAttribute("src")).toContain("/api/tasks/task-1/images/asset-1");
  });

  it("falls back safely for malformed historical payloads", () => {
    expect(() => render(<AgentImageActivity taskId="task-1" activity={activity({ name: "inspect_image", output: "not-an-object" })} deciding={false} />)).not.toThrow();
    expect(screen.getByText("分析图片")).toBeTruthy();
  });
});

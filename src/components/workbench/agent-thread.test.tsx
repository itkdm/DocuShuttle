// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AgentThread } from "./agent-thread";
import type { AgentActivity } from "./agent-thread-projection";

const renderActivity = (activity: AgentActivity) => render(<AgentThread
  turns={[{ id: "turn-1", runId: "run-1", anchor: "2026-01-01", user: { id: "user-1", content: "检查", deliveryStatus: "sent" }, assistant: { status: activity.type === "tool" && activity.state === "failed" ? "failed" : "completed", activities: [activity] } }]}
  conversationLoading={false} hasEarlierMessages={false} loadingEarlierMessages={false} deciding={false}
/>);

describe("Agent thread tool rows", () => {
  afterEach(() => cleanup());

  it("renders completed generic tools as static rows without an empty disclosure", () => {
    renderActivity({ type: "tool", id: "tool-1", callId: "call-1", name: "inspect_document", state: "completed", input: { secret: "hidden" }, output: { summary: "done" } });
    expect(screen.getByText("查找文档区域")).toBeTruthy();
    expect(screen.queryByText("工具详情")).toBeNull();
    expect(document.querySelector(".agent-tool-disclosure")).toBeNull();
    expect(screen.queryByText(/secret|summary|hidden|done/)).toBeNull();
  });

  it("keeps failed generic tool errors in the row without an empty disclosure", () => {
    renderActivity({ type: "tool", id: "tool-2", callId: "call-2", name: "inspect_document", state: "failed", error: "读取失败" });
    expect(screen.getByText("读取失败")).toBeTruthy();
    expect(screen.queryByText("工具详情")).toBeNull();
    expect(document.querySelector(".agent-tool-disclosure")).toBeNull();
  });
});

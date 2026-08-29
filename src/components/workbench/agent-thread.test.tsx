// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AgentThread } from "./agent-thread";
import type { AgentActivity } from "./agent-thread-projection";
import { shouldHoldConversationRestore } from "./progressive-restore";

const renderActivity = (activity: AgentActivity) => render(<AgentThread
  turns={[{ id: "turn-1", runId: "run-1", anchor: "2026-01-01", user: { id: "user-1", content: "检查", deliveryStatus: "sent" }, assistant: { status: activity.type === "tool" && activity.state === "failed" ? "failed" : "completed", activities: [activity] } }]}
  conversationLoading={false} hasEarlierMessages={false} loadingEarlierMessages={false} onApproval={() => undefined} deciding={false}
/>);

const turnFor = (status: "running" | "awaiting_approval" | "awaiting_user" | "completed" | "failed" | "cancelled") => ({
  id: "turn-status", runId: "run-status", anchor: "2026-01-01", user: { id: "user-status", content: "检查", deliveryStatus: "sent" as const },
  assistant: { status, activities: [{ type: "tool", id: "activity-status", callId: "call-status", name: "inspect_document", state: status === "awaiting_approval" ? "approval" : status === "completed" ? "completed" : status === "failed" ? "failed" : "running" }] as const },
});
const renderStatus = (status: Parameters<typeof turnFor>[0]) => render(<AgentThread turns={[turnFor(status)]} conversationLoading={false} hasEarlierMessages={false} loadingEarlierMessages={false} onApproval={() => undefined} deciding={false} />);

describe("Agent thread tool rows", () => {
  afterEach(() => cleanup());

  it("renders completed generic tools as static rows without an empty disclosure", () => {
    renderActivity({ type: "tool", id: "tool-1", callId: "call-1", name: "inspect_document", state: "completed", input: { secret: "hidden" }, output: { summary: "done" } });
    expect(screen.getByText("读取当前文档")).toBeTruthy();
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

  it("shows a safe before and after preview for a text mutation approval", () => {
    renderActivity({ type: "tool", id: "tool-3", callId: "call-3", name: "apply_text_change", state: "approval", input: { expectedText: "旧内容", replacement: "新内容", nodeId: "private-node", expectedRevision: "private-revision" } });
    expect(screen.getByText("旧内容")).toBeTruthy();
    expect(screen.getByText("新内容")).toBeTruthy();
    expect(screen.getByText("批准并执行")).toBeTruthy();
    expect(screen.getByText("拒绝")).toBeTruthy();
    expect(screen.queryByText("private-node")).toBeNull();
    expect(screen.queryByText("private-revision")).toBeNull();
    expect(screen.queryByText("工具详情")).toBeNull();
  });

  it("shows all text mutation previews inside a bounded approval body", () => {
    renderActivity({ type: "tool", id: "tool-4", callId: "call-4", name: "apply_text_changes", state: "approval", input: { changes: [{ expectedText: "第一处旧内容", replacement: "第一处新内容", nodeId: "node-1" }, { expectedText: "第二处旧内容", replacement: "第二处新内容", expectedRevision: "rev-2" }] } });
    expect(screen.getByText("将修改 2 处")).toBeTruthy();
    expect(screen.getByText("第一处旧内容")).toBeTruthy();
    expect(screen.getByText("第二处新内容")).toBeTruthy();
    expect(screen.getByText("批准并执行")).toBeTruthy();
    expect(screen.queryByText("node-1")).toBeNull();
    expect(screen.queryByText("rev-2")).toBeNull();
  });

  it("keeps completed text mutations as static rows", () => {
    renderActivity({ type: "tool", id: "tool-5", callId: "call-5", name: "apply_text_change", state: "completed", input: { expectedText: "旧内容", replacement: "新内容" } });
    expect(screen.getByText("修改当前文档")).toBeTruthy();
    expect(screen.queryByText("旧内容")).toBeNull();
    expect(screen.queryByText("新内容")).toBeNull();
    expect(document.querySelector(".agent-tool-disclosure")).toBeNull();
  });

  it("uses the human-readable planning label", () => {
    renderActivity({ type: "tool", id: "tool-6", callId: "call-6", name: "plan_text_change", state: "completed" });
    expect(screen.getByText("预演修改方案")).toBeTruthy();
    expect(screen.queryByText("执行文档操作")).toBeNull();
  });

  it("opens active execution and closes once when it reaches a terminal status", () => {
    const view = renderStatus("running");
    const details = () => document.querySelector(".agent-activity") as HTMLDetailsElement;
    expect(details().open).toBe(true);
    view.rerender(<AgentThread turns={[turnFor("completed")]} conversationLoading={false} hasEarlierMessages={false} loadingEarlierMessages={false} onApproval={() => undefined} deciding={false} />);
    expect(details().open).toBe(false);
  });

  it("closes approval and user-input execution when either completes", () => {
    for (const active of ["awaiting_approval", "awaiting_user"] as const) {
      const view = renderStatus(active);
      const details = () => document.querySelector(".agent-activity") as HTMLDetailsElement;
      expect(details().open).toBe(true);
      view.rerender(<AgentThread turns={[turnFor("completed")]} conversationLoading={false} hasEarlierMessages={false} loadingEarlierMessages={false} onApproval={() => undefined} deciding={false} />);
      expect(details().open).toBe(false);
      cleanup();
    }
  });

  it("closes active execution for failure and cancellation", () => {
    for (const terminal of ["failed", "cancelled"] as const) {
      const view = renderStatus("running");
      const details = () => document.querySelector(".agent-activity") as HTMLDetailsElement;
      view.rerender(<AgentThread turns={[turnFor(terminal)]} conversationLoading={false} hasEarlierMessages={false} loadingEarlierMessages={false} onApproval={() => undefined} deciding={false} />);
      expect(details().open).toBe(false);
      cleanup();
    }
  });

  it("keeps historical terminal execution closed but lets users reopen it", () => {
    const view = renderStatus("completed");
    const details = () => document.querySelector(".agent-activity") as HTMLDetailsElement;
    expect(details().open).toBe(false);
    fireEvent.click(details().querySelector("summary")!);
    expect(details().open).toBe(true);
    view.rerender(<AgentThread turns={[turnFor("completed")]} conversationLoading={false} hasEarlierMessages={false} loadingEarlierMessages={false} onApproval={() => undefined} deciding={false} />);
    expect(details().open).toBe(true);
  });

  it("keeps execution open across active-to-active transitions", () => {
    const view = renderStatus("awaiting_approval");
    const details = () => document.querySelector(".agent-activity") as HTMLDetailsElement;
    view.rerender(<AgentThread turns={[turnFor("running")]} conversationLoading={false} hasEarlierMessages={false} loadingEarlierMessages={false} onApproval={() => undefined} deciding={false} />);
    expect(details().open).toBe(true);
  });
});

describe("initial conversation restore", () => {
  it("does not render partial turns while the restore barrier is active", () => {
    render(<AgentThread turns={[turnFor("completed")]} conversationLoading hasEarlierMessages={false} loadingEarlierMessages={false} onApproval={() => undefined} deciding={false} />);
    expect(screen.getByText("正在恢复这个任务的对话…")).toBeTruthy();
    expect(screen.queryByText("检查")).toBeNull();
  });

  it("holds the presentation until both initial projections settle", () => {
    expect(shouldHoldConversationRestore({ routeTaskId: "task-1", conversationLoading: true, historicalTimelineReady: true, liveRun: false })).toBe(true);
    expect(shouldHoldConversationRestore({ routeTaskId: "task-1", conversationLoading: false, historicalTimelineReady: false, liveRun: false })).toBe(true);
    expect(shouldHoldConversationRestore({ routeTaskId: "task-1", conversationLoading: false, historicalTimelineReady: true, liveRun: false })).toBe(false);
  });

  it("does not hold a live run or pagination behind initial restore", () => {
    expect(shouldHoldConversationRestore({ routeTaskId: "task-1", conversationLoading: true, historicalTimelineReady: false, liveRun: true })).toBe(false);
    expect(shouldHoldConversationRestore({ conversationLoading: false, historicalTimelineReady: false, liveRun: false })).toBe(false);
  });
});

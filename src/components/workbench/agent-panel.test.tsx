// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentPanel } from "./agent-panel";
import type { AgentRuntimeView } from "./runtime-view-state";
import type { AgentImageAttachment } from "@/modules/agent/application/message-parts";

const uploadBrowserImage = vi.hoisted(() => vi.fn());
vi.mock("@/modules/uploads/browser-image-upload", () => ({ uploadBrowserImage }));

afterEach(() => cleanup());

const idleView: AgentRuntimeView = { runtimeStatus: "idle", isRunning: false, isAwaitingApproval: false, isAwaitingUser: false, isTerminal: false, canCancel: false, canSend: true, permissionLocked: false };

describe("AgentPanel image submission", () => {
  it("keeps the payload locked during upload and clears it only after run acceptance", async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    let finishUpload!: (value: { assetId: string; mimeType: "image/png" }) => void;
    uploadBrowserImage.mockReturnValueOnce(new Promise((resolve) => { finishUpload = resolve; }));
    const onRun = vi.fn((_prompt: string, attachments: readonly AgentImageAttachment[] = [], lifecycle?: { accepted: () => void; failed: () => void }) => { expect(attachments).toHaveLength(1); lifecycle?.accepted(); });
    const file = new File(["png"], "sample.png", { type: "image/png" });

    render(<AgentPanel runtimeView={idleView} onCollapse={() => undefined} onRun={onRun} onCancel={() => undefined} workspaceReady taskId="task-1" permissionMode="default" onPermissionModeChange={() => undefined} />);
    const prompt = screen.getByRole("textbox");
    fireEvent.change(prompt, { target: { value: "看这张图" } });
    fireEvent.paste(prompt, { clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }] } });
    fireEvent.click(screen.getByRole("button", { name: "发送要求" }));

    await waitFor(() => expect((prompt as HTMLTextAreaElement).readOnly).toBe(true));
    expect((screen.getByRole("button", { name: "发送要求" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onRun).not.toHaveBeenCalled();

    finishUpload({ assetId: "asset-1", mimeType: "image/png" });
    await waitFor(() => expect(onRun).toHaveBeenCalledOnce());
    await waitFor(() => expect((prompt as HTMLTextAreaElement).value).toBe(""));
    expect((prompt as HTMLTextAreaElement).readOnly).toBe(false);
  });

  it("does not let a stale acceptance clear a newer prompt", async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    let accept!: () => void;
    const onRun = vi.fn((_prompt: string, attachments: readonly AgentImageAttachment[] = [], lifecycle?: { accepted: () => void; failed: () => void }) => { void attachments; accept = lifecycle!.accepted; });

    render(<AgentPanel runtimeView={idleView} onCollapse={() => undefined} onRun={onRun} onCancel={() => undefined} workspaceReady taskId="task-1" permissionMode="default" onPermissionModeChange={() => undefined} />);
    const prompt = screen.getByRole("textbox");
    fireEvent.change(prompt, { target: { value: "第一条" } });
    fireEvent.click(screen.getByRole("button", { name: "发送要求" }));
    await waitFor(() => expect(onRun).toHaveBeenCalledOnce());

    fireEvent.change(prompt, { target: { value: "后来输入" } });
    accept();
    expect((prompt as HTMLTextAreaElement).value).toBe("后来输入");
  });
});

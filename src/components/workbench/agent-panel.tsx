import { Check, ChevronDown, PanelRightClose, Send, Shield, Sparkles, StopCircle, Unlock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import type { AgentRuntimeView } from "./runtime-view-state";
import type { BrowserImageCandidate, BrowserImageNode } from "@/modules/agent/browser-runtime";
import type { AgentEvent } from "@/modules/agent/application/events";
import type { AgentRun } from "@/modules/agent";
import type { AgentPermissionMode } from "@/modules/agent/application/loop";
import type { ConversationMessage } from "./conversation-store";
import { AgentThread } from "./agent-thread";
import { projectAgentThread } from "./agent-thread-projection";

interface AgentPanelProps {
  runtimeView: AgentRuntimeView; onCollapse: () => void;
  onRun: (prompt: string) => void | Promise<void>; onCancel: () => void | Promise<void>;
  workspaceReady: boolean;
  imageCandidates?: BrowserImageCandidate[];
  imageTargetNodeId: string; imageNodes?: BrowserImageNode[];
  imagePrompt: string;
  onImageTargetNodeIdChange: (value: string) => void;
  onImagePromptChange: (value: string) => void;
  onGenerateImages: () => void | Promise<void>;
  onApplyImage: (candidate: BrowserImageCandidate) => void | Promise<void>;
  imageBusy?: boolean;
  run?: AgentRun;
  activeEvents?: ReadonlyArray<AgentEvent>;
  historicalEvents?: ReadonlyArray<AgentEvent>;
  onLoopApproval?: (choice: "approved" | "rejected") => void | Promise<void>;
  messages?: ReadonlyArray<ConversationMessage>;
  permissionMode: AgentPermissionMode;
  onPermissionModeChange: (mode: AgentPermissionMode) => void;
  onLoadEarlier?: () => void;
  hasEarlierMessages?: boolean;
  loadingEarlierMessages?: boolean;
  loadingWorkspace?: boolean;
}

const eventSummary = (event: AgentEvent) => {
  if (event.type === "turn.started") return "已接收你的请求";
  if (event.type === "model.started") return "正在处理请求";
  if (event.type === "model.completed") return "已完成本次判断";
  if (event.type === "model.delta") return "正在生成回复";
  if (event.type === "tool.started") return `正在调用 ${event.name ?? "工具"}`;
  if (event.type === "tool.completed") return `已完成 ${event.name ?? "工具"}`;
  if (event.type === "tool.failed") return `${event.name ?? "工具"} 未完成：${event.error ?? "请重试"}`;
  if (event.type === "approval.required") return `等待你批准 ${event.name ?? "文档操作"}`;
  if (event.type === "assistant.message") return "已生成回复";
  if (event.type === "turn.failed") return "本轮未完成";
  if (event.type === "turn.cancelled") return "本轮已取消";
  return "本轮已完成";
};

interface CustomSelectOption { value: string; label: string; }

function CustomSelect({ value, options, onChange, disabled, icon }: { value: string; options: CustomSelectOption[]; onChange: (value: string) => void; disabled?: boolean; icon?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);
  const selected = options.find((option) => option.value === value);
  return (
    <div className={`custom-select ${open ? "open" : ""} ${disabled ? "disabled" : ""}`} ref={ref}>
      <button type="button" onClick={() => !disabled && setOpen(!open)} disabled={disabled} aria-haspopup="listbox" aria-expanded={open}>
        {icon}
        <span>{selected?.label}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <ul role="listbox">
          {options.map((option) => (
            <li key={option.value} role="option" aria-selected={value === option.value} className={value === option.value ? "selected" : ""} onClick={() => { onChange(option.value); setOpen(false); }}>
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AgentPanel({ runtimeView, onCollapse, onRun, onCancel, workspaceReady, imageCandidates = [], onApplyImage, imageBusy, run, messages = [], activeEvents = [], historicalEvents = [], onLoopApproval, permissionMode, onPermissionModeChange, imageNodes = [], imageTargetNodeId, imagePrompt, onImageTargetNodeIdChange, onImagePromptChange, onGenerateImages, onLoadEarlier, hasEarlierMessages = false, loadingEarlierMessages = false, loadingWorkspace = false }: AgentPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [deciding, setDeciding] = useState(false);
  const [imageToolOpen, setImageToolOpen] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottomRef = useRef(true);
  const prependHeightRef = useRef<number | null>(null);
  const currentTimeline = activeEvents;
  const timelineEvents = [...historicalEvents, ...currentTimeline];
  const turns = projectAgentThread({
    messages: messages.map((message, index) => ({ id: message.id ?? `local:${index}`, role: message.role === "agent" ? "assistant" as const : "user" as const, parts: [{ type: "text", text: message.text }], run_id: message.runId ?? null, created_at: message.createdAt ?? "", message_key: message.id ?? `local:${index}`, delivery_status: message.status })),
    historicalEvents,
    activeEvents: currentTimeline,
    activeRunId: run?.id,
  }).turns;
  const latestTimelineEvent = timelineEvents.at(-1);
  const latestTimelineEventId = latestTimelineEvent?.eventId;
  const latestTimelineText = latestTimelineEvent && "text" in latestTimelineEvent ? latestTimelineEvent.text : undefined;
  const pendingInteraction = runtimeView.pendingInteraction;
  const awaitingUserQuestion = pendingInteraction?.type === "user_input";
  // Runtime Approval pauses the composer; an ask_user checkpoint is
  // specifically waiting for ordinary user text and must remain writable.
  const inputBlocked = !runtimeView.canSend;
  useEffect(() => {
    const element = contentRef.current;
    if (!element || !stickToBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
    setShowScrollToBottom(false);
  }, [timelineEvents.length, latestTimelineEventId, latestTimelineText, runtimeView.runtimeStatus]);
  useEffect(() => {
    const element = contentRef.current;
    const previousHeight = prependHeightRef.current;
    if (!element || previousHeight === null) return;
    element.scrollTop += element.scrollHeight - previousHeight;
    prependHeightRef.current = null;
  }, [messages.length]);
  useEffect(() => {
    const element = promptRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 170)}px`;
  }, [prompt]);
  const handleContentScroll = () => {
    const element = contentRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    stickToBottomRef.current = atBottom;
    setShowScrollToBottom(!atBottom);
  };
  const handleLoopApproval = async (choice: "approved" | "rejected") => {
    if (!onLoopApproval) return;
    setDeciding(true);
    try { await onLoopApproval(choice); } finally { setDeciding(false); }
  };
  const submit = () => { if (inputBlocked || !workspaceReady) return; const value = prompt.trim(); if (!value) return; onRun(value); setPrompt(""); };
  return (
    <aside className="agent-panel" aria-label="纸上鸭 Agent">
      <div className="agent-heading">
        <div className="agent-title"><span className={`agent-orb ${runtimeView.runtimeStatus}`}><Sparkles size={17} /></span><div><span className="eyebrow">Document Agent</span><h2>纸上鸭 Agent</h2></div></div>
        <button className="icon-button" onClick={onCollapse} aria-label="收起 Agent 面板"><PanelRightClose size={17} /></button>
      </div>
      <div className="agent-content" ref={contentRef} onScroll={handleContentScroll}>
        <AgentThread turns={turns} loadingWorkspace={loadingWorkspace} hasEarlierMessages={hasEarlierMessages} onLoadEarlier={() => { prependHeightRef.current = contentRef.current?.scrollHeight ?? null; onLoadEarlier?.(); }} loadingEarlierMessages={loadingEarlierMessages} onApproval={onLoopApproval} deciding={deciding} />
        {turns.length === 0 && !loadingWorkspace && <div className="assistant-turn assistant-empty"><div className="assistant-byline"><span className="agent-avatar">鸭</span><strong>纸上鸭</strong><small>准备就绪</small></div><p>我可以帮你理解、修改和导出当前 Word 文档。直接告诉我目标；默认模式会在写入前请你确认。</p></div>}
          {pendingInteraction?.type === "approval" && !timelineEvents.some((event) => event.type === "approval.required" && event.interactionId === pendingInteraction.interactionId) && <div className="scope-card"><span className="scope-kicker">需要你的确认</span><strong>准备执行：{pendingInteraction.toolName}</strong><p>Agent 已生成明确的修改参数。批准后会写入文档并生成新版本。</p><div className="scope-actions"><button className="primary-small" onClick={() => void handleLoopApproval("approved")} disabled={deciding}>{deciding ? "执行中…" : <><Check size={14} /> 批准并执行</>}</button><button onClick={() => void handleLoopApproval("rejected")} disabled={deciding}>{deciding ? "处理中…" : "拒绝"}</button></div></div>}
          {imageNodes.length > 0 && <div className="scope-card image-tool-card"><button type="button" className="image-tool-toggle" onClick={() => setImageToolOpen((open) => !open)} aria-expanded={imageToolOpen}><span><span className="scope-kicker">图片工具</span><strong>生成图片候选</strong></span><ChevronDown size={16} className={imageToolOpen ? "rotate" : ""} /></button>{imageToolOpen && <div className="image-tool-body"><p>选择图片节点并生成候选；候选不会自动写回文档。</p><label>目标图片<select value={imageTargetNodeId} onChange={(event) => onImageTargetNodeIdChange(event.target.value)} disabled={imageBusy}><option value="">请选择图片节点</option>{imageNodes.map((node, index) => <option key={node.nodeId} value={node.nodeId}>图片 {index + 1} · {node.nodeId.slice(0, 12)}</option>)}</select></label><label>图片描述<textarea value={imagePrompt} onChange={(event) => onImagePromptChange(event.target.value)} placeholder="例如：简洁的三模块系统结构图" rows={2} disabled={imageBusy} /></label><button type="button" className="primary-small" onClick={() => void onGenerateImages()} disabled={imageBusy || !imageTargetNodeId.trim() || !imagePrompt.trim()}>{imageBusy ? "生成中…" : "生成图片候选"}</button></div>}</div>}
          {imageCandidates.length > 0 && <div className="scope-card image-candidate-card"><span className="scope-kicker">图片候选</span><strong>选择要应用的候选</strong><p>候选不会自动写回；选择后仍会按当前权限策略执行。</p>{imageCandidates.map((candidate) => <button key={candidate.id} onClick={() => onApplyImage(candidate)} disabled={imageBusy}><Image src={candidate.downloadUrl} alt="图片候选" width={240} height={140} unoptimized /><span>应用此候选</span></button>)}</div>}
          {runtimeView.isRunning && !timelineEvents.length && <div className="progress-card"><div className="progress-top"><strong>{currentTimeline.at(-1) ? eventSummary(currentTimeline.at(-1)!) : "正在准备"}</strong><span>进行中</span></div><small>执行过程会实时显示在上方对话时间线</small><button className="cancel-run" onClick={onCancel}><StopCircle size={13} /> 取消</button></div>}
        {showScrollToBottom && <button type="button" className="scroll-to-bottom" onClick={() => { const element = contentRef.current; if (!element) return; element.scrollTo({ top: element.scrollHeight, behavior: "smooth" }); stickToBottomRef.current = true; setShowScrollToBottom(false); }} aria-label="回到底部">↓ 回到底部</button>}
      </div>
      <div className="agent-composer">
        <textarea ref={promptRef} id="agent-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter" && !event.shiftKey && !inputBlocked && workspaceReady) { event.preventDefault(); submit(); } }} placeholder={awaitingUserQuestion ? "请回答纸上鸭的问题…" : !workspaceReady ? "请先打开一份 DOCX" : inputBlocked ? "Agent 运行中，可先输入下一条提示词…" : "例如：把实验结论改得更专业，只改一个单元格…"} rows={2} disabled={!workspaceReady} />
        <div className="composer-toolbar">
          <CustomSelect
            value={permissionMode}
            options={[
              { value: "default", label: "默认权限" },
              { value: "full", label: "允许完全访问" },
            ]}
            onChange={(value) => onPermissionModeChange(value as AgentPermissionMode)}
            disabled={runtimeView.permissionLocked}
            icon={permissionMode === "full" ? <Unlock size={12} className="permission-icon full" /> : <Shield size={12} className="permission-icon" />}
          />
          <div className="composer-actions">
            <span>{inputBlocked ? "当前任务完成后即可发送" : "Enter 发送 · Shift + Enter 换行"}</span>
            {runtimeView.canCancel ? <button className="composer-stop" onClick={() => void onCancel()} aria-label="停止当前任务"><StopCircle size={14} /> 停止</button> : <button className="composer-send" onClick={submit} disabled={!prompt.trim() || inputBlocked || !workspaceReady} aria-label="发送要求"><Send size={14} /></button>}
          </div>
        </div>
      </div>
    </aside>
  );
}

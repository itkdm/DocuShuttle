import { Check, ChevronDown, PanelRightClose, Send, Shield, Sparkles, StopCircle, Unlock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentRuntimeView } from "./runtime-view-state";
import type { AgentEvent } from "@/modules/agent/application/events";
import type { AgentRun } from "@/modules/agent";
import type { AgentPermissionMode } from "@/modules/agent/application/loop";
import type { ConversationMessage } from "./conversation-store";
import { AgentThread } from "./agent-thread";
import { projectAgentThread } from "./agent-thread-projection";
import { isAtBottom, scrollToBottom } from "./chat-scroll";

interface AgentPanelProps {
  runtimeView: AgentRuntimeView; onCollapse: () => void;
  onRun: (prompt: string) => void | Promise<void>; onCancel: () => void | Promise<void>;
  workspaceReady: boolean;
  taskId?: string;
  run?: AgentRun;
  activeEvents?: ReadonlyArray<AgentEvent>;
  historicalEvents?: ReadonlyArray<AgentEvent>;
  onLoopApproval?: (choice: "approved" | "rejected", callId?: string) => void | Promise<void>;
  messages?: ReadonlyArray<ConversationMessage>;
  permissionMode: AgentPermissionMode;
  onPermissionModeChange: (mode: AgentPermissionMode) => void;
  onLoadEarlier?: () => void;
  hasEarlierMessages?: boolean;
  loadingEarlierMessages?: boolean;
  conversationLoading?: boolean;
  approvalSubmitting?: boolean;
}

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

export function AgentPanel({ runtimeView, onCollapse, onRun, onCancel, workspaceReady, taskId, run, messages = [], activeEvents = [], historicalEvents = [], onLoopApproval, permissionMode, onPermissionModeChange, onLoadEarlier, hasEarlierMessages = false, loadingEarlierMessages = false, conversationLoading = false, approvalSubmitting = false }: AgentPanelProps) {
  const [prompt, setPrompt] = useState("");
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
  const latestTurn = turns.at(-1);
  const latestTurnId = latestTurn?.id;
  const latestTurnText = latestTurn?.user?.content ?? latestTurn?.assistant?.finalContent ?? latestTurn?.assistant?.streamingContent;
  const latestTurnStatus = latestTurn?.assistant?.status ?? latestTurn?.user?.deliveryStatus;
  const pendingInteraction = runtimeView.pendingInteraction;
  const awaitingUserQuestion = pendingInteraction?.type === "user_input";
  // Runtime Approval pauses the composer; an ask_user checkpoint is
  // specifically waiting for ordinary user text and must remain writable.
  const inputBlocked = !runtimeView.canSend;
  useEffect(() => {
    const element = contentRef.current;
    if (!element || !stickToBottomRef.current) return;
    scrollToBottom(element);
    setShowScrollToBottom(false);
  }, [timelineEvents.length, latestTimelineEventId, latestTimelineText, messages.length, latestTurnId, latestTurnText, latestTurnStatus, runtimeView.runtimeStatus]);
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
    const atBottom = isAtBottom(element);
    stickToBottomRef.current = atBottom;
    setShowScrollToBottom(!atBottom);
  };
  const handleLoopApproval = (choice: "approved" | "rejected", callId?: string) => onLoopApproval?.(choice, callId);
  const submit = () => { if (inputBlocked || !workspaceReady) return; const value = prompt.trim(); if (!value) return; stickToBottomRef.current = true; setShowScrollToBottom(false); onRun(value); setPrompt(""); };
  return (
    <aside className="agent-panel" aria-label="纸上鸭 Agent">
      <div className="agent-heading">
        <div className="agent-title"><span className={`agent-orb ${runtimeView.runtimeStatus}`}><Sparkles size={17} /></span><div><span className="eyebrow">Document Agent</span><h2>纸上鸭 Agent</h2></div></div>
        <button className="icon-button" onClick={onCollapse} aria-label="收起 Agent 面板"><PanelRightClose size={17} /></button>
      </div>
      <div className="agent-content" ref={contentRef} onScroll={handleContentScroll}>
        <AgentThread taskId={taskId} turns={turns} conversationLoading={conversationLoading} hasEarlierMessages={hasEarlierMessages} onLoadEarlier={() => { prependHeightRef.current = contentRef.current?.scrollHeight ?? null; onLoadEarlier?.(); }} loadingEarlierMessages={loadingEarlierMessages} onApproval={handleLoopApproval} deciding={approvalSubmitting} />
        {turns.length === 0 && !conversationLoading && <div className="assistant-turn assistant-empty"><div className="assistant-byline"><span className="agent-avatar">鸭</span><strong>纸上鸭</strong><small>准备就绪</small></div><p>我可以帮你理解、修改和导出当前 Word 文档。直接告诉我目标；默认模式会在写入前请你确认。</p></div>}
          {pendingInteraction?.type === "approval" && !timelineEvents.some((event) => event.type === "approval.required" && event.interactionId === pendingInteraction.interactionId) && <div className="scope-card"><span className="scope-kicker">需要你的确认</span><strong>准备执行：{pendingInteraction.toolName}</strong><p>Agent 已生成明确的修改参数。批准后会写入文档并生成新版本。</p><div className="scope-actions"><button className="primary-small" onClick={() => void handleLoopApproval("approved", pendingInteraction.callId)} disabled={approvalSubmitting}>{approvalSubmitting ? "执行中…" : <><Check size={14} /> 批准并执行</>}</button><button onClick={() => void handleLoopApproval("rejected", pendingInteraction.callId)} disabled={approvalSubmitting}>{approvalSubmitting ? "处理中…" : "拒绝"}</button></div></div>}
        {showScrollToBottom && <button type="button" className="scroll-to-bottom" onClick={() => { const element = contentRef.current; if (!element) return; stickToBottomRef.current = true; setShowScrollToBottom(false); scrollToBottom(element, "smooth"); }} aria-label="回到底部">↓ 回到底部</button>}
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

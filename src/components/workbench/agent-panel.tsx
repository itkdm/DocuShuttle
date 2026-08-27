import { Check, ChevronDown, PanelRightClose, Send, Shield, Sparkles, StopCircle, Unlock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import type { AgentStage, ProposalState } from "./types";
import type { BrowserAgentLoopResult, BrowserImageCandidate, BrowserImageNode } from "@/modules/agent/browser-runtime";
import type { AgentRun } from "@/modules/agent";
import type { AgentPermissionMode } from "@/modules/agent/application/loop";
import { AgentTimeline, mergeTimelineEvents } from "./agent-timeline";
import { renderAgentMarkdown } from "./agent-markdown";

interface AgentPanelProps {
  stage: AgentStage; proposal: ProposalState; onCollapse: () => void;
  onRun: (prompt: string) => void | Promise<void>; onCancel: () => void | Promise<void>;
  onDecide: (decision: ProposalState) => void | Promise<void>;
  workspaceReady: boolean;
  proposalSummary?: string;
  awaitingFinalReview?: boolean;
  onFinalReview: (choice: "approved" | "rejected") => void | Promise<void>;
  imageCandidates?: BrowserImageCandidate[];
  imageTargetNodeId: string; imageNodes?: BrowserImageNode[];
  imagePrompt: string;
  onImageTargetNodeIdChange: (value: string) => void;
  onImagePromptChange: (value: string) => void;
  onGenerateImages: () => void | Promise<void>;
  onApplyImage: (candidate: BrowserImageCandidate) => void | Promise<void>;
  imageBusy?: boolean;
  run?: AgentRun;
  loopResult?: BrowserAgentLoopResult;
  liveEvents?: BrowserAgentLoopResult["events"];
  timelineHistory?: BrowserAgentLoopResult["events"];
  onLoopApproval?: (choice: "approved" | "rejected") => void | Promise<void>;
  conversation?: ReadonlyArray<{ role: "user" | "agent"; text: string }>;
  permissionMode: AgentPermissionMode;
  onPermissionModeChange: (mode: AgentPermissionMode) => void;
}

const eventSummary = (event: BrowserAgentLoopResult["events"][number]) => {
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

export function AgentPanel({ stage, proposal, onCollapse, onRun, onCancel, onDecide, workspaceReady, proposalSummary, awaitingFinalReview, onFinalReview, imageCandidates = [], onApplyImage, imageBusy, conversation = [], loopResult, liveEvents = [], timelineHistory = [], onLoopApproval, permissionMode, onPermissionModeChange }: AgentPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [deciding, setDeciding] = useState(false);
  const currentTimeline = liveEvents.length ? liveEvents : loopResult?.events ?? [];
  const timelineEvents = mergeTimelineEvents(timelineHistory, currentTimeline);
  const handleLoopApproval = async (choice: "approved" | "rejected") => {
    if (!onLoopApproval) return;
    setDeciding(true);
    try { await onLoopApproval(choice); } finally { setDeciding(false); }
  };
  const submit = () => { if (stage === "analyzing" || !workspaceReady) return; const value = prompt.trim(); if (!value) return; onRun(value); setPrompt(""); };
  return (
    <aside className="agent-panel" aria-label="纸上鸭 Agent">
      <div className="agent-heading">
        <div className="agent-title"><span className={`agent-orb ${stage}`}><Sparkles size={17} /></span><div><span className="eyebrow">Document Agent</span><h2>纸上鸭 Agent</h2></div></div>
        <button className="icon-button" onClick={onCollapse} aria-label="收起 Agent 面板"><PanelRightClose size={17} /></button>
      </div>
      <div className="agent-content">
        {timelineEvents.length > 0 ? <AgentTimeline events={timelineEvents} onApproval={onLoopApproval} deciding={deciding} onCancel={stage !== "idle" && stage !== "awaiting" && stage !== "complete" ? onCancel : undefined} /> : <>
      {conversation.length === 0 && <div className="agent-message duck-message"><div className="message-meta"><span>鸭</span><strong>纸上鸭</strong><small>准备就绪</small></div><p>我可以帮你理解、修改和导出当前 Word 文档。直接告诉我目标；默认模式会在写入前请你确认。</p></div>}
          {conversation.map((message, index) => <div className={`agent-message conversation-message ${message.role}`} key={`${message.role}-${index}`}><div className="message-meta"><span>{message.role === "user" ? "你" : "鸭"}</span><strong>{message.role === "user" ? "你的目标" : "纸上鸭"}</strong><small>{message.role === "user" ? "刚刚" : "实时回复"}</small></div><p className="agent-rich-text">{message.role === "agent" ? renderAgentMarkdown(message.text) : message.text}</p></div>)}
        </>}
          {proposalSummary && !awaitingFinalReview && !loopResult?.checkpoint.pendingApproval && <div className="scope-card"><span className="scope-kicker">等待范围确认</span><strong>Agent 修改计划</strong><p>{proposalSummary}</p>{proposal === "pending" ? <div className="scope-actions"><button className="primary-small" onClick={() => onDecide("accepted")}><Check size={14} /> 批准并应用</button><button onClick={() => onDecide("rejected")}>拒绝</button></div> : <span className="decision-note">{proposal === "accepted" ? "范围已冻结，正在安全写入" : "已拒绝，原文不变"}</span>}</div>}
          {loopResult?.checkpoint.pendingApproval && !timelineEvents.length && <div className="scope-card"><span className="scope-kicker">需要你的确认</span><strong>准备执行：{loopResult.checkpoint.pendingApproval.name}</strong><p>Agent 已生成明确的修改参数。批准后会写入文档并生成新版本。</p><div className="scope-actions"><button className="primary-small" onClick={() => void handleLoopApproval("approved")} disabled={deciding}>{deciding ? "执行中…" : <><Check size={14} /> 批准并执行</>}</button><button onClick={() => void handleLoopApproval("rejected")} disabled={deciding}>{deciding ? "处理中…" : "拒绝"}</button></div></div>}
          {awaitingFinalReview && <div className="scope-card"><span className="scope-kicker">最终版本复核</span><strong>新版本已通过 OOXML 重开校验</strong><p>中央画布已切换到生成后的真实 DOCX。确认后完成任务；拒绝会保留审计记录。</p><div className="scope-actions"><button className="primary-small" onClick={() => onFinalReview("approved")}><Check size={14} /> 确认交付</button><button onClick={() => onFinalReview("rejected")}>拒绝版本</button></div></div>}
          {imageCandidates.length > 0 && <div className="scope-card image-candidate-card"><span className="scope-kicker">图片候选</span><strong>选择要应用的候选</strong><p>候选不会自动写回；选择后仍会按当前权限策略执行。</p>{imageCandidates.map((candidate) => <button key={candidate.id} onClick={() => onApplyImage(candidate)} disabled={imageBusy}><Image src={candidate.downloadUrl} alt="图片候选" width={240} height={140} unoptimized /><span>应用此候选</span></button>)}</div>}
          {stage !== "idle" && stage !== "awaiting" && !timelineEvents.length && <div className="progress-card"><div className="progress-top"><strong>{stage === "complete" ? "已完成" : liveEvents.at(-1) ? eventSummary(liveEvents.at(-1)!) : "正在准备"}</strong><span>{stage === "complete" ? "完成" : "进行中"}</span></div><small>{stage === "complete" ? "结果已保存为新的文档版本" : "执行过程会实时显示在上方对话时间线"}</small>{stage !== "complete" && <button className="cancel-run" onClick={onCancel}><StopCircle size={13} /> 取消</button>}</div>}
      </div>
      <div className="agent-composer">
        <textarea id="agent-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && stage !== "analyzing" && stage !== "awaiting" && workspaceReady) { event.preventDefault(); submit(); } }} placeholder={workspaceReady ? "例如：把实验结论改得更专业，只改一个单元格…" : "请先打开一份 DOCX"} rows={2} disabled={!workspaceReady || stage === "awaiting"} />
        <div className="composer-toolbar">
          <CustomSelect
            value={permissionMode}
            options={[
              { value: "default", label: "默认权限" },
              { value: "full", label: "允许完全访问" },
            ]}
            onChange={(value) => onPermissionModeChange(value as AgentPermissionMode)}
            disabled={stage === "analyzing" || stage === "awaiting"}
            icon={permissionMode === "full" ? <Unlock size={12} className="permission-icon full" /> : <Shield size={12} className="permission-icon" />}
          />
          <div className="composer-actions">
            <span>Enter 发送 · Shift + Enter 换行</span>
            <button className="composer-send" onClick={submit} disabled={!prompt.trim() || stage === "analyzing" || stage === "awaiting" || !workspaceReady} aria-label="发送要求"><Send size={14} /></button>
          </div>
        </div>
      </div>
    </aside>
  );
}


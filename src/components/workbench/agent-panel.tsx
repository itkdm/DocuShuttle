import { Check, ChevronDown, PanelRightClose, Send, Shield, Sparkles, StopCircle, Unlock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import type { AgentStage, ProposalState } from "./types";
import type { BrowserAgentLoopResult, BrowserImageCandidate, BrowserImageNode } from "@/modules/agent/browser-runtime";
import type { AgentRun } from "@/modules/agent";
import type { AgentPermissionMode } from "@/modules/agent/application/loop";

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
  onLoopApproval?: (choice: "approved" | "rejected") => void | Promise<void>;
  conversation?: ReadonlyArray<{ role: "user" | "agent"; text: string }>;
  permissionMode: AgentPermissionMode;
  onPermissionModeChange: (mode: AgentPermissionMode) => void;
}

type Tab = "agent" | "plan" | "activity";

function renderInlineMarkdown(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    return <span key={index}>{part}</span>;
  });
}

function renderAssistantText(text: string) {
  return text.split("\n").map((line, index) => {
    if (!line.trim()) return <br key={`break-${index}`} />;
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const heading = line.match(/^\s*#{1,3}\s+(.*)$/);
    if (heading) return <strong className="agent-md-heading" key={index}>{renderInlineMarkdown(heading[1])}</strong>;
    if (bullet) return <span className="agent-md-list-item" key={index}><span aria-hidden="true">•</span>{renderInlineMarkdown(bullet[1])}</span>;
    return <span className="agent-md-line" key={index}>{renderInlineMarkdown(line)}</span>;
  });
}

const eventSummary = (event: BrowserAgentLoopResult["events"][number]) => {
  if (event.type === "turn.started") return "已接收你的请求";
  if (event.type === "model.started") return "正在规划下一步";
  if (event.type === "model.completed") return "已完成本次规划";
  if (event.type === "model.delta") return "正在生成回复";
  if (event.type === "tool.started") return `正在调用 ${event.name ?? "工具"}`;
  if (event.type === "tool.completed") return `已完成 ${event.name ?? "工具"}`;
  if (event.type === "tool.failed") return `${event.name ?? "工具"} 未完成：${event.error ?? "请重试"}`;
  if (event.type === "approval.required") return `等待你批准 ${event.name ?? "文档操作"}`;
  if (event.type === "assistant.message") return "已生成回复";
  if (event.type === "turn.failed") return "本轮未完成";
  return "本轮已完成";
};

const eventDetail = (event: BrowserAgentLoopResult["events"][number]) => {
  const value = event.output ?? event.input;
  if (value && typeof value === "object" && "summary" in value && typeof value.summary === "string") {
    const duration = "durationMs" in value && typeof value.durationMs === "number" ? ` · ${(value.durationMs / 1000).toFixed(value.durationMs < 1000 ? 1 : 0)} 秒` : "";
    return `${value.summary}${duration}`;
  }
  if (event.type === "model.completed" && typeof event.durationMs === "number") return `耗时 ${(event.durationMs / 1000).toFixed(event.durationMs < 1000 ? 1 : 0)} 秒`;
  return event.text ?? event.error ?? event.name ?? "";
};

const eventTime = (event: BrowserAgentLoopResult["events"][number]) => {
  if (typeof event.timestamp !== "string") return "";
  const time = new Date(event.timestamp);
  return Number.isNaN(time.valueOf()) ? "" : time.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
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

export function AgentPanel({ stage, proposal, onCollapse, onRun, onCancel, onDecide, workspaceReady, proposalSummary, awaitingFinalReview, onFinalReview, imageCandidates = [], onApplyImage, imageBusy, conversation = [], loopResult, liveEvents = [], onLoopApproval, permissionMode, onPermissionModeChange }: AgentPanelProps) {
  const [tab, setTab] = useState<Tab>("agent");
  const [prompt, setPrompt] = useState("");
  const [deciding, setDeciding] = useState(false);
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
      <div className="agent-tabs" role="tablist" aria-label="Agent 面板视图">
        {(["agent", "plan", "activity"] as const).map((item) => <button key={item} role="tab" aria-selected={tab === item} onClick={() => setTab(item)}>{item === "agent" ? "对话" : item === "plan" ? "计划" : "活动"}{item === "plan" && loopResult?.checkpoint.pendingApproval && <span>1</span>}</button>)}
      </div>
      <div className="agent-content">
        {tab === "agent" && <>
      {conversation.length === 0 && <div className="agent-message duck-message"><div className="message-meta"><span>鸭</span><strong>纸上鸭</strong><small>准备就绪</small></div><p>我可以帮你理解、修改和导出当前 Word 文档。直接告诉我目标；默认模式会在写入前请你确认。</p></div>}
          {conversation.map((message, index) => <div className={`agent-message conversation-message ${message.role}`} key={`${message.role}-${index}`}><div className="message-meta"><span>{message.role === "user" ? "你" : "鸭"}</span><strong>{message.role === "user" ? "你的目标" : "纸上鸭"}</strong><small>{message.role === "user" ? "刚刚" : "实时回复"}</small></div><p className="agent-rich-text">{message.role === "agent" ? renderAssistantText(message.text) : message.text}</p></div>)}
          {proposalSummary && !awaitingFinalReview && !loopResult?.checkpoint.pendingApproval && <div className="scope-card"><span className="scope-kicker">等待范围确认</span><strong>Agent 修改计划</strong><p>{proposalSummary}</p>{proposal === "pending" ? <div className="scope-actions"><button className="primary-small" onClick={() => onDecide("accepted")}><Check size={14} /> 批准并应用</button><button onClick={() => onDecide("rejected")}>拒绝</button></div> : <span className="decision-note">{proposal === "accepted" ? "范围已冻结，正在安全写入" : "已拒绝，原文不变"}</span>}</div>}
          {loopResult?.checkpoint.pendingApproval && <div className="scope-card"><span className="scope-kicker">需要你的确认</span><strong>准备执行：{loopResult.checkpoint.pendingApproval.name}</strong><p>Agent 已生成明确的修改参数。批准后会写入文档并生成新版本。</p><div className="scope-actions"><button className="primary-small" onClick={() => void handleLoopApproval("approved")} disabled={deciding}>{deciding ? "执行中…" : <><Check size={14} /> 批准并执行</>}</button><button onClick={() => void handleLoopApproval("rejected")} disabled={deciding}>{deciding ? "处理中…" : "拒绝"}</button></div></div>}
          {awaitingFinalReview && <div className="scope-card"><span className="scope-kicker">最终版本复核</span><strong>新版本已通过 OOXML 重开校验</strong><p>中央画布已切换到生成后的真实 DOCX。确认后完成任务；拒绝会保留审计记录。</p><div className="scope-actions"><button className="primary-small" onClick={() => onFinalReview("approved")}><Check size={14} /> 确认交付</button><button onClick={() => onFinalReview("rejected")}>拒绝版本</button></div></div>}
          {imageCandidates.length > 0 && <div className="scope-card image-candidate-card"><span className="scope-kicker">图片候选</span><strong>选择要应用的候选</strong><p>候选不会自动写回；选择后仍会按当前权限策略执行。</p>{imageCandidates.map((candidate) => <button key={candidate.id} onClick={() => onApplyImage(candidate)} disabled={imageBusy}><Image src={candidate.downloadUrl} alt="图片候选" width={240} height={140} unoptimized /><span>应用此候选</span></button>)}</div>}
          {stage !== "idle" && stage !== "awaiting" && <div className="progress-card"><div className="progress-top"><strong>{stage === "complete" ? "已完成" : liveEvents.at(-1) ? eventSummary(liveEvents.at(-1)!) : "正在准备"}</strong><span>{stage === "complete" ? "完成" : "进行中"}</span></div><small>{stage === "complete" ? "结果已保存为新的文档版本" : "执行过程会实时显示在活动页"}</small>{stage !== "complete" && <button className="cancel-run" onClick={onCancel}><StopCircle size={13} /> 取消</button>}</div>}
        </>}
        {tab === "plan" && <div className="plan-list"><div className="plan-summary"><strong>{loopResult?.checkpoint.pendingApproval ? "待你确认的操作" : "本轮执行"}</strong><small>{loopResult ? `本轮 ${loopResult.checkpoint.iterations} 步 · ${loopResult.checkpoint.status === "completed" ? "已完成" : loopResult.checkpoint.status === "failed" ? "未完成" : "进行中"}` : "发送目标后，我会列出实际执行步骤"}</small></div>{(liveEvents.length ? liveEvents : loopResult?.events ?? []).filter((event) => event.type !== "model.delta").map((event, index) => <div className="plan-row completed" key={`${event.type}-${index}`}><span className="plan-status"><Check size={13} /></span><div><strong>{eventSummary(event)}</strong><small>{eventDetail(event)}</small></div></div>)}</div>}
        {tab === "activity" && <div className="activity-list">{(liveEvents.length ? liveEvents : loopResult?.events ?? []).filter((event) => event.type !== "model.delta").map((event, index) => <div className={`activity-item ${event.type === "tool.failed" || event.type === "turn.failed" ? "error" : ""}`} key={`${event.type}-${index}`}><Check size={15} /><div><strong>{eventSummary(event)} <em>{eventTime(event)}</em></strong><small>{eventDetail(event)}</small></div></div>)}{!liveEvents.length && !loopResult?.events.length && <div className="plan-empty">本轮的工具调用和结果会显示在这里。</div>}</div>}
      </div>
      <div className="agent-composer">
        <textarea id="agent-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && stage !== "analyzing" && workspaceReady) { event.preventDefault(); submit(); } }} placeholder={workspaceReady ? "例如：把实验结论改得更专业，只改一个单元格…" : "请先打开一份 DOCX"} rows={2} disabled={!workspaceReady} />
        <div className="composer-toolbar">
          <CustomSelect
            value={permissionMode}
            options={[
              { value: "default", label: "默认权限" },
              { value: "full", label: "允许完全访问" },
            ]}
            onChange={(value) => onPermissionModeChange(value as AgentPermissionMode)}
            disabled={stage === "analyzing"}
            icon={permissionMode === "full" ? <Unlock size={12} className="permission-icon full" /> : <Shield size={12} className="permission-icon" />}
          />
          <div className="composer-actions">
            <span>Enter 发送 · Shift + Enter 换行</span>
            <button className="composer-send" onClick={submit} disabled={!prompt.trim() || stage === "analyzing" || !workspaceReady} aria-label="发送要求"><Send size={14} /></button>
          </div>
        </div>
      </div>
    </aside>
  );
}

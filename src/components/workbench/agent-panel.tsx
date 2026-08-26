import { AlertTriangle, Check, ChevronRight, Circle, Clock3, PanelRightClose, RefreshCw, Send, Sparkles, StopCircle } from "lucide-react";
import { useState } from "react";
import Image from "next/image";
import type { AgentStage, ProposalState } from "./types";
import type { BrowserImageCandidate, BrowserImageNode } from "@/modules/agent/browser-runtime";
import type { AgentRun } from "@/modules/agent";

interface AgentPanelProps {
  stage: AgentStage; proposal: ProposalState; onCollapse: () => void;
  onRun: (prompt: string) => void | Promise<void>; onCancel: () => void | Promise<void>; onRetry: () => void;
  onDecide: (decision: ProposalState) => void | Promise<void>;
  mode: "local" | "production";
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
  conversation?: ReadonlyArray<{ role: "user" | "agent"; text: string }>;
}

type Tab = "agent" | "plan" | "activity";
export function AgentPanel({ stage, proposal, onCollapse, onRun, onCancel, onRetry, onDecide, mode, proposalSummary, awaitingFinalReview, onFinalReview, imageCandidates = [], imageTargetNodeId, imageNodes = [], imagePrompt, onImageTargetNodeIdChange, onImagePromptChange, onGenerateImages, onApplyImage, imageBusy, run, conversation = [] }: AgentPanelProps) {
  const [tab, setTab] = useState<Tab>("agent");
  const [prompt, setPrompt] = useState("");
  const submit = () => { const value = prompt.trim(); if (!value) return; onRun(value); setPrompt(""); };
  const completedSteps = run?.steps.filter((step) => step.status === "completed").length ?? 0;
  const pct = run && run.steps.length > 0 ? `${Math.round((completedSteps / run.steps.length) * 100)}%` : stage === "complete" ? "100%" : "0%";
  return (
    <aside className="agent-panel" aria-label="纸上鸭 Agent">
      <div className="agent-heading">
        <div className="agent-title"><span className={`agent-orb ${stage}`}><Sparkles size={17} /></span><div><span className="eyebrow">Document Agent · {mode === "production" ? "LIVE" : "LOCAL"}</span><h2>{mode === "production" ? "纸上鸭 Agent" : "本地预览模式"}</h2></div></div>
        <button className="icon-button" onClick={onCollapse} aria-label="收起 Agent 面板"><PanelRightClose size={17} /></button>
      </div>
      <div className="agent-tabs" role="tablist" aria-label="Agent 面板视图">
        {(["agent", "plan", "activity"] as const).map((item) => <button key={item} role="tab" aria-selected={tab === item} onClick={() => setTab(item)}>{item === "agent" ? "对话" : item === "plan" ? "计划" : "活动"}{item === "plan" && <span>1</span>}</button>)}
      </div>
      <div className="agent-content">
        {tab === "agent" && <>
          <div className="agent-message duck-message"><div className="message-meta"><span>鸭</span><strong>{mode === "production" ? "真实文档运行时" : "尚未连接云端"}</strong><small>{mode === "production" ? "可恢复" : "本地"}</small></div><p>{mode === "production" ? "分析、决定、副作用回执和文档版本都会持久化；刷新页面不会静默覆盖新版本。" : "可以真实预览 DOCX；配置完成后这里会执行持久化 Agent 流程。"}</p></div>
          {conversation.map((message, index) => <div className={`agent-message conversation-message ${message.role}`} key={`${message.role}-${index}`}><div className="message-meta"><span>{message.role === "user" ? "你" : "鸭"}</span><strong>{message.role === "user" ? "你的目标" : "纸上鸭"}</strong><small>{message.role === "user" ? "刚刚" : "实时回复"}</small></div><p>{message.text}</p></div>)}
          {proposalSummary && !awaitingFinalReview && <div className="scope-card"><span className="scope-kicker">等待范围确认</span><strong>Agent 修改计划</strong><p>{proposalSummary}</p>{proposal === "pending" ? <div className="scope-actions"><button className="primary-small" onClick={() => onDecide("accepted")}><Check size={14} /> 批准并应用</button><button onClick={() => onDecide("rejected")}>拒绝</button></div> : <span className="decision-note">{proposal === "accepted" ? "范围已冻结，正在安全写入" : "已拒绝，原文不变"}</span>}</div>}
          {awaitingFinalReview && <div className="scope-card"><span className="scope-kicker">最终版本复核</span><strong>新版本已通过 OOXML 重开校验</strong><p>中央画布已切换到生成后的真实 DOCX。确认后完成任务；拒绝会保留审计记录。</p><div className="scope-actions"><button className="primary-small" onClick={() => onFinalReview("approved")}><Check size={14} /> 确认交付</button><button onClick={() => onFinalReview("rejected")}>拒绝版本</button></div></div>}
          <div className="scope-card image-candidate-card"><span className="scope-kicker">图片候选</span><strong>只替换选中的图片节点</strong><p>选择当前文档里的图片节点，再描述想要的候选；候选不会自动写回。</p><select aria-label="图片节点" value={imageTargetNodeId} onChange={(event) => onImageTargetNodeIdChange(event.target.value)} disabled={mode !== "production" || imageBusy || imageNodes.length === 0}><option value="">{imageNodes.length ? "选择图片节点" : "当前文档没有可替换图片"}</option>{imageNodes.map((node) => <option key={node.nodeId} value={node.nodeId}>{node.nodeId.slice(0, 14)} · {node.path}</option>)}</select><textarea aria-label="图片生成描述" value={imagePrompt} onChange={(event) => onImagePromptChange(event.target.value)} placeholder="例如：简洁的三模块系统结构图" rows={2} disabled={mode !== "production" || imageBusy} /><button className="primary-small" onClick={onGenerateImages} disabled={mode !== "production" || imageBusy || !imageTargetNodeId.trim() || !imagePrompt.trim()}>{imageBusy ? "正在生成…" : "生成图片候选"}</button>{imageCandidates.length > 0 && <div className="image-candidate-list">{imageCandidates.map((candidate) => <button key={candidate.id} onClick={() => onApplyImage(candidate)} disabled={imageBusy}><Image src={candidate.downloadUrl} alt="图片候选" width={240} height={140} unoptimized /><span>应用此候选</span></button>)}</div>}</div>
          {stage !== "idle" && stage !== "awaiting" && <div className="progress-card"><div className="progress-top"><strong>{stage === "complete" ? "已完成并校验" : stage === "analyzing" ? "正在理解文档" : "正在创建新版本"}</strong><span>{pct}</span></div><div className="progress-track"><span style={{ width: pct }} /></div><small>{stage === "complete" ? "最终版本已确认，可下载交付" : "每一步都会保存检查点与副作用回执"}</small>{stage !== "complete" && <button className="cancel-run" onClick={onCancel}><StopCircle size={13} /> 取消任务</button>}</div>}
        </>}
        {tab === "plan" && <div className="plan-list"><div className="plan-summary"><strong>{run ? "当前 Agent 运行" : "尚未开始 Agent 运行"}</strong><small>{run ? `绑定 revision ${run.baseRevision.slice(0, 12)}… · ${run.status}` : "发送一条目标后，这里会显示真实检查点"}</small></div>{run ? run.steps.map((step, index) => { const title = step.kind === "analyze" ? "读取并理解文档" : step.kind === "generate" ? "生成局部内容" : step.kind === "apply" ? "原子写入新版本" : "重新打开并校验"; const detail = step.status === "completed" ? "已完成并持久化检查点" : step.status === "running" ? "正在执行" : step.status === "failed" ? step.error?.message ?? "执行失败" : "等待前一步完成"; return <div className={`plan-row ${step.status}`} key={step.id}><span className="plan-status">{step.status === "completed" ? <Check size={13} /> : step.status === "running" ? index + 1 : <Circle size={10} />}</span><div><strong>{title}</strong><small>{detail}</small></div>{step.status === "running" && <ChevronRight size={15} />}</div>; }) : <div className="plan-empty">真实运行开始后，计划会根据当前文档和目标生成。</div>}</div>}
        {tab === "activity" && <div className="activity-list"><div className="activity-item"><Check size={15} /><div><strong>文档加载状态</strong><small>{mode === "production" ? "私有 Storage 与数据库版本已连接" : "当前仅在浏览器本地读取"}</small></div></div><div className="activity-item"><Clock3 size={15} /><div><strong>Agent 状态</strong><small>{stage === "awaiting" ? "等待用户决定" : stage === "complete" ? "任务已完成" : stage === "idle" ? "尚未运行" : "步骤执行中"}</small></div></div>{stage === "idle" && mode === "production" && <div className="activity-item error"><AlertTriangle size={15} /><div><strong>运行已停止</strong><small>最近有效文档版本未受影响</small><button onClick={onRetry}><RefreshCw size={12} /> 重新分析</button></div></div>}</div>}
      </div>
      <div className="agent-composer"><label htmlFor="agent-prompt">继续告诉纸上鸭</label><textarea id="agent-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder="例如：把实验结论改得更专业，只改一个单元格…" rows={2} disabled={mode !== "production"} /><div><span>{mode === "production" ? "Enter 发送 · Shift + Enter 换行" : "保存到私有工作区后可用"}</span><button onClick={submit} disabled={!prompt.trim() || mode !== "production"} aria-label="发送要求"><Send size={15} /></button></div></div>
    </aside>
  );
}

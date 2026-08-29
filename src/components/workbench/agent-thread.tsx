import { AlertCircle, Check, LoaderCircle, Shield } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { renderAgentMarkdown } from "./agent-markdown";
import { executionSummary, type AgentActivity, type AgentThreadTurn } from "./agent-thread-projection";
import { AgentImageActivity } from "./agent-image-activity";
import { ToolActivityDisclosure } from "./tool-activity-disclosure";
import { ToolActivityRow } from "./tool-activity-row";

const toolLabel = (name: string) => ({
  inspect_document: "读取当前文档",
  list_document_regions: "查找文档区域",
  read_document_region: "读取目标内容",
  inspect_node_capabilities: "检查节点能力",
  plan_text_change: "预演修改方案",
  apply_text_change: "修改当前文档",
  apply_text_changes: "批量修改文档",
  list_source_documents: "读取参考资料",
  read_source_document: "读取参考内容",
  list_document_versions: "查看版本历史",
  restore_document_version: "恢复文档版本",
  export_document: "导出文档",
}[name] ?? "执行文档操作");

type TextChange = { expectedText: string; replacement: string };
const asRecord = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const textChange = (value: unknown): TextChange | undefined => {
  const record = asRecord(value);
  return typeof record?.expectedText === "string" && typeof record.replacement === "string" ? { expectedText: record.expectedText, replacement: record.replacement } : undefined;
};

function TextMutationPreview({ activity }: { activity: Extract<AgentActivity, { type: "tool" }> }) {
  const input = asRecord(activity.input);
  if (activity.name === "apply_text_change") {
    const change = textChange(input);
    if (!change) return null;
    return <div className="agent-text-mutation-preview"><div className="agent-text-change"><small>修改前</small><pre>{change.expectedText}</pre><span aria-hidden="true">↓</span><small>修改后</small><pre>{change.replacement}</pre></div></div>;
  }
  const changes = Array.isArray(input?.changes) ? input.changes.map(textChange).filter((change): change is TextChange => Boolean(change)) : [];
  if (activity.name !== "apply_text_changes" || changes.length === 0) return null;
  return <div className="agent-text-mutation-preview"><p>将修改 {changes.length} 处</p>{changes.map((change, index) => <div className="agent-text-change" key={`${index}-${change.expectedText}`}><small>修改前</small><pre>{change.expectedText}</pre><span aria-hidden="true">↓</span><small>修改后</small><pre>{change.replacement}</pre></div>)}</div>;
}

function Activity({ activity, taskId, onApproval, deciding }: { activity: AgentActivity; taskId?: string; onApproval?: (choice: "approved" | "rejected") => void | Promise<void>; deciding: boolean }) {
  if (activity.type === "note") return <div className="agent-activity-note">{renderAgentMarkdown(activity.text)}</div>;
  if (activity.name === "inspect_image" || activity.name === "generate_image" || activity.name === "replace_document_image") return <AgentImageActivity activity={activity} taskId={taskId} onApproval={onApproval} deciding={deciding} />;
  const icon = activity.state === "running" ? <LoaderCircle size={13} className="event-spinner" /> : activity.state === "failed" ? <AlertCircle size={13} /> : activity.state === "approval" ? <Shield size={13} /> : <Check size={13} />;
  const detail = activity.state === "approval" ? "等待你的确认" : activity.state === "failed" ? activity.error ?? "未完成" : activity.state === "running" ? "处理中" : "已完成";
  const row = <ToolActivityRow name={toolLabel(activity.name)} detail={`${detail}${activity.durationMs !== undefined ? ` · ${activity.durationMs}ms` : ""}`} icon={icon} className={activity.state} />;
  if (activity.state !== "approval" || !onApproval) return row;
  const hasTextPreview = activity.name === "apply_text_change" ? Boolean(textChange(asRecord(activity.input))) : activity.name === "apply_text_changes" && Boolean(asRecord(activity.input)?.changes);
  return <ToolActivityDisclosure state={activity.state} initiallyOpen summary={row}><div className="agent-tool-body-content">{hasTextPreview && <TextMutationPreview activity={activity} />}<div className="agent-approval-actions"><button className="primary-small" onClick={() => void onApproval("approved")} disabled={deciding}>批准并执行</button><button onClick={() => void onApproval("rejected")} disabled={deciding}>拒绝</button></div></div></ToolActivityDisclosure>;
}

function Turn({ turn, taskId, onApproval, deciding }: { turn: AgentThreadTurn; taskId?: string; onApproval?: (choice: "approved" | "rejected") => void | Promise<void>; deciding: boolean }) {
  const assistant = turn.assistant;
  const live = assistant.status === "running" || assistant.status === "awaiting_approval" || assistant.status === "awaiting_user";
  const terminal = assistant.status === "completed" || assistant.status === "failed" || assistant.status === "cancelled";
  const [activityOpen, setActivityOpen] = useState(live);
  const previousStatus = useRef(assistant.status);
  useEffect(() => {
    const wasLive = previousStatus.current === "running" || previousStatus.current === "awaiting_approval" || previousStatus.current === "awaiting_user";
    if (!wasLive && live) setActivityOpen(true);
    if (wasLive && terminal) setActivityOpen(false);
    previousStatus.current = assistant.status;
  }, [assistant.status, live, terminal]);
  if (turn.user && assistant.status === "completed" && !assistant.finalContent && !assistant.streamingContent && assistant.activities.length === 0) return <div className="thread-message user" data-status={turn.user.deliveryStatus}><div className="user-bubble"><p>{turn.user.content}</p></div></div>;
  const content = assistant.finalContent ?? assistant.streamingContent;
  return <section className="agent-turn" aria-label="Agent 对话条目">{turn.user && <div className="thread-message user" data-status={turn.user.deliveryStatus}><div className="user-bubble"><p>{turn.user.content}</p></div></div>}<div className="assistant-turn"><div className="assistant-byline"><span className="agent-avatar">鸭</span><strong>纸上鸭</strong><small>{assistant.status === "running" ? "正在处理" : assistant.status === "awaiting_approval" ? "等待确认" : assistant.status === "awaiting_user" ? "等待你的回答" : assistant.status === "failed" ? "未完成" : assistant.status === "cancelled" ? "已取消" : "回复"}</small></div>{assistant.activities.length > 0 && <details className="agent-activity" open={activityOpen} onToggle={(event) => setActivityOpen(event.currentTarget.open)}><summary><span className="agent-activity-icon"><Check size={13} /></span><span>执行过程</span><small>{executionSummary(assistant.status, assistant.activities)}</small></summary><div className="agent-activity-body">{assistant.activities.map((activity) => <Activity key={activity.id} activity={activity} taskId={taskId} onApproval={onApproval} deciding={deciding} />)}</div></details>}{content && <div className="agent-rich-text">{renderAgentMarkdown(content)}</div>}{assistant.status === "failed" && !content && <div className="agent-turn-error"><AlertCircle size={14} />这次请求没有完成，请稍后重试。</div>}</div></section>;
}

export function AgentThread({ taskId, turns, conversationLoading, hasEarlierMessages, onLoadEarlier, loadingEarlierMessages, onApproval, deciding }: { taskId?: string; turns: readonly AgentThreadTurn[]; conversationLoading: boolean; hasEarlierMessages: boolean; onLoadEarlier?: () => void; loadingEarlierMessages: boolean; onApproval?: (choice: "approved" | "rejected") => void | Promise<void>; deciding: boolean }) {
  return <div className="agent-thread" role="log" aria-live="polite">{hasEarlierMessages && onLoadEarlier && <button className="load-earlier" onClick={onLoadEarlier} disabled={loadingEarlierMessages}>{loadingEarlierMessages ? "正在加载更早消息…" : "加载更早消息"}</button>}{conversationLoading && <div className="assistant-turn assistant-loading"><div className="assistant-byline"><span className="agent-avatar">鸭</span><strong>纸上鸭</strong><small>正在打开</small></div><p>正在恢复这个任务的对话…</p></div>}{turns.map((turn) => <Turn key={turn.id} turn={turn} taskId={taskId} onApproval={onApproval} deciding={deciding} />)}</div>;
}

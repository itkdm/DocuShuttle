import { AlertCircle, Check, LoaderCircle, Shield } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { renderAgentMarkdown } from "./agent-markdown";
import { executionSummary, type AgentActivity, type AgentThreadTurn } from "./agent-thread-projection";
import { AgentImageActivity } from "./agent-image-activity";
import { ToolActivityDisclosure } from "./tool-activity-disclosure";
import { ToolTechnicalDetails } from "./tool-technical-details";

const toolLabel = (name: string) => ({ inspect_document: "查找文档区域", list_document_regions: "查找文档区域", read_document_region: "读取目标内容", apply_text_change: "修改当前文档", apply_text_changes: "批量修改文档", inspect_node_capabilities: "检查节点能力" }[name] ?? "执行文档操作");

function Activity({ activity, taskId, onApproval, deciding }: { activity: AgentActivity; taskId?: string; onApproval?: (choice: "approved" | "rejected") => void | Promise<void>; deciding: boolean }) {
  if (activity.type === "note") return <div className="agent-activity-note">{renderAgentMarkdown(activity.text)}</div>;
  if (activity.name === "inspect_image" || activity.name === "generate_image" || activity.name === "replace_document_image") return <AgentImageActivity activity={activity} taskId={taskId} onApproval={onApproval} deciding={deciding} />;
  const icon = activity.state === "running" ? <LoaderCircle size={13} className="event-spinner" /> : activity.state === "failed" ? <AlertCircle size={13} /> : activity.state === "approval" ? <Shield size={13} /> : <Check size={13} />;
  const detail = activity.state === "approval" ? "等待你的确认" : activity.state === "failed" ? activity.error ?? "未完成" : activity.state === "running" ? "处理中" : "已完成";
  return <ToolActivityDisclosure state={activity.state} summary={<><span className={`agent-tool-item ${activity.state}`}><span className="agent-tool-icon">{icon}</span><span className="agent-tool-content"><span className="agent-tool-heading"><strong>{toolLabel(activity.name)}</strong><small>{detail}{activity.durationMs !== undefined && ` · ${activity.durationMs}ms`}</small></span></span></span></>}><div className="agent-tool-detail-content">{activity.state === "approval" && onApproval && <div className="agent-approval-actions"><button className="primary-small" onClick={() => void onApproval("approved")} disabled={deciding}>批准并执行</button><button onClick={() => void onApproval("rejected")} disabled={deciding}>拒绝</button></div>}<ToolTechnicalDetails activity={activity} /></div></ToolActivityDisclosure>;
}

function Turn({ turn, taskId, onApproval, deciding }: { turn: AgentThreadTurn; taskId?: string; onApproval?: (choice: "approved" | "rejected") => void | Promise<void>; deciding: boolean }) {
  const assistant = turn.assistant;
  const live = assistant.status === "running" || assistant.status === "awaiting_approval" || assistant.status === "awaiting_user";
  const [activityOpen, setActivityOpen] = useState(live);
  const previousStatus = useRef(assistant.status);
  useEffect(() => {
    if (previousStatus.current !== "completed" && live) setActivityOpen(true);
    previousStatus.current = assistant.status;
  }, [assistant.status, live]);
  if (turn.user && assistant.status === "completed" && !assistant.finalContent && !assistant.streamingContent && assistant.activities.length === 0) return <div className="thread-message user" data-status={turn.user.deliveryStatus}><div className="user-bubble"><p>{turn.user.content}</p></div></div>;
  const content = assistant.finalContent ?? assistant.streamingContent;
  return <section className="agent-turn" aria-label="Agent 对话条目">{turn.user && <div className="thread-message user" data-status={turn.user.deliveryStatus}><div className="user-bubble"><p>{turn.user.content}</p></div></div>}<div className="assistant-turn"><div className="assistant-byline"><span className="agent-avatar">鸭</span><strong>纸上鸭</strong><small>{assistant.status === "running" ? "正在处理" : assistant.status === "awaiting_approval" ? "等待确认" : assistant.status === "awaiting_user" ? "等待你的回答" : assistant.status === "failed" ? "未完成" : assistant.status === "cancelled" ? "已取消" : "回复"}</small></div>{assistant.activities.length > 0 && <details className="agent-activity" open={activityOpen} onToggle={(event) => setActivityOpen(event.currentTarget.open)}><summary><span className="agent-activity-icon"><Check size={13} /></span><span>执行过程</span><small>{executionSummary(assistant.status, assistant.activities)}</small></summary><div className="agent-activity-body">{assistant.activities.map((activity) => <Activity key={activity.id} activity={activity} taskId={taskId} onApproval={onApproval} deciding={deciding} />)}</div></details>}{content && <div className="agent-rich-text">{renderAgentMarkdown(content)}</div>}{assistant.status === "failed" && !content && <div className="agent-turn-error"><AlertCircle size={14} />这次请求没有完成，请稍后重试。</div>}</div></section>;
}

export function AgentThread({ taskId, turns, conversationLoading, hasEarlierMessages, onLoadEarlier, loadingEarlierMessages, onApproval, deciding }: { taskId?: string; turns: readonly AgentThreadTurn[]; conversationLoading: boolean; hasEarlierMessages: boolean; onLoadEarlier?: () => void; loadingEarlierMessages: boolean; onApproval?: (choice: "approved" | "rejected") => void | Promise<void>; deciding: boolean }) {
  return <div className="agent-thread" role="log" aria-live="polite">{hasEarlierMessages && onLoadEarlier && <button className="load-earlier" onClick={onLoadEarlier} disabled={loadingEarlierMessages}>{loadingEarlierMessages ? "正在加载更早消息…" : "加载更早消息"}</button>}{conversationLoading && <div className="assistant-turn assistant-loading"><div className="assistant-byline"><span className="agent-avatar">鸭</span><strong>纸上鸭</strong><small>正在打开</small></div><p>正在恢复这个任务的对话…</p></div>}{turns.map((turn) => <Turn key={turn.id} turn={turn} taskId={taskId} onApproval={onApproval} deciding={deciding} />)}</div>;
}

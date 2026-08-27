import type { BrowserAgentLoopResult } from "@/modules/agent/browser-runtime";
import type { ConversationMessage } from "./conversation-store";
import { AgentTimeline } from "./agent-timeline";
import { renderAgentMarkdown } from "./agent-markdown";

type AgentEvent = BrowserAgentLoopResult["events"][number];

export function AgentThread({ conversation, events, loadingWorkspace, hasEarlierMessages, onLoadEarlier, loadingEarlierMessages, onApproval, deciding, onCancel }: {
  conversation: readonly ConversationMessage[];
  events: readonly AgentEvent[];
  loadingWorkspace: boolean;
  hasEarlierMessages: boolean;
  onLoadEarlier?: () => void;
  loadingEarlierMessages: boolean;
  onApproval?: (choice: "approved" | "rejected") => void | Promise<void>;
  deciding: boolean;
  onCancel?: () => void | Promise<void>;
}) {
  return <div className="agent-thread">
    {hasEarlierMessages && onLoadEarlier && <button className="load-earlier" onClick={onLoadEarlier} disabled={loadingEarlierMessages}>{loadingEarlierMessages ? "正在加载更早消息…" : "加载更早消息"}</button>}
    {loadingWorkspace && <div className="assistant-turn assistant-loading" aria-live="polite"><div className="assistant-byline"><span className="agent-avatar">鸭</span><strong>纸上鸭</strong><small>正在打开</small></div><p>正在恢复这个任务的文档和对话…</p></div>}
    {conversation.map((message) => <div className={`thread-message ${message.role}`} key={message.id ?? `${message.role}:${message.text}`}>
      {message.role === "user" ? <div className="user-bubble"><span className="thread-label">你的目标</span><p>{message.text}</p></div> : <div className="assistant-turn"><div className="assistant-byline"><span className="agent-avatar">鸭</span><strong>纸上鸭</strong>{message.status === "pending" && <small>正在发送…</small>}</div><div className="agent-rich-text">{renderAgentMarkdown(message.text)}</div></div>}
    </div>)}
    {events.length > 0 && <AgentTimeline events={events} onApproval={onApproval} deciding={deciding} onCancel={onCancel} />}
  </div>;
}

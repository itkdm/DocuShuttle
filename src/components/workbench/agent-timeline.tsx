import { AlertCircle, Check, ChevronRight, LoaderCircle, Shield, StopCircle } from "lucide-react";
import type { AgentEvent } from "@/modules/agent/application/events";
import { renderAgentMarkdown } from "./agent-markdown";

type ToolState = "running" | "completed" | "failed" | "approval";

export type TimelineItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "message"; id: string; text: string }
  | { kind: "thought"; id: string; text: string; channel?: "commentary" | "reasoning_summary" | "final" }
  | { kind: "tool"; id: string; name: string; state: ToolState; input?: unknown; output?: unknown; error?: string; durationMs?: number }
  | { kind: "status"; id: string; state: "completed" | "failed" | "cancelled"; text: string };

const toolNames: Record<string, { label: string; detail: string }> = {
  inspect_document: { label: "读取当前文档", detail: "查看文档结构和版本" },
  list_document_regions: { label: "查找文档区域", detail: "定位可操作的语义节点" },
  read_document_region: { label: "读取目标内容", detail: "读取选定节点的当前文本" },
  inspect_node_capabilities: { label: "检查节点能力", detail: "确认安全可用的操作" },
  plan_text_change: { label: "预演修改方案", detail: "检查目标、风险和预期结果" },
  apply_text_change: { label: "修改当前文档", detail: "创建新的文档版本" },
  apply_text_changes: { label: "批量修改文档", detail: "原子更新多个文档区域" },
  list_source_documents: { label: "读取参考资料", detail: "查看模板、示例或辅助资料" },
  read_source_document: { label: "读取参考内容", detail: "提取参考文档中的相关内容" },
  list_document_versions: { label: "查看版本历史", detail: "读取不可变文档版本" },
  restore_document_version: { label: "恢复文档版本", detail: "从历史版本创建新的版本" },
  export_document: { label: "导出文档", detail: "准备当前版本的下载" },
};

export const toolPresentation = (name: string) => toolNames[name] ?? { label: "执行文档操作", detail: "处理当前文档" };

const sensitiveKey = /(api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|authorization|credential|system[-_]?prompt|base64)/i;
export function sanitizeForDisplay(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[已省略更深内容]";
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeForDisplay(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 40).map(([key, entry]) => [key, sensitiveKey.test(key) ? "[已隐藏]" : sanitizeForDisplay(entry, depth + 1)]));
  }
  return value;
}

const compact = (value: unknown) => {
  if (value === undefined) return "";
  try {
    const text = JSON.stringify(sanitizeForDisplay(value), null, 2);
    return text.length > 1600 ? `${text.slice(0, 1600)}…` : text;
  } catch { return ""; }
};

const eventText = (event: AgentEvent) => "text" in event && typeof event.text === "string" ? event.text : undefined;
const eventName = (event: AgentEvent) => "name" in event && typeof event.name === "string" ? event.name : undefined;
const eventError = (event: AgentEvent) => "error" in event && typeof event.error === "string" ? event.error : undefined;
const eventId = (event: AgentEvent, fallback: string) => typeof event.eventId === "string" ? event.eventId : fallback;
const eventCallId = (event: AgentEvent) => "callId" in event && typeof event.callId === "string" ? event.callId : undefined;
const eventDuration = (event: AgentEvent, value?: unknown) => {
  const direct = (event as unknown as Record<string, unknown>).durationMs;
  if (typeof direct === "number") return direct;
  if (value && typeof value === "object" && typeof (value as Record<string, unknown>).durationMs === "number") return (value as Record<string, unknown>).durationMs as number;
  return undefined;
};
const eventChannel = (event: AgentEvent) => {
  const channel = (event as unknown as Record<string, unknown>).channel;
  return channel === "commentary" || channel === "reasoning_summary" || channel === "final" ? channel : undefined;
};

export function mergeTimelineEvents(previous: readonly AgentEvent[], incoming: readonly AgentEvent[]): AgentEvent[] {
  const result = [...previous];
  const stableIdentity = (event: AgentEvent) => `event:${event.eventId}`;
  const seen = new Set(previous.map(stableIdentity));
  incoming.forEach((event) => {
    const key = stableIdentity(event);
    const existingIndex = result.findIndex((item) => stableIdentity(item) === key);
    if (existingIndex >= 0) {
      const existing = result[existingIndex] as AgentEvent & { sequence?: number };
      const candidate = event as AgentEvent & { sequence?: number };
      if (existing.sequence === undefined && candidate.sequence !== undefined) result[existingIndex] = event;
      return;
    }
    // Reconcile optimistic and durable user turns only through the client
    // message identity. Text is content, not identity: the same prompt may
    // legitimately appear in more than one turn.
    if (event.type === "turn.started" && eventText(event)) {
      const clientMessageId = (event as AgentEvent & { clientMessageId?: unknown }).clientMessageId;
      const optimisticIndex = typeof clientMessageId === "string"
        ? result.findIndex((item) => item.type === "turn.started" && (item as AgentEvent & { clientMessageId?: unknown }).clientMessageId === clientMessageId)
        : -1;
      if (optimisticIndex >= 0) {
        result[optimisticIndex] = event;
        seen.add(key);
        return;
      }
    }
    seen.add(key);
    result.push(event);
  });
  return result.map((event, index) => ({ event, index })).sort((a, b) => {
    const as = (a.event as { sequence?: unknown }).sequence;
    const bs = (b.event as { sequence?: unknown }).sequence;
    const ar = (a.event as { runId?: unknown }).runId;
    const br = (b.event as { runId?: unknown }).runId;
    if (typeof as === "number" && typeof bs === "number" && ar === br) return as - bs || a.index - b.index;
    const at = a.event.timestamp ? Date.parse(a.event.timestamp) : Number.NaN;
    const bt = b.event.timestamp ? Date.parse(b.event.timestamp) : Number.NaN;
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
    return a.index - b.index;
  }).map(({ event }) => event);
}

export function isTimelineActive(events: readonly AgentEvent[], items: readonly TimelineItem[]): boolean {
  if (events.some((event) => event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled")) return false;
  if (items.some((item) => item.kind === "tool" && item.state === "running")) return true;
  const last = events.at(-1)?.type;
  // A local turn.started is rendered before the request reaches the server.
  // Keep the run affordance visible during that short create/stream gap too.
  return last === "turn.started" || last === "model.started" || last === "model.delta" || last === "tool.started";
}

export function buildTimeline(events: readonly AgentEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const toolIndex = new Map<string, number>();
  let streamedText = "";
  let streamedIndex: number | undefined;
  let previousEventType: string | undefined;
  for (const event of events) {
    const id = eventId(event, `${event.type}-${items.length}`);
    if (event.type === "turn.started" && eventText(event)) { streamedText = ""; streamedIndex = undefined; items.push({ kind: "user", id, text: eventText(event)! }); }
    else if (event.type === "model.delta" && eventText(event)) {
      streamedText += eventText(event)!;
      const previous = items.at(-1);
      if (previous?.kind === "thought" && streamedIndex === items.length - 1) previous.text = streamedText;
      else { streamedIndex = items.length; items.push({ kind: "thought", id, text: streamedText, channel: eventChannel(event) }); }
    } else if (event.type === "assistant.message" && eventText(event)) {
      const streamed = streamedIndex === undefined ? undefined : items[streamedIndex];
      if (streamed?.kind === "thought" && eventText(event) === streamedText) {
        items[streamedIndex!] = { kind: "message", id: streamed.id, text: eventText(event)! };
      } else if (eventText(event) !== streamedText) items.push({ kind: "message", id, text: eventText(event)! });
      streamedText = "";
      streamedIndex = undefined;
    } else if (event.type === "tool.started" && eventName(event) && eventCallId(event)) {
      streamedText = "";
      streamedIndex = undefined;
      const callId = eventCallId(event)!;
      const existing = toolIndex.get(callId);
      if (existing !== undefined) {
        const item = items[existing];
        if (item.kind === "tool") { item.state = "running"; item.input = event.input; }
      } else {
        toolIndex.set(callId, items.length);
        items.push({ kind: "tool", id: callId, name: eventName(event)!, state: "running", input: event.input });
      }
    } else if (event.type === "tool.completed" && eventName(event)) {
      const callId = eventCallId(event) ?? id;
      const index = toolIndex.get(callId);
      if (index === undefined) items.push({ kind: "tool", id: callId, name: eventName(event)!, state: "completed", output: event.output, durationMs: eventDuration(event, event.output) });
      else { const item = items[index]; if (item.kind === "tool") { item.state = "completed"; item.output = event.output; item.durationMs = eventDuration(event, event.output); } }
    } else if (event.type === "tool.failed" && eventName(event)) {
      const callId = eventCallId(event) ?? id;
      const index = toolIndex.get(callId);
      if (index === undefined) items.push({ kind: "tool", id: callId, name: eventName(event)!, state: "failed", error: eventError(event), durationMs: eventDuration(event) });
      else { const item = items[index]; if (item.kind === "tool") { item.state = "failed"; item.error = eventError(event); item.durationMs = eventDuration(event); } }
    } else if (event.type === "approval.required" && eventName(event)) {
      const callId = eventCallId(event) ?? id;
      const index = toolIndex.get(callId);
      if (index === undefined) { toolIndex.set(callId, items.length); items.push({ kind: "tool", id: callId, name: eventName(event)!, state: "approval", input: event.input }); }
      else { const item = items[index]; if (item.kind === "tool") item.state = "approval"; }
    } else if (event.type === "approval.resolved" && eventName(event)) {
      const callId = eventCallId(event) ?? id;
      const decision = (event as unknown as Record<string, unknown>).decision;
      const state = decision === "rejected" ? "failed" : "running";
      const index = toolIndex.get(callId);
      if (index === undefined) {
        toolIndex.set(callId, items.length);
        items.push({ kind: "tool", id: callId, name: eventName(event)!, state, error: state === "failed" ? "用户已拒绝此操作。" : undefined });
      } else {
        const item = items[index];
        if (item.kind === "tool") { item.state = state; if (state === "failed") item.error = "用户已拒绝此操作。"; }
      }
      } else if (event.type === "turn.completed") {
      const streamed = streamedIndex === undefined ? undefined : items[streamedIndex];
      if (streamed?.kind === "thought") items[streamedIndex!] = { kind: "message", id: streamed.id, text: streamed.text };
      streamedText = ""; streamedIndex = undefined;
      // The assistant.message immediately before this event contains the
      // user-facing answer. Keep the terminal marker concise so the final
      // response is not rendered a second time as a status line.
      items.push({ kind: "status", id, state: "completed", text: "本轮已完成" });
    } else if (event.type === "turn.failed") {
      // Provider failures already emit an assistant.message immediately before
      // the terminal event. Keep one user-facing explanation instead of
      // rendering a second red copy of the same failure.
      if (previousEventType !== "assistant.message") items.push({ kind: "status", id, state: "failed", text: eventError(event) ?? "本轮未完成" });
    }
    else if (event.type === "turn.cancelled") items.push({ kind: "status", id, state: "cancelled", text: eventText(event) ?? "本轮操作已取消。" });
    previousEventType = event.type;
  }
  // A disconnected/partial stream may not include assistant.message yet;
  // keep the visible text as a thought until a terminal event arrives.
  return items;
}

function StateIcon({ state }: { state: ToolState }) {
  if (state === "running") return <LoaderCircle size={14} className="event-spinner" />;
  if (state === "approval") return <Shield size={14} />;
  if (state === "failed") return <AlertCircle size={14} />;
  return <Check size={14} />;
}

export function AgentTimeline({ events, onApproval, deciding = false, onCancel }: { events: readonly AgentEvent[]; onApproval?: (choice: "approved" | "rejected") => void | Promise<void>; deciding?: boolean; onCancel?: () => void | Promise<void> }) {
  const items = buildTimeline(events);
  const active = isTimelineActive(events, items);
  const activityItems = items.filter((item) => item.kind === "thought" || item.kind === "tool");
  const hasApproval = activityItems.some((item) => item.kind === "tool" && item.state === "approval");
  const renderItem = (item: TimelineItem) => {
    if (item.kind === "user") return <div className="timeline-message user" key={item.id}><div className="message-meta"><span>你</span><strong>你的目标</strong></div><p>{item.text}</p></div>;
    if (item.kind === "thought") return <div className="timeline-thought" key={item.id}><span className="timeline-label">纸上鸭 · 工作说明</span><div className="agent-rich-text">{renderAgentMarkdown(item.text)}</div></div>;
    if (item.kind === "message") return <div className="timeline-message agent" key={item.id}><div className="message-meta"><span>鸭</span><strong>纸上鸭</strong></div><div className="agent-rich-text">{renderAgentMarkdown(item.text)}</div></div>;
    if (item.kind === "status") return <div className={`timeline-status ${item.state}`} key={item.id}><StateIcon state={item.state === "completed" ? "completed" : item.state === "cancelled" ? "approval" : "failed"} /><span>{item.text}</span></div>;
    const presentation = toolPresentation(item.name);
    const detailText = typeof item.error === "string" ? item.error : compact(item.output ?? item.input);
    return <div className={`timeline-tool ${item.state}`} key={item.id}><div className="timeline-tool-head"><span className="timeline-tool-icon"><StateIcon state={item.state} /></span><div><strong>{presentation.label}</strong><small>{presentation.detail}{item.durationMs !== undefined && <> · {item.durationMs}ms</>}</small></div><ChevronRight size={14} /></div>{item.state === "approval" && onApproval && <div className="timeline-approval"><p>这一步会修改文档并创建新的版本，需要你的确认。</p><div><button className="primary-small" onClick={() => void onApproval("approved")} disabled={deciding}>批准并执行</button><button onClick={() => void onApproval("rejected")} disabled={deciding}>拒绝</button></div></div>}{(detailText || item.name) && <details><summary>技术详情</summary><small><code>{item.name}</code></small>{detailText && <pre>{detailText}</pre>}</details>}</div>;
  };
  return <div className="agent-timeline">
    {active && onCancel && <div className="timeline-run-toolbar"><span><LoaderCircle size={13} className="event-spinner" />正在运行</span><button type="button" onClick={() => void onCancel()}><StopCircle size={13} />取消运行</button></div>}
    {items.filter((item) => item.kind !== "thought" && item.kind !== "tool").map(renderItem)}
    {activityItems.length > 0 && <details className="agent-activity" open={active || hasApproval}>
      <summary><span className="agent-activity-icon"><Check size={13} /></span><span>执行过程</span><small>{active ? "正在处理" : `已完成 ${activityItems.filter((item) => item.kind === "tool").length} 个步骤`}</small></summary>
      <div className="agent-activity-body">{activityItems.map(renderItem)}</div>
    </details>}
  </div>;
}

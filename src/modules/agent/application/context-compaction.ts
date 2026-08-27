import type { AgentLoopMessage } from "./loop";

/**
 * Policy for the model-facing context. Durable checkpoints keep the execution
 * trace separately; this policy only decides how much conversational history
 * is sent to the next model turn.
 *
 * The interface is intentionally small so a provider-backed summarizer can be
 * added later without coupling the loop to a particular model or framework.
 */
export type AgentContextCompactionPolicy = {
  /** Approximate character budget for the messages sent to the model. */
  maxCharacters: number;
  /** Maximum number of message records sent to the model. */
  maxMessages: number;
  /** Number of recent conversational units to retain after compaction. */
  keepRecentUnits: number;
  /** Maximum characters copied from one historical user request. */
  maxUserSummaryCharacters: number;
};

export const DEFAULT_AGENT_CONTEXT_COMPACTION_POLICY: AgentContextCompactionPolicy = {
  maxCharacters: 48_000,
  maxMessages: 56,
  keepRecentUnits: 16,
  maxUserSummaryCharacters: 600,
};

export type AgentContextCompactionResult = {
  messages: AgentLoopMessage[];
  compacted: boolean;
  originalMessageCount: number;
  originalCharacters: number;
  retainedMessageCount: number;
};

type MessageUnit = AgentLoopMessage[];

const messageCharacters = (message: AgentLoopMessage) => {
  let value = message.content.length;
  if (message.toolCallId) value += message.toolCallId.length;
  if (message.toolName) value += message.toolName.length;
  if (message.toolCalls) value += JSON.stringify(message.toolCalls).length;
  return value;
};

const textForSummary = (text: string, max: number) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
};

const parseToolContent = (content: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(content);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
};

const toolEvidence = (message: AgentLoopMessage) => {
  const value = parseToolContent(message.content);
  if (!value) return `${message.toolName ?? "工具"}：${textForSummary(message.content, 180)}`;
  const fields = ["summary", "revision", "nodeId", "changedCount", "riskLevel", "valid"]
    .filter((key) => value[key] !== undefined)
    .map((key) => `${key}=${textForSummary(String(value[key]), 120)}`);
  return `${message.toolName ?? "工具"}${fields.length ? `（${fields.join("，")}）` : "已返回结果"}`;
};

const compactValueForContext = (value: unknown, depth = 0): unknown => {
  if (depth > 4) return "[内容已省略]";
  if (typeof value === "string") return value.length > 1_200 ? `${value.slice(0, 1_200)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 24).map((item) => compactValueForContext(item, depth + 1));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const preferred = ["summary", "revision", "nodeId", "text", "changedCount", "riskLevel", "validation", "counts", "nodes", "operations"];
    const keys = [...preferred.filter((key) => key in record), ...Object.keys(record).filter((key) => !preferred.includes(key))].slice(0, 32);
    return Object.fromEntries(keys.map((key) => [key, compactValueForContext(record[key], depth + 1)]));
  }
  return value;
};

const compactToolContentForContext = (content: string, maxCharacters: number) => {
  if (content.length <= maxCharacters) return content;
  const parsed = parseToolContent(content);
  if (parsed) {
    const compacted = JSON.stringify(compactValueForContext(parsed));
    if (compacted.length <= maxCharacters) return compacted;
    // Preserve a valid JSON object even when an unusually large nested result
    // still exceeds the budget. The key evidence is also present in the
    // summary message, while the recent result remains machine-parseable.
    return JSON.stringify({
      summary: parsed.summary ?? "工具结果已压缩",
      revision: parsed.revision,
      nodeId: parsed.nodeId,
      changedCount: parsed.changedCount,
      riskLevel: parsed.riskLevel,
    });
  }
  return `${content.slice(0, Math.max(0, maxCharacters - 1))}…`;
};

/**
 * Group messages into units so an assistant tool-call record can never be
 * separated from its corresponding tool result. This mirrors the invariant
 * required by OpenAI-compatible APIs and the message-state model used by
 * LangGraph/LangChain and pi-style agent loops.
 */
const buildUnits = (messages: readonly AgentLoopMessage[]): MessageUnit[] => {
  const units: MessageUnit[] = [];
  for (const message of messages) {
    const previous = units.at(-1);
    if (message.role === "tool" && previous?.[0]?.role === "assistant" && previous.some((item) => item.toolCalls?.some((call) => call.id === message.toolCallId))) {
      previous.push(message);
    } else {
      units.push([message]);
    }
  }
  return units.map((unit) => {
    const assistant = unit[0];
    if (assistant?.role !== "assistant" || !assistant.toolCalls) return unit;
    const resultIds = new Set(unit.filter((message) => message.role === "tool").map((message) => message.toolCallId));
    const pairedCalls = assistant.toolCalls.filter((call) => resultIds.has(call.id));
    if (pairedCalls.length === assistant.toolCalls.length) return unit;
    // A crash can leave an assistant tool call without its result. Never send
    // that malformed half-pair to an OpenAI-compatible provider after
    // compaction; retain completed calls and make the unresolved boundary
    // explicit so the model can reassess instead of blindly retrying it.
    const normalizedAssistant = pairedCalls.length > 0
      ? { ...assistant, toolCalls: pairedCalls }
      : { role: "assistant" as const, content: `${assistant.content}\n上一次工具调用未返回结果，请先重新评估当前文档状态。` };
    return [normalizedAssistant, ...unit.slice(1).filter((message) => message.role === "tool" && resultIds.has(message.toolCallId))];
  });
};

const summaryMessage = (prior: readonly MessageUnit[], policy: AgentContextCompactionPolicy): AgentLoopMessage | undefined => {
  const userGoals = prior.flatMap((unit) => unit.filter((message) => message.role === "user").map((message) => textForSummary(message.content, policy.maxUserSummaryCharacters)));
  const evidence = prior.flatMap((unit) => unit.filter((message) => message.role === "tool").map(toolEvidence));
  if (userGoals.length === 0 && evidence.length === 0) return undefined;
  const lines = ["【此前对话摘要】"]; 
  if (userGoals.length) lines.push(`用户目标：${userGoals.slice(-8).join("；")}`);
  if (evidence.length) lines.push(`已确认的文档事实：${evidence.slice(-12).join("；")}`);
  lines.push("继续处理时以当前文档 revision、节点地址和最近工具结果为准；不确定时重新读取，不要假设旧状态仍然有效。");
  return { role: "assistant", content: lines.join("\n") };
};

/**
 * Deterministically compacts history without making an extra model call.
 * Keeping recent units and a small factual summary avoids adding latency to
 * tiny edits while making long conversations safe to continue and resume.
 */
export const compactAgentMessages = (
  messages: readonly AgentLoopMessage[],
  policy: AgentContextCompactionPolicy = DEFAULT_AGENT_CONTEXT_COMPACTION_POLICY,
): AgentContextCompactionResult => {
  const originalCharacters = messages.reduce((sum, message) => sum + messageCharacters(message), 0);
  const withinBudget = messages.length <= policy.maxMessages && originalCharacters <= policy.maxCharacters;
  if (withinBudget) {
    return { messages: [...messages], compacted: false, originalMessageCount: messages.length, originalCharacters, retainedMessageCount: messages.length };
  }

  const units = buildUnits(messages);
  const systemUnits = units.filter((unit) => unit.some((message) => message.role === "system"));
  const recentCandidates = units.slice(-Math.max(1, policy.keepRecentUnits));
  const recentUnits: MessageUnit[] = [];
  let recentMessageCount = 0;
  for (const unit of [...recentCandidates].reverse()) {
    if (recentUnits.length > 0 && recentMessageCount + unit.length > policy.maxMessages) continue;
    recentUnits.unshift(unit);
    recentMessageCount += unit.length;
  }
  const priorUnits = units.slice(0, Math.max(0, units.length - recentUnits.length)).filter((unit) => !systemUnits.includes(unit));
  const summary = summaryMessage(priorUnits, policy);
  const selected: AgentLoopMessage[] = [
    ...systemUnits.flat(),
    ...(summary ? [summary] : []),
    ...recentUnits.flat(),
  ];

  // A single very large recent tool result should not defeat compaction. Keep
  // tool-call metadata and pair boundaries intact while reducing only result
  // payloads and ordinary assistant prose.
  let remaining = selected;
  while (remaining.length > policy.maxMessages || remaining.reduce((sum, message) => sum + messageCharacters(message), 0) > policy.maxCharacters) {
    const index = remaining.findIndex((message) => message.role === "tool" && message.content.length > 2_000);
    if (index >= 0) {
      remaining = remaining.map((message, messageIndex) => messageIndex === index
        ? { ...message, content: compactToolContentForContext(message.content, 2_000) }
        : message);
      continue;
    }
    const proseIndex = remaining.findIndex((message) => message.role === "assistant" && !message.toolCalls && message.content.length > 1_000);
    if (proseIndex < 0) break;
    remaining = remaining.map((message, messageIndex) => messageIndex === proseIndex
      ? { ...message, content: `${message.content.slice(0, 1_000)}…` }
      : message);
  }
  return { messages: remaining, compacted: true, originalMessageCount: messages.length, originalCharacters, retainedMessageCount: remaining.length };
};

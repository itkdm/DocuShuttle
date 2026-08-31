const SECRET_KEYS = /(?:api.?key|authorization|cookie|access.?token|refresh.?token|secret|password|signed.?url|download.?url|upload.?url|object.?key)/i;
const REASONING_KEYS = /^(reasoning|reasoningText)$/i;
const BASE64_DATA = /^data:image\//i;

export type AgentTraceBinary = { omitted: true; type: string; byteLength: number; sha256?: string };

const isBinary = (value: unknown): value is ArrayBuffer | ArrayBufferView =>
  value instanceof ArrayBuffer || ArrayBuffer.isView(value);

const binaryDescriptor = (value: ArrayBuffer | ArrayBufferView): AgentTraceBinary => ({
  omitted: true,
  type: value instanceof ArrayBuffer ? "ArrayBuffer" : value.constructor.name,
  byteLength: value instanceof ArrayBuffer ? value.byteLength : value.byteLength,
});

export const serializeAgentTraceValue = (value: unknown): unknown => {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, key?: string): unknown => {
    if (key && SECRET_KEYS.test(key)) return "[REDACTED]";
    if (key && REASONING_KEYS.test(key) && typeof current === "string") return { omitted: true, characters: current.length };
    if (typeof current === "string") return BASE64_DATA.test(current) ? { omitted: true, type: "data-url" } : current;
    if (current === undefined) return { omitted: true, type: "undefined" };
    if (typeof current === "bigint") return `${current.toString()}n`;
    if (typeof current === "function" || typeof current === "symbol") return { omitted: true, type: typeof current };
    if (current instanceof Error) return { name: current.name, message: current.message, stack: current.stack };
    if (current instanceof Date) return current.toISOString();
    if (isBinary(current)) return binaryDescriptor(current);
    if (!current || typeof current !== "object") return current;
    if ("type" in current && (current as { type?: unknown }).type === "reasoning" && "text" in current && typeof (current as { text?: unknown }).text === "string") return { type: "reasoning", text: { omitted: true, characters: ((current as { text: string }).text).length } };
    if (seen.has(current)) return "[Circular]";
    seen.add(current);
    if (Array.isArray(current)) return current.map((item) => visit(item));
    const output: Record<string, unknown> = {};
    for (const [entryKey, entry] of Object.entries(current)) output[entryKey] = visit(entry, entryKey);
    return output;
  };
  return visit(value);
};

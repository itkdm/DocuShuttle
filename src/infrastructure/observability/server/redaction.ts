const SECRET_KEYS = /^(api[_-]?key|authorization|cookie|token|access[_-]?token|refresh[_-]?token|secret|password|signed[_-]?url|prompt|content|body|bytes|base64)$/i;
const PREVIEW_ENABLED = process.env.NODE_ENV === "development" && process.env.PAPERDUCK_LOG_CONTENT === "preview";
const MAX_PREVIEW = 120;

export const redact = (value: unknown, key?: string): unknown => {
  if (key && SECRET_KEYS.test(key)) {
    if (PREVIEW_ENABLED && typeof value === "string") return { length: value.length, preview: value.slice(0, MAX_PREVIEW) };
    if (typeof value === "string" || Array.isArray(value) || value instanceof Uint8Array) return { length: value.length };
    return "[REDACTED]";
  }
  if (value instanceof Error) return serializeError(value);
  if (value instanceof Uint8Array) return { length: value.length };
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [entryKey, redact(entry, entryKey)]));
  }
  return value;
};

export const serializeError = (error: unknown) => {
  if (!(error instanceof Error)) return { type: typeof error, code: "UNKNOWN_ERROR", message: String(error) };
  const result: { type: string; code: string; message: string; stack?: string; cause?: unknown } = {
    type: error.name,
    code: typeof (error as Error & { code?: unknown }).code === "string" ? (error as Error & { code: string }).code : "UNKNOWN_ERROR",
    message: error.message,
  };
  if (process.env.NODE_ENV !== "production" && error.stack) result.stack = error.stack;
  if (error.cause !== undefined) result.cause = redact(error.cause);
  return result;
};

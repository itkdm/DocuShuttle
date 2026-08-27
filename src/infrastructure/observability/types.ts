export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type LogContext = {
  requestId?: string;
  taskId?: string;
  runId?: string;
  conversationId?: string;
  documentId?: string;
  callId?: string;
  toolName?: string;
  revision?: string;
  versionId?: string;
};

export type LogMetadata = Record<string, unknown>;

export type LogProfile = "development" | "production" | "test";

export type TimingMark = { name: string; durationMs: number };

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import pino, { type Logger as PinoLogger } from "pino";

import { getLogContext } from "./context";
import { redact, serializeError } from "./redaction";
import type { LogLevel, LogMetadata, LogProfile } from "../types";

const slowThresholds: Record<string, number> = {
  "db.query": 300,
  "document.inspect": 1000,
  "ooxml.mutate": 2000,
  "storage.download": 1000,
  "agent.model.firstToken": 5000,
  "agent.model.total": 15000,
};

const profile = (): LogProfile => process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development";
const safeGitSha = () => process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown";

const createDestination = (currentProfile: LogProfile) => {
  if (currentProfile === "production" || currentProfile === "test") return undefined;
  const directory = path.join(process.cwd(), ".paperduck", "logs");
  fs.mkdirSync(directory, { recursive: true });
  const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.ndjson`;
  return { stream: pino.destination({ dest: path.join(directory, filename), sync: false }), logFile: path.join(directory, filename) };
};

export type EngineeringLogger = {
  trace(event: string, metadata?: LogMetadata, message?: string): void;
  debug(event: string, metadata?: LogMetadata, message?: string): void;
  info(event: string, metadata?: LogMetadata, message?: string): void;
  warn(event: string, metadata?: LogMetadata, message?: string): void;
  error(event: string, metadata?: LogMetadata, message?: string): void;
  fatal(event: string, metadata?: LogMetadata, message?: string): void;
};

export const createEngineeringLogger = (options: { profile?: LogProfile; stream?: NodeJS.WritableStream } = {}): EngineeringLogger => {
  const currentProfile = options.profile ?? profile();
  const destination = options.stream ? { stream: options.stream } : createDestination(currentProfile);
  const sink: PinoLogger = pino({
    level: currentProfile === "development" ? "trace" : "info",
    base: { service: "paperduck", env: currentProfile, schemaVersion: 1 },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: serializeError },
  }, destination?.stream);
  const write = (level: LogLevel, event: string, metadata: LogMetadata = {}, message?: string) => {
    try {
      const fields = redact({ ...getLogContext(), ...metadata, event });
      sink[level](fields, message ?? event);
    } catch {
      // Logging must never make a business operation fail.
    }
  };
  const logger = Object.fromEntries((["trace", "debug", "info", "warn", "error", "fatal"] as const).map((level) => [level, (event: string, metadata?: LogMetadata, message?: string) => write(level, event, metadata, message)])) as EngineeringLogger;
  logger.info("app.started", { gitSha: safeGitSha(), nodeVersion: process.version, pid: process.pid, logFile: destination && "logFile" in destination ? destination.logFile : undefined });
  return logger;
};

export const logger = createEngineeringLogger();
export { slowThresholds };

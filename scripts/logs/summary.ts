import { readLogs, percentile, type LogRecord } from "./common";

const groups = new Map<string, LogRecord[]>();
for (const record of readLogs()) { const operation = record.event?.replace(/\.(completed|failed|slow)$/, "") ?? "unknown"; groups.set(operation, [...(groups.get(operation) ?? []), record]); }
console.log("Operation\tCount\tAvg\tP50\tP95\tMax\tErrors\tSlow");
for (const [operation, records] of groups) { const durations = records.map((r) => r.durationMs).filter((v): v is number => typeof v === "number"); console.log(`${operation}\t${records.length}\t${(durations.reduce((a, b) => a + b, 0) / (durations.length || 1)).toFixed(2)}\t${percentile(durations, .5)}\t${percentile(durations, .95)}\t${Math.max(0, ...durations)}\t${records.filter((r) => r.event?.endsWith(".failed")).length}\t${records.filter((r) => r.slow === true).length}`); }

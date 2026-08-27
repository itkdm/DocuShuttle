import { readLogs } from "./common";
const groups = new Map<string, number>();
for (const record of readLogs().filter((entry) => entry.event?.endsWith(".failed"))) { const error = record.error as { code?: string } | undefined; const key = `${record.event}\t${error?.code ?? "UNKNOWN_ERROR"}`; groups.set(key, (groups.get(key) ?? 0) + 1); }
for (const [key, count] of groups) console.log(`${key}\t${count}`);

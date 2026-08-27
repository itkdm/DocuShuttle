import { readLogs } from "./common";
const id = process.argv[2];
if (!id) throw new Error("Usage: pnpm logs:trace <requestId|runId|taskId>");
for (const record of readLogs().filter((entry) => ["requestId", "runId", "taskId"].some((key) => recordValue(entry, key) === id)).sort((a, b) => String(a.time ?? "").localeCompare(String(b.time ?? "")))) console.log(JSON.stringify(record));
function recordValue(record: Record<string, unknown>, key: string) { return typeof record[key] === "string" ? record[key] : undefined; }

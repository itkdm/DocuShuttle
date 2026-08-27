import { readLogs } from "./common";
for (const record of readLogs().filter((entry) => entry.slow === true || entry.event?.endsWith(".slow")).sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))) console.log(JSON.stringify(record));

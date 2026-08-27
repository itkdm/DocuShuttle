import fs from "node:fs";
import path from "node:path";

export type LogRecord = Record<string, unknown> & { event?: string; level?: number; time?: string; durationMs?: number; slow?: boolean };

export const readLogs = (file = process.argv[2]) => {
  const directory = path.resolve(process.cwd(), ".paperduck", "logs");
  const files = file ? [path.resolve(process.cwd(), file)] : fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith(".ndjson")).sort().map((name) => path.join(directory, name)) : [];
  return files.flatMap((name) => {
    if (!fs.existsSync(name)) return [];
    return fs.readFileSync(name, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as LogRecord]; } catch { return []; } });
  });
};

export const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};

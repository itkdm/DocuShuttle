import { describe, expect, it } from "vitest";
import { SseParser } from "./sse-parser";

const bytes = (value: string) => new TextEncoder().encode(value);

describe("SseParser", () => {
  it.each(["\n", "\r\n", "\r"])("parses %j line endings and multiline data", (ending) => {
    const parser = new SseParser();
    expect(parser.push(bytes(`event: message${ending}id: 7${ending}data: hello${ending}data: 世界${ending}${ending}`))).toEqual([{ event: "message", id: "7", data: "hello\n世界" }]);
  });

  it("ignores comments and supports empty data", () => {
    const parser = new SseParser();
    expect(parser.push(bytes(": ping\nretry: 1500\ndata:\n\n"))).toEqual([{ retry: 1500, data: "" }]);
  });

  it("handles UTF-8 and frame delimiters split across chunks", () => {
    const source = bytes("event: event\ndata: 中文\n\n");
    const parser = new SseParser();
    const result = [...parser.push(source.slice(0, 18)), ...parser.push(source.slice(18, 21)), ...parser.push(source.slice(21)), ...parser.flush()];
    expect(result).toEqual([{ event: "event", data: "中文" }]);
  });

  it("flushes an EOF frame without a trailing blank line", () => {
    const parser = new SseParser();
    expect(parser.push(bytes("data: final"))).toEqual([]);
    expect(parser.flush()).toEqual([{ data: "final" }]);
  });
});

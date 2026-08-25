import { describe, expect, it } from "vitest";
import { formatFileSize, MAX_DOCX_BYTES, validateDocxCandidate } from "./docx-file";

const valid = { name: "报告.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 2048, signature: new Uint8Array([0x50, 0x4b, 3, 4]) };

describe("DOCX file validation", () => {
  it("accepts a DOCX-shaped ZIP file", () => expect(() => validateDocxCandidate(valid)).not.toThrow());
  it.each([
    [{ ...valid, name: "报告.doc" }, "仅支持 .docx"],
    [{ ...valid, size: 0 }, "文件为空"],
    [{ ...valid, size: MAX_DOCX_BYTES + 1 }, "超过 20 MB"],
    [{ ...valid, signature: new Uint8Array([1, 2, 3, 4]) }, "不是有效的 DOCX"],
    [{ ...valid, type: "application/pdf" }, "文件类型与 .docx 不匹配"],
  ])("rejects invalid candidates", (candidate, message) => {
    expect(() => validateDocxCandidate(candidate)).toThrow(message);
  });
  it("formats local file sizes", () => {
    expect(formatFileSize(800)).toBe("1 KB");
    expect(formatFileSize(2.25 * 1024 * 1024)).toBe("2.3 MB");
  });
});

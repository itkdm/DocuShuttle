import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { inspectManualEditCapabilities, manualEditUnsupportedNotice } from "../manual-edit-capability";

async function docx(documentXml: string, extra: Record<string, string> = {}) {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  Object.entries(extra).forEach(([name, value]) => zip.file(name, value));
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

describe("manual edit capability guard", () => {
  it("does not reject a reserved footnote separator", async () => {
    expect(await inspectManualEditCapabilities(await docx("<w:document><w:body/></w:document>", { "word/footnotes.xml": "<w:footnotes><w:footnote w:id=\"-1\"/></w:footnotes>" }))).toEqual([]);
  });

  it("rejects real footnotes, endnotes, and tracked changes", async () => {
    const bytes = await docx("<w:document><w:body><w:ins><w:footnoteReference w:id=\"1\"/><w:endnoteReference w:id=\"2\"/></w:ins></w:body></w:document>", { "word/footnotes.xml": "<w:footnotes/>", "word/endnotes.xml": "<w:endnotes/>" });
    expect(await inspectManualEditCapabilities(bytes)).toEqual(["footnote", "endnote", "tracked_changes"]);
  });

  it("guards embedded objects in document stories", async () => {
    const bytes = await docx("<w:document><w:body><w:p><w:r><w:object><v:shape><v:imagedata/></v:shape><o:OLEObject Type=\"Embed\"/></w:object></w:r></w:p></w:body></w:document>");
    expect(await inspectManualEditCapabilities(bytes)).toEqual(["embedded_object"]);
    expect(manualEditUnsupportedNotice(["embedded_object"])).toBe("这份文档包含当前编辑模式暂不支持安全修改的嵌入对象，目前可以正常预览，但暂不能进入手动编辑。");
  });
});

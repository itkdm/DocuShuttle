import JSZip from "jszip";

export type ManualDocumentEditCapability = "footnote" | "endnote" | "tracked_changes" | "embedded_object";

const capabilityLabels: Record<ManualDocumentEditCapability, string> = {
  footnote: "脚注",
  endnote: "尾注",
  tracked_changes: "修订",
  embedded_object: "嵌入对象",
};

export function manualEditUnsupportedNotice(capabilities: readonly ManualDocumentEditCapability[]): string {
  if (capabilities.includes("embedded_object")) {
    return "这份文档包含当前编辑模式暂不支持安全修改的嵌入对象，目前可以正常预览，但暂不能进入手动编辑。";
  }
  return `这份文档包含当前手动编辑模式尚未安全支持的功能：${capabilities.map((capability) => capabilityLabels[capability]).join("、")}`;
}

/** Detect constructs the browser editor cannot safely round-trip, ignoring empty reserved parts. */
export async function inspectManualEditCapabilities(bytes: Uint8Array): Promise<readonly ManualDocumentEditCapability[]> {
  const zip = await JSZip.loadAsync(bytes);
  const storyEntries = Object.keys(zip.files).filter((name) => /^word\/(document|header\d+|footer\d+)\.xml$/.test(name));
  const stories = await Promise.all(storyEntries.map((name) => zip.files[name].async("string")));
  const capabilities = new Set<ManualDocumentEditCapability>();
  if (stories.some((xml) => /<w:footnoteReference\b[^>]*\bw:id\s*=/.test(xml)) && zip.file("word/footnotes.xml")) capabilities.add("footnote");
  if (stories.some((xml) => /<w:endnoteReference\b[^>]*\bw:id\s*=/.test(xml)) && zip.file("word/endnotes.xml")) capabilities.add("endnote");
  if (stories.some((xml) => /<w:(?:ins|del|moveFrom|moveTo)\b/.test(xml))) capabilities.add("tracked_changes");
  if (stories.some((xml) => /<w:object\b/.test(xml))) capabilities.add("embedded_object");
  return [...capabilities];
}

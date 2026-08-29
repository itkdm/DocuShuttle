import JSZip from "jszip";

export type ManualDocumentEditCapability = "footnote" | "endnote" | "tracked_changes";

/** Detect only constructs that represent actual editable references, not empty reserved parts. */
export async function inspectManualEditCapabilities(bytes: Uint8Array): Promise<readonly ManualDocumentEditCapability[]> {
  const zip = await JSZip.loadAsync(bytes);
  const storyEntries = Object.keys(zip.files).filter((name) => /^word\/(document|header\d+|footer\d+)\.xml$/.test(name));
  const stories = await Promise.all(storyEntries.map((name) => zip.files[name].async("string")));
  const capabilities = new Set<ManualDocumentEditCapability>();
  if (stories.some((xml) => /<w:footnoteReference\b[^>]*\bw:id\s*=/.test(xml)) && zip.file("word/footnotes.xml")) capabilities.add("footnote");
  if (stories.some((xml) => /<w:endnoteReference\b[^>]*\bw:id\s*=/.test(xml)) && zip.file("word/endnotes.xml")) capabilities.add("endnote");
  if (stories.some((xml) => /<w:(?:ins|del|moveFrom|moveTo)\b/.test(xml))) capabilities.add("tracked_changes");
  return [...capabilities];
}

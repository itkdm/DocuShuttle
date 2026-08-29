import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import packageJson from '../package.json' with { type: 'json' };

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../../..');
const outputDir = path.resolve(scriptDir, '../out');

const cases = [
  ['completed-example', path.join(repoRoot, '.remote-audit/samples/参考文档-孔德明-实验1.docx'), path.join(outputDir, 'completed-example-roundtrip.docx')],
  ['derived-template', path.join(repoRoot, '.remote-audit/samples/AI提取的空白模板-实验1.docx'), path.join(outputDir, 'derived-template-roundtrip.docx')],
  ['large-report', path.join(repoRoot, '2310250478-孔德明-实验2.docx'), path.join(outputDir, 'large-report-roundtrip.docx')],
];

const readPart = (filePath, part) => {
  try {
    const zip = new AdmZip(filePath);
    return zip.getEntry(part)?.getData().toString('utf8') ?? null;
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
};

const idsFromDocument = (xml, element) =>
  [...(xml ?? '').matchAll(new RegExp(`<w:${element}[^>]*\\bw:id=["'](-?\\d+)["']`, 'g'))].map((match) => Number(match[1]));

const noteIds = (xml, element) =>
  [...(xml ?? '').matchAll(new RegExp(`<w:${element}\\b[^>]*\\bw:id=["'](-?\\d+)["']([\\s\\S]*?)</w:${element}>`, 'g'))]
    .map((match) => ({ id: Number(match[1]), body: match[2] }))
    .filter(({ id }) => id >= 0 && !/w:type=["'](separator|continuationSeparator|continuationNotice)["']/.test((xml ?? '').slice(Math.max(0, matchIndex(xml, element, id) - 120), matchIndex(xml, element, id) + 120)))
    .map(({ id }) => id);

const matchIndex = (xml, element, id) => {
  const match = new RegExp(`<w:${element}\\b[^>]*\\bw:id=["']${id}["']`, 'i').exec(xml ?? '');
  return match?.index ?? 0;
};

const auditFile = (filePath) => {
  const documentXml = readPart(filePath, 'word/document.xml');
  const footnotesXml = readPart(filePath, 'word/footnotes.xml');
  const endnotesXml = readPart(filePath, 'word/endnotes.xml');
  const relationshipsXml = readPart(filePath, 'word/_rels/document.xml.rels');
  const contentTypesXml = readPart(filePath, '[Content_Types].xml');
  const sourceFootnoteIds = noteIds(footnotesXml, 'footnote');
  const sourceEndnoteIds = noteIds(endnotesXml, 'endnote');
  const footnoteRefs = idsFromDocument(documentXml, 'footnoteReference');
  const endnoteRefs = idsFromDocument(documentXml, 'endnoteReference');
  const relationshipParts = {
    footnotes: /relationships\/footnotes/.test(relationshipsXml ?? ''),
    endnotes: /relationships\/endnotes/.test(relationshipsXml ?? ''),
  };
  const contentTypeParts = {
    footnotes: /word\/footnotes\.xml/.test(contentTypesXml ?? ''),
    endnotes: /word\/endnotes\.xml/.test(contentTypesXml ?? ''),
  };
  return {
    filePath,
    sourceFootnoteIds: sourceFootnoteIds.length ? sourceFootnoteIds : footnoteRefs,
    sourceEndnoteIds: sourceEndnoteIds.length ? sourceEndnoteIds : endnoteRefs,
    footnoteReferences: footnoteRefs,
    endnoteReferences: endnoteRefs,
    hasRealFootnotes: footnoteRefs.some((id) => id > 0) && sourceFootnoteIds.some((id) => id > 0),
    hasRealEndnotes: endnoteRefs.some((id) => id > 0) && sourceEndnoteIds.some((id) => id > 0),
    relationships: relationshipParts,
    contentTypes: contentTypeParts,
    parts: { footnotes: Boolean(footnotesXml), endnotes: Boolean(endnotesXml) },
  };
};

await mkdir(outputDir, { recursive: true });
const results = cases.map(([name, sourcePath, exportedPath]) => ({
  name,
  source: auditFile(sourcePath),
  exported: auditFile(exportedPath),
}));

for (const result of results) {
  result.semanticLoss = {
    footnotes: result.source.hasRealFootnotes && !result.exported.hasRealFootnotes,
    endnotes: result.source.hasRealEndnotes && !result.exported.hasRealEndnotes,
  };
  console.log(`${result.name}: footnoteRefs=${result.source.footnoteReferences.length}->${result.exported.footnoteReferences.length}, endnoteRefs=${result.source.endnoteReferences.length}->${result.exported.endnoteReferences.length}, semanticLoss=${JSON.stringify(result.semanticLoss)}`);
}

const reportPath = path.join(outputDir, 'semantic-note-audit.json');
await writeFile(reportPath, JSON.stringify({ sdkVersion: packageJson.dependencies['@superdoc/sdk'], results }, null, 2));
console.log(`Report: ${reportPath}`);

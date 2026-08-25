import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../../..');
const outputDir = path.resolve(scriptDir, '../out');

const pairs = [
  ['blank-template', path.join(repoRoot, '.remote-audit/samples/空白模板-实验1.docx')],
  ['completed-example', path.join(repoRoot, '.remote-audit/samples/参考文档-孔德明-实验1.docx')],
  ['derived-template', path.join(repoRoot, '.remote-audit/samples/AI提取的空白模板-实验1.docx')],
  ['large-report', path.join(repoRoot, '2310250478-孔德明-实验2.docx')],
].map(([name, source]) => [name, source, path.join(outputDir, `${name}-roundtrip.docx`)]);

const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');
const packageEntries = (filePath) => {
  const zip = new AdmZip(filePath);
  return new Map(
    zip
      .getEntries()
      .filter((entry) => !entry.isDirectory)
      .map((entry) => [entry.entryName, { bytes: entry.header.size, sha256: hash(entry.getData()) }]),
  );
};

const results = [];
for (const [name, sourcePath, outputPath] of pairs) {
  const before = packageEntries(sourcePath);
  const after = packageEntries(outputPath);
  const removed = [...before.keys()].filter((entry) => !after.has(entry)).sort();
  const added = [...after.keys()].filter((entry) => !before.has(entry)).sort();
  const changed = [...before.keys()]
    .filter((entry) => after.has(entry) && before.get(entry).sha256 !== after.get(entry).sha256)
    .sort();
  const unchanged = [...before.keys()].filter(
    (entry) => after.has(entry) && before.get(entry).sha256 === after.get(entry).sha256,
  );

  results.push({
    name,
    sourceBytes: (await readFile(sourcePath)).byteLength,
    outputBytes: (await readFile(outputPath)).byteLength,
    beforeParts: before.size,
    afterParts: after.size,
    removed,
    added,
    changed,
    unchangedCount: unchanged.length,
  });
}

const reportPath = path.join(outputDir, 'package-diff-report.json');
await writeFile(reportPath, JSON.stringify({ results }, null, 2));
for (const result of results) {
  console.log(
    `${result.name}: ${result.beforeParts}->${result.afterParts} parts, ` +
      `removed=${result.removed.length}, added=${result.added.length}, changed=${result.changed.length}`,
  );
}
console.log(`Report: ${reportPath}`);

if (results.some((result) => result.removed.length > 0)) process.exitCode = 1;

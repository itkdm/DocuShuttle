import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SuperDocClient } from '@superdoc/sdk';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../../..');
const outputDir = path.resolve(scriptDir, '../out');

const fixtures = [
  ['blank-template', path.join(repoRoot, '.remote-audit/samples/空白模板-实验1.docx')],
  ['completed-example', path.join(repoRoot, '.remote-audit/samples/参考文档-孔德明-实验1.docx')],
  ['derived-template', path.join(repoRoot, '.remote-audit/samples/AI提取的空白模板-实验1.docx')],
  ['large-report', path.join(repoRoot, '2310250478-孔德明-实验2.docx')],
];

const sha256 = async (filePath) =>
  createHash('sha256').update(await readFile(filePath)).digest('hex');

await mkdir(outputDir, { recursive: true });

const client = new SuperDocClient({ user: { name: 'PaperDuck POC' } });
const results = [];

try {
  await client.connect();

  for (const [name, sourcePath] of fixtures) {
    const startedAt = Date.now();
    const outputPath = path.join(outputDir, `${name}-roundtrip.docx`);
    const result = { name, sourcePath, outputPath };
    let document;

    try {
      document = await client.open({ doc: sourcePath });
      result.openResult = document.openResult;
      result.infoBefore = await document.info();
      result.blocksBefore = await document.blocks.list({ includeText: true });
      result.save = await document.save({ out: outputPath, force: true });
      await document.close();
      document = undefined;

      const reopened = await client.open({ doc: outputPath });
      result.infoAfter = await reopened.info();
      result.blocksAfter = await reopened.blocks.list({ includeText: true });
      await reopened.close();

      result.sourceSha256 = await sha256(sourcePath);
      result.outputSha256 = await sha256(outputPath);
      result.ok = true;
    } catch (error) {
      result.ok = false;
      result.error = {
        name: error?.name,
        message: error?.message,
        code: error?.code,
        details: error?.details,
        stack: error?.stack,
      };
      if (document) await document.close({ discard: true }).catch(() => undefined);
    }

    result.elapsedMs = Date.now() - startedAt;
    results.push(result);
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${name} ${result.elapsedMs}ms`);
  }
} finally {
  await client.dispose().catch(() => undefined);
}

const reportPath = path.join(outputDir, 'roundtrip-report.json');
await writeFile(reportPath, JSON.stringify({ sdkVersion: '2.5.0', results }, null, 2));
console.log(`Report: ${reportPath}`);

if (results.some((result) => !result.ok)) process.exitCode = 1;

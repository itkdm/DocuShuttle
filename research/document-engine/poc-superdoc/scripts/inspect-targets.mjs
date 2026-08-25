import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SuperDocClient } from '@superdoc/sdk';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../../..');
const cases = [
  ['blank-template', path.join(repoRoot, '.remote-audit/samples/空白模板-实验1.docx'), '实验的准备'],
  ['completed-example', path.join(repoRoot, '.remote-audit/samples/参考文档-孔德明-实验1.docx'), '孔德明'],
  ['derived-template', path.join(repoRoot, '.remote-audit/samples/AI提取的空白模板-实验1.docx'), '实验的准备'],
  ['large-report', path.join(repoRoot, '2310250478-孔德明-实验2.docx'), '孔德明'],
];

const client = new SuperDocClient({ user: { name: 'PaperDuck POC' } });
try {
  await client.connect();
  for (const [name, filePath, pattern] of cases) {
    const document = await client.open({ doc: filePath });
    try {
      const found = await document.find({ type: 'text', pattern, mode: 'contains', limit: 10 });
      console.log(JSON.stringify({ name, pattern, found }, null, 2));
    } finally {
      await document.close({ discard: true });
    }
  }
} finally {
  await client.dispose().catch(() => undefined);
}

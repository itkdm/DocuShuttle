import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SuperDocClient } from '@superdoc/sdk';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../../..');
const cases = [
  ['completed-example', path.join(repoRoot, '.remote-audit/samples/参考文档-孔德明-实验1.docx')],
  ['large-report', path.join(repoRoot, '2310250478-孔德明-实验2.docx')],
];

const client = new SuperDocClient({ user: { name: 'PaperDuck POC' } });
try {
  await client.connect();
  for (const [name, filePath] of cases) {
    const document = await client.open({ doc: filePath });
    try {
      console.log(JSON.stringify({ name, images: await document.images.list() }, null, 2));
    } finally {
      await document.close({ discard: true });
    }
  }
} finally {
  await client.dispose().catch(() => undefined);
}

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { SuperDocClient } from '@superdoc/sdk';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../../..');
const outputDir = path.resolve(scriptDir, '../out');

const cases = [
  {
    name: 'blank-template',
    sourcePath: path.join(repoRoot, '.remote-audit/samples/空白模板-实验1.docx'),
    pattern: '实验的准备',
    replacement: '实验准备',
    mutateTable: true,
  },
  {
    name: 'completed-example',
    sourcePath: path.join(repoRoot, '.remote-audit/samples/参考文档-孔德明-实验1.docx'),
    pattern: '孔德明',
    replacement: '纸上鸭同学',
    replacementImage: {
      docx: path.join(repoRoot, '2310250478-孔德明-实验2.docx'),
      entry: 'word/media/image2.png',
    },
  },
  {
    name: 'derived-template',
    sourcePath: path.join(repoRoot, '.remote-audit/samples/AI提取的空白模板-实验1.docx'),
    pattern: '实验的准备',
    replacement: '实验准备',
    mutateTable: true,
  },
  {
    name: 'large-report',
    sourcePath: path.join(repoRoot, '2310250478-孔德明-实验2.docx'),
    pattern: '孔德明',
    replacement: '纸上鸭同学',
    replacementImage: {
      docx: path.join(repoRoot, '.remote-audit/samples/参考文档-孔德明-实验1.docx'),
      entry: 'word/media/image1.png',
    },
  },
];

const getSearchRef = (found) =>
  found.items?.[0]?.context?.ancestors?.find((ancestor) => ancestor.kind === 'v2-search-ref')?.id;

await mkdir(outputDir, { recursive: true });
const client = new SuperDocClient({ user: { name: 'PaperDuck POC' } });
const results = [];

try {
  await client.connect();

  for (const testCase of cases) {
    const result = { name: testCase.name };
    let document;
    try {
      const trackedPath = path.join(outputDir, `${testCase.name}-tracked.docx`);
      const finalPath = path.join(outputDir, `${testCase.name}-mutated.docx`);
      document = await client.open({ doc: testCase.sourcePath });
      let tableId;
      if (testCase.mutateTable) {
        const table = await document.find({ type: 'table', limit: 2 });
        tableId = table.items?.[0]?.address?.nodeId;
        if (!tableId) throw new Error('Table address not found');
      }

      const found = await document.find({
        type: 'text',
        pattern: testCase.pattern,
        mode: 'contains',
        limit: 2,
      });
      const ref = getSearchRef(found);
      if (found.total !== 1 || !ref) throw new Error(`Expected one stable search ref for ${testCase.pattern}`);

      result.textReplace = await document.replace({
        ref,
        text: testCase.replacement,
        changeMode: 'tracked',
      });
      result.trackedBeforeSave = await document.trackChanges.list();
      if (result.trackedBeforeSave.total < 1) throw new Error('Tracked replacement produced no tracked changes');

      result.trackedSave = await document.save({ out: trackedPath, force: true, mode: 'review-preserving' });
      await document.close();
      document = await client.open({ doc: trackedPath });

      result.trackedAfterReopen = await document.trackChanges.list();
      if (result.trackedAfterReopen.total < 1) throw new Error('Tracked changes did not survive save and reopen');
      try {
        result.accept = await document.trackChanges.decide({
          decision: 'accept',
          target: { kind: 'ids', ids: result.trackedAfterReopen.items.map((item) => item.id) },
        });
      } catch (error) {
        result.trackedDecisionFailure = {
          name: error?.name,
          message: error?.message,
          code: error?.code,
          details: error?.details,
        };

        // Continue the capability matrix from a clean source using a direct edit.
        // The tracked-decision failure remains a separate hard product finding.
        await document.close({ discard: true });
        document = await client.open({ doc: testCase.sourcePath });
        const directFound = await document.find({
          type: 'text',
          pattern: testCase.pattern,
          mode: 'contains',
          limit: 2,
        });
        const directRef = getSearchRef(directFound);
        if (!directRef) throw new Error(`Direct-edit fallback could not resolve ${testCase.pattern}`);
        result.directFallback = await document.replace({
          ref: directRef,
          text: testCase.replacement,
          changeMode: 'direct',
        });
      }

      if (testCase.mutateTable) {
        result.tableMutation = await document.tables.setCellText({
          target: { kind: 'block', nodeType: 'table', nodeId: tableId },
          rowIndex: 0,
          columnIndex: 0,
          text: `纸上鸭表格回归-${testCase.name}`,
          changeMode: 'direct',
        });
      }

      if (testCase.replacementImage) {
        const images = await document.images.list();
        const imageId = images.items?.[0]?.sdImageId;
        if (!imageId) throw new Error('Image address not found');
        const replacementZip = new AdmZip(testCase.replacementImage.docx);
        const replacementEntry = replacementZip.getEntry(testCase.replacementImage.entry);
        if (!replacementEntry) throw new Error(`Replacement media missing: ${testCase.replacementImage.entry}`);
        const replacementData = replacementEntry.getData();
        const replacementPath = path.join(outputDir, `${testCase.name}-replacement.png`);
        await writeFile(replacementPath, replacementData);
        result.imageReplace = await document.images.replaceSource({
          imageId,
          src: `data:image/png;base64,${replacementData.toString('base64')}`,
          resetSize: false,
          changeMode: 'direct',
        });
        result.imageAlt = await document.images.setAltText({
          imageId,
          description: `PaperDuck POC ${testCase.name}`,
          changeMode: 'direct',
        });
      }

      result.finalSave = await document.save({ out: finalPath, force: true, mode: 'final' });
      // `mode: final` writes the exported file but SDK 2.5.0 still reports the
      // in-memory session as dirty; discard only that already-exported session.
      await document.close({ discard: true });
      document = await client.open({ doc: finalPath });

      result.infoAfter = await document.info();
      result.trackedFinal = await document.trackChanges.list();
      result.replacementSearch = await document.find({
        type: 'text',
        pattern: testCase.replacement,
        mode: 'contains',
        limit: 2,
      });
      if (result.replacementSearch.total < 1) throw new Error('Accepted replacement was not found after final reopen');
      if (result.trackedFinal.total !== 0) throw new Error('Final export still contains tracked changes');

      if (testCase.mutateTable) {
        result.tableSearch = await document.find({
          type: 'text',
          pattern: '纸上鸭表格回归',
          mode: 'contains',
          limit: 2,
        });
        if (result.tableSearch.total < 1) throw new Error('Table mutation was not found after final reopen');
      }
      if (testCase.replacementImage) {
        result.imagesAfter = await document.images.list();
        const description = result.imagesAfter.items?.[0]?.properties?.description;
        if (description !== `PaperDuck POC ${testCase.name}`) throw new Error('Image metadata did not survive reopen');
      }

      await document.close();
      document = undefined;
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

    results.push(result);
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${testCase.name}${result.error ? `: ${result.error.message}` : ''}`);
  }
} finally {
  await client.dispose().catch(() => undefined);
}

const reportPath = path.join(outputDir, 'mutation-report.json');
await writeFile(reportPath, JSON.stringify({ sdkVersion: '2.5.0', results }, null, 2));
console.log(`Report: ${reportPath}`);
if (results.some((result) => !result.ok)) process.exitCode = 1;

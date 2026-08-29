import { SuperDoc } from 'superdoc';
import 'superdoc/style.css';
import './style.css';

const editor = document.querySelector('#editor');
const status = document.querySelector('#status');
const diagnostics = document.querySelector('#diagnostics');
const fileInput = document.querySelector('#file-input');
const exportButton = document.querySelector('#export-button');
const captureButton = document.querySelector('#capture-button');
let instance;
let readyAt;

const setStatus = (message) => { status.textContent = message; };
const report = (message) => { diagnostics.textContent = message; };

function mount(documentSource) {
  instance?.destroy();
  editor.replaceChildren();
  exportButton.disabled = true;
  captureButton.disabled = true;
  setStatus('正在加载 DOCX…');
  const startedAt = performance.now();
  instance = new SuperDoc({
    selector: editor,
    document: documentSource,
    documentMode: 'editing',
    onReady: () => {
      readyAt = performance.now();
      setStatus(`已就绪 · ${Math.round(readyAt - startedAt)}ms`);
      exportButton.disabled = false;
      captureButton.disabled = false;
      report('可编辑。请修改正文、表格单元格或格式后导出。');
    },
    onContentError: ({ error }) => {
      setStatus('加载失败');
      report(`SuperDoc content error: ${error?.message ?? error}`);
      console.error('SuperDoc content error', error);
    },
    onException: ({ error }) => {
      setStatus('运行异常');
      report(`SuperDoc exception: ${error?.message ?? error}`);
      console.error('SuperDoc exception', error);
    },
  });
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) mount(file);
});

exportButton.addEventListener('click', async () => {
  exportButton.disabled = true;
  const startedAt = performance.now();
  try {
    const blob = await instance.export({ exportType: ['docx'], exportedName: 'superdoc-spike-edited', triggerDownload: false });
    if (!(blob instanceof Blob) || blob.size === 0) throw new Error('export did not return a non-empty DOCX Blob');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'superdoc-spike-edited.docx';
    link.click();
    URL.revokeObjectURL(url);
    report(`导出成功 · ${blob.size} bytes · ${Math.round(performance.now() - startedAt)}ms`);
  } catch (error) {
    report(`导出失败：${error?.message ?? error}`);
    console.error('SuperDoc export error', error);
  } finally {
    exportButton.disabled = false;
  }
});

captureButton.addEventListener('click', async () => {
  const page = editor.querySelector('[data-page-number="1"], .superdoc-page, .page');
  if (!page) {
    report('未发现稳定的公开 page boundary；当前 DOM 探测未找到页面元素。');
    return;
  }
  report(`发现页面候选元素：${page.tagName.toLowerCase()}，class=${page.className || '(none)'}；该 selector 仅用于 Spike 探测。`);
  console.info('SuperDoc page capture candidate', { tag: page.tagName, className: page.className, rect: page.getBoundingClientRect().toJSON() });
});

setStatus('请选择或加载真实 DOCX');

const fixture = new URLSearchParams(location.search).get('fixture');
if (fixture) mount(`/fixtures/${encodeURIComponent(fixture)}`);

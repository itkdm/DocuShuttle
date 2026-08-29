import { SuperDoc } from 'superdoc';
import { toBlob } from 'html-to-image';
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

const pageElement = (pageNumber) =>
  editor.querySelector(`[data-page-number="${pageNumber}"]`);

async function capturePage(pageNumber) {
  const page = pageElement(pageNumber);
  if (!page) throw new Error(`page ${pageNumber} was not found`);
  const images = [...page.querySelectorAll('img')];
  const originalSources = images.map((image) => image.getAttribute('src'));
  try {
    await Promise.all(images.map(async (image) => {
      const source = image.getAttribute('src');
      if (!source || source.startsWith('data:')) return;
      const response = await fetch(source);
      if (!response.ok) throw new Error(`could not read image resource (${response.status})`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const contentType = response.headers.get('content-type') || 'image/png';
      image.setAttribute('src', `data:${contentType};base64,${btoa(binary)}`);
    }));
    const blob = await toBlob(page, {
      backgroundColor: '#ffffff',
      cacheBust: true,
      pixelRatio: 1,
    });
    if (!(blob instanceof Blob) || blob.size === 0 || blob.type !== 'image/png') {
      throw new Error('page capture did not produce a non-empty PNG Blob');
    }
    return blob;
  } finally {
    images.forEach((image, index) => {
      const source = originalSources[index];
      if (source === null) image.removeAttribute('src');
      else image.setAttribute('src', source);
    });
  }
}

window.__superdocSpike = { capturePage };

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
  captureButton.disabled = true;
  try {
    const pageNumbers = [...editor.querySelectorAll('[data-page-number]')]
      .map((element) => Number(element.getAttribute('data-page-number')))
      .filter(Number.isInteger);
    const middlePage = pageNumbers[Math.floor(pageNumbers.length / 2)] ?? pageNumbers[0];
    const captures = [];
    for (const pageNumber of [...new Set([pageNumbers[0], middlePage])]) {
      const blob = await capturePage(pageNumber);
      window.__superdocSpike[`page${pageNumber}`] = blob;
      captures.push(`page ${pageNumber}: ${blob.size} bytes ${blob.type}`);
    }
    report(`JS PNG capture 成功（非 DevTools）：${captures.join('；')}`);
    console.info('SuperDoc programmatic page capture completed', captures);
  } catch (error) {
    report(`JS PNG capture 失败：${error?.message ?? error}`);
    console.error('SuperDoc programmatic page capture error', error);
  } finally {
    captureButton.disabled = false;
  }
});

setStatus('请选择或加载真实 DOCX');

const fixture = new URLSearchParams(location.search).get('fixture');
if (fixture) mount(`/fixtures/${encodeURIComponent(fixture)}`);

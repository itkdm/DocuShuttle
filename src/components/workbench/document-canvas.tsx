import { AlertCircle, FileUp, LoaderCircle, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from "react";
import type { DocumentLoadState } from "./types";
import type { DocumentEditorPort, DocumentEditorState, DocumentSurfacePort } from "@/modules/documents";
import { DocxPreviewDocumentSurface } from "./docx-preview-document-surface";
import { SuperDocDocumentEditor, SuperDocDocumentSurface } from "./superdoc-document-editor";
import { SuperDocDocumentViewer } from "./superdoc-document-viewer";
import { resolveDocumentSurfacePreference, type DocumentSurfacePreference } from "./document-surface-preference";
import { createReadOnlyPreviewProjection } from "@/modules/documents/infrastructure/ooxml/preview-projection";

interface DocumentCanvasProps {
  taskId?: string;
  loadState: DocumentLoadState;
  onChoose: (file?: File) => void;
  onSurfaceReady?: (surface: DocumentSurfacePort | undefined) => void;
  editing?: boolean;
  editorState?: DocumentEditorState;
  editorRef?: MutableRefObject<DocumentEditorPort | undefined>;
  onEdit?: () => void;
  onSave?: () => void;
  onDiscard?: () => void;
  onEditorStateChange?: (state: DocumentEditorState) => void;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function DocxRenderer({ bytes, revision, taskId, onError, surfaceRef, onSurfaceReady }: { bytes: ArrayBuffer; revision?: string; taskId?: string; onError: (message: string) => void; surfaceRef?: MutableRefObject<DocumentSurfacePort | undefined>; onSurfaceReady?: (surface: DocumentSurfacePort | undefined) => void }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    let active = true;
    const body = bodyRef.current;
    const styles = styleRef.current;
    if (!body || !styles) return;
    body.replaceChildren();
    styles.replaceChildren();
    setRendering(true);
    const surfaceStartedAt = performance.now();
    recordSurfaceEvent("document.surface.mount.started", { engine: "docx-preview", taskId, revision, bytes: bytes.byteLength });
    const renderStarted = performance.now();
    void createReadOnlyPreviewProjection(new Uint8Array(bytes.slice(0)))
      .then(({ bytes: projectedBytes }) => import("docx-preview").then(({ renderAsync }) => renderAsync(asArrayBuffer(projectedBytes), body, styles, {
        className: "paperduck-docx", inWrapper: true, breakPages: true,
        ignoreWidth: false, ignoreHeight: false, ignoreFonts: false,
        useBase64URL: true, renderHeaders: true, renderFooters: true,
      })))
      .then(() => {
        if (active) {
          setRendering(false);
          const surfaceRoot = body.closest<HTMLElement>(".paper-stage") ?? body.parentElement;
          if (surfaceRef && surfaceRoot) surfaceRef.current = new DocxPreviewDocumentSurface(surfaceRoot, { ready: true, renderedRevision: revision, dirty: false, pageCount: 1 });
          recordSurfaceEvent("document.surface.ready", { engine: "docx-preview", taskId, revision, bytes: bytes.byteLength, durationMs: performance.now() - surfaceStartedAt });
          onSurfaceReady?.(surfaceRef?.current);
          if (process.env.NODE_ENV !== "production") void fetch("/api/dev/logs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ event: "client.docx.render.completed", durationMs: performance.now() - renderStarted, bytes: bytes.byteLength }] }), keepalive: true }).catch(() => undefined);
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        recordSurfaceEvent("document.surface.failed", { engine: "docx-preview", taskId, revision, bytes: bytes.byteLength, durationMs: performance.now() - surfaceStartedAt });
        const detail = error instanceof Error ? error.message : "未知渲染错误";
        onError(`DOCX 无法渲染：${detail}`);
      });
    return () => { active = false; if (surfaceRef) surfaceRef.current = undefined; onSurfaceReady?.(undefined); };
  }, [bytes, onError, onSurfaceReady, revision, surfaceRef, taskId]);

  return <><div ref={styleRef} />{rendering && <div className="docx-rendering" role="status"><LoaderCircle size={20} /> 正在排版真实 DOCX…</div>}<div ref={bodyRef} className="docx-preview-host" data-testid="docx-preview" /></>;
}

function SuperDocRenderer({ bytes, revision, onError, surfaceRef, editorRef, onSurfaceReady, onEditorStateChange }: { bytes: ArrayBuffer; revision: string; onError: (message: string) => void; surfaceRef?: MutableRefObject<DocumentSurfacePort | undefined>; editorRef?: MutableRefObject<DocumentEditorPort | undefined>; onSurfaceReady?: (surface: DocumentSurfacePort | undefined) => void; onEditorStateChange?: (state: DocumentEditorState) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    const host = hostRef.current;
    const toolbar = toolbarRef.current;
    if (!host || !toolbar) return;
    host.replaceChildren();
    toolbar.replaceChildren();
    const editorDocument = new Blob([bytes.slice(0)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    void SuperDocDocumentEditor.mount(host, toolbar, editorDocument, revision, {
      onStateChange: onEditorStateChange ?? (() => undefined),
      onError,
    }).then((editor) => {
      if (!active) { editor.destroy(); return; }
      const surface = new SuperDocDocumentSurface(host, editor);
      if (editorRef) editorRef.current = editor;
      if (surfaceRef) surfaceRef.current = surface;
      onSurfaceReady?.(surface);
      onEditorStateChange?.(editor.getState());
    }).catch((error: unknown) => { if (active) onError(error instanceof Error ? error.message : "SuperDoc 编辑器初始化失败"); });
    return () => {
      active = false;
      editorRef?.current?.destroy();
      if (editorRef) editorRef.current = undefined;
      if (surfaceRef) surfaceRef.current = undefined;
      onSurfaceReady?.(undefined);
      host.replaceChildren();
      toolbar.replaceChildren();
    };
  }, [bytes, editorRef, onError, onEditorStateChange, onSurfaceReady, revision, surfaceRef]);

  return <div className="superdoc-editor-shell"><div ref={toolbarRef} className="superdoc-toolbar" data-testid="superdoc-toolbar" /><div ref={hostRef} className="superdoc-editor-host" data-testid="superdoc-editor" /></div>;
}

function recordSurfaceEvent(event: string, payload: { engine: "docx-preview" | "superdoc"; taskId?: string; revision?: string; bytes: number; durationMs?: number }) {
  if (process.env.NODE_ENV === "production") return;
  void fetch("/api/dev/logs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ event, ...payload }] }), keepalive: true }).catch(() => undefined);
}

function SuperDocViewerRenderer({ bytes, revision, taskId, onError, surfaceRef, onSurfaceReady }: { bytes: ArrayBuffer; revision: string; taskId?: string; onError: (message: string) => void; surfaceRef?: MutableRefObject<DocumentSurfacePort | undefined>; onSurfaceReady?: (surface: DocumentSurfacePort | undefined) => void }) {
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    let viewerInstance: SuperDocDocumentViewer | undefined;
    let readyPublished = false;
    const stage = stageRef.current;
    if (!stage) return;
    const surfaceStartedAt = performance.now();
    recordSurfaceEvent("document.surface.mount.started", { engine: "superdoc", taskId, revision, bytes: bytes.byteLength });
    stage.replaceChildren();
    const publishReady = (viewer: SuperDocDocumentViewer) => {
      if (!active || readyPublished || !viewer.getState().ready) return;
      readyPublished = true;
      if (surfaceRef) surfaceRef.current = viewer;
      recordSurfaceEvent("document.surface.ready", { engine: "superdoc", taskId, revision, bytes: bytes.byteLength, durationMs: performance.now() - surfaceStartedAt });
      onSurfaceReady?.(viewer);
    };
    void createReadOnlyPreviewProjection(new Uint8Array(bytes.slice(0)))
      .then(({ bytes: projectedBytes }) => {
        if (!active) return undefined;
        const documentBlob = new Blob([asArrayBuffer(projectedBytes)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
        return SuperDocDocumentViewer.mount(stage, documentBlob, revision, { onReady: () => {
          if (viewerInstance) publishReady(viewerInstance);
        }, onError });
      }).then((viewer) => {
      if (!viewer) return;
      viewerInstance = viewer;
      if (!active) viewer.destroy();
      else publishReady(viewer);
    }).catch((error: unknown) => { recordSurfaceEvent("document.surface.failed", { engine: "superdoc", taskId, revision, bytes: bytes.byteLength, durationMs: performance.now() - surfaceStartedAt }); if (active) onError(error instanceof Error ? error.message : "SuperDoc 查看器初始化失败"); });
    return () => { active = false; viewerInstance?.destroy(); if (surfaceRef) surfaceRef.current = undefined; onSurfaceReady?.(undefined); stage.replaceChildren(); };
  }, [bytes, onError, onSurfaceReady, revision, surfaceRef, taskId]);

  return <div ref={stageRef} className="superdoc-viewer-host" data-testid="superdoc-viewer" />;
}

export function DocumentCanvas({ taskId, loadState, onChoose, surfaceRef, onSurfaceReady, editing = false, editorState, editorRef, onEdit, onSave, onDiscard, onEditorStateChange }: DocumentCanvasProps & { surfaceRef?: MutableRefObject<DocumentSurfacePort | undefined> }) {
  const [renderError, setRenderError] = useState<string | null>(null);
  const surfacePreference = useSyncExternalStore(() => () => undefined, resolveDocumentSurfacePreference, () => "docx-preview" as DocumentSurfacePreference);
  const error = loadState.status === "error" ? loadState.message : renderError;

  return (
    <section className="canvas-shell" aria-label="Working Document 文档画布">
      <div className="canvas-toolbar">
        <div className="preview-state"><i className={loadState.status === "ready" ? "ready" : ""} />{editing ? "正在编辑" : loadState.status === "ready" ? "文档预览" : loadState.status === "loading" ? "正在读取" : "尚未载入文档"}</div>
        {!editing && <div className="canvas-toolbar-actions"><label className="canvas-upload"><input id="canvas-upload-docx" name="docx" type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => onChoose(event.target.files?.[0])} /><FileUp size={14} />{loadState.status === "ready" ? "更换文档" : "选择 DOCX"}</label>{loadState.status === "ready" && <button type="button" className="canvas-edit-button" onClick={onEdit}>编辑</button>}</div>}
        {editing && <div className="canvas-toolbar-actions"><button type="button" className="canvas-discard-button" onClick={onDiscard} disabled={!editorState?.ready}>放弃修改</button><button type="button" className="canvas-save-button" onClick={onSave} disabled={!editorState?.ready || !editorState.dirty}>{editorState?.dirty ? "保存" : "已保存"}</button></div>}
      </div>
      <div className="paper-stage">
        {loadState.status === "empty" && <div className="canvas-empty"><span className="empty-duck">鸭</span><span className="eyebrow">REAL DOCX WORKSPACE</span><h1>把一份真实 Word 放到桌上</h1><p>上传会新建一个任务，地址会变成当前任务。刷新首页保持空白；要继续上次的文档和对话，请从左侧打开历史任务。</p><label><input id="canvas-empty-docx" name="docx" type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => onChoose(event.target.files?.[0])} /><FileUp size={17} /> 打开 .docx</label><small>最大 20 MB · 不支持旧版 .doc</small></div>}
        {loadState.status === "loading" && <div className="canvas-loading" role="status"><LoaderCircle size={26} /><strong>正在检查并打开</strong><span>{loadState.fileName}</span></div>}
        {error && <div className="canvas-error" role="alert"><AlertCircle size={28} /><strong>这份文档暂时打不开</strong><p>{error}</p><label><input id="canvas-retry-docx" name="docx" type="file" accept=".docx" onChange={(event) => onChoose(event.target.files?.[0])} /><RotateCcw size={15} /> 选择其他文件</label></div>}
        {loadState.status === "ready" && !error && editing && <SuperDocRenderer bytes={loadState.document.bytes} revision={loadState.document.revision ?? ""} onError={setRenderError} surfaceRef={surfaceRef} editorRef={editorRef} onSurfaceReady={onSurfaceReady} onEditorStateChange={onEditorStateChange} />}
        {loadState.status === "ready" && !error && !editing && surfacePreference === "superdoc" && <SuperDocViewerRenderer bytes={loadState.document.bytes} revision={loadState.document.revision ?? ""} taskId={taskId} onError={setRenderError} surfaceRef={surfaceRef} onSurfaceReady={onSurfaceReady} />}
        {loadState.status === "ready" && !error && !editing && surfacePreference === "docx-preview" && <div className="real-document-wrap">
          <DocxRenderer bytes={loadState.document.bytes} revision={loadState.document.revision} taskId={taskId} onError={setRenderError} surfaceRef={surfaceRef} onSurfaceReady={onSurfaceReady} />
        </div>}
      </div>
    </section>
  );
}

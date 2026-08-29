import { toBlob } from "html-to-image";
import { defineSuperDocExtension, type SuperDoc, type SuperDocMutationEvent } from "superdoc";
import "superdoc/style.css";

import type { DocumentEditorPort, DocumentEditorState, DocumentSurfacePort, DocumentSurfaceState, DocumentVisibleCapture, ExportedDocument } from "@/modules/documents";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const MAX_DIMENSION = 10_000;

export type SuperDocEditorCallbacks = {
  onStateChange: (state: DocumentEditorState) => void;
  onError: (message: string) => void;
};

function createMutationExtension(onMutation: (event: SuperDocMutationEvent) => void) {
  return defineSuperDocExtension({
    id: "paperduck.manual-edit",
    activate(context) {
      context.onMutation({ origin: "local", sourceComplete: true }, (event) => {
        if (!event.affects.size) return;
        if (process.env.NODE_ENV !== "production") {
          console.info("document.editor.mutation", {
            id: event.id,
            origin: event.origin,
            affects: [...event.affects],
            sourceComplete: context.getSnapshot().sourceComplete,
          });
        }
        onMutation(event);
      });
    },
  });
}

/** Adapter containing all SuperDoc knowledge for the browser integration. */
export class SuperDocDocumentEditor implements DocumentEditorPort {
  private instance: SuperDoc | undefined;
  private state: DocumentEditorState = { ready: false, dirty: false, baseRevision: "" };
  private destroyed = false;

  private constructor(
    private readonly host: HTMLElement,
    private readonly baseRevision: string,
    private readonly callbacks: SuperDocEditorCallbacks,
  ) {
    this.state = { ready: false, dirty: false, baseRevision };
  }

  static async mount(host: HTMLElement, toolbar: HTMLElement, document: Blob, baseRevision: string, callbacks: SuperDocEditorCallbacks) {
    const editor = new SuperDocDocumentEditor(host, baseRevision, callbacks);
    const { SuperDoc: SuperDocConstructor } = await import("superdoc");
    if (editor.destroyed) return editor;
    editor.instance = new SuperDocConstructor({
      selector: host,
      document,
      documentMode: "editing",
      extensions: [createMutationExtension(() => editor.updateState({ dirty: true }))],
      ui: { toolbar: { container: toolbar }, comments: false },
      onReady: () => editor.updateState({ ready: true }),
      onContentError: ({ error }) => editor.reportError(error),
      onException: ({ error }) => editor.reportError(error),
    });
    return editor;
  }

  getState(): DocumentEditorState { return { ...this.state }; }

  async exportDocument(): Promise<ExportedDocument> {
    if (!this.instance || !this.state.ready) throw new Error("DOCUMENT_EDITOR_NOT_READY");
    const blob = await this.instance.export({ exportType: ["docx"], triggerDownload: false });
    if (!(blob instanceof Blob) || blob.type !== DOCX_MIME || blob.size === 0) throw new Error("DOCUMENT_EDITOR_EXPORT_INVALID");
    return { blob, mimeType: DOCX_MIME };
  }

  destroy() {
    this.destroyed = true;
    this.instance?.destroy();
    this.instance = undefined;
    this.host.replaceChildren();
    this.updateState({ ready: false, dirty: false });
  }

  private updateState(update: Partial<DocumentEditorState>) {
    if (this.destroyed) return;
    this.state = { ...this.state, ...update };
    this.callbacks.onStateChange(this.getState());
  }

  private reportError(error: unknown) {
    const message = error instanceof Error ? error.message : "未知编辑器错误";
    this.callbacks.onError(`SuperDoc 编辑器错误：${message}`);
  }
}

/** Surface projection for the editor viewport; it never uses SuperDoc DOM internals. */
export class SuperDocDocumentSurface implements DocumentSurfacePort {
  constructor(private readonly host: HTMLElement, private readonly editor: SuperDocDocumentEditor) {}

  getState(): DocumentSurfaceState {
    const editorState = this.editor.getState();
    return { ready: editorState.ready, dirty: editorState.dirty, renderedRevision: editorState.baseRevision, pageCount: 1 };
  }

  async captureVisible(): Promise<DocumentVisibleCapture> {
    const state = this.getState();
    if (!state.ready || state.dirty) throw new Error(state.dirty ? "DOCUMENT_VIEW_DIRTY" : "DOCUMENT_VIEW_NOT_READY");
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) throw new Error("DOCUMENT_VIEW_CAPTURE_TOO_LARGE");
    const blob = await toBlob(this.host, { backgroundColor: "#ffffff", cacheBust: true, pixelRatio: 1, width, height });
    if (!blob || blob.type !== "image/png" || blob.size === 0) throw new Error("DOCUMENT_VIEW_CAPTURE_FAILED");
    if (blob.size > MAX_CAPTURE_BYTES) throw new Error("DOCUMENT_VIEW_CAPTURE_TOO_LARGE");
    return { blob, mimeType: "image/png", width, height };
  }
}

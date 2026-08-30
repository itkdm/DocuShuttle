import { type SuperDoc } from "superdoc";
import "superdoc/style.css";

import type { DocumentSurfacePort, DocumentSurfaceState, DocumentVisibleCapture } from "@/modules/documents";
import { captureDocumentViewport } from "./capture-document-viewport";

export type SuperDocViewerCallbacks = { onReady: () => void; onError: (message: string) => void };

export class SuperDocDocumentViewer implements DocumentSurfacePort {
  private instance: SuperDoc | undefined;
  private state: DocumentSurfaceState;

  private constructor(private readonly stage: HTMLElement, private readonly revision: string, private readonly callbacks: SuperDocViewerCallbacks) {
    this.state = { ready: false, dirty: false, renderedRevision: revision };
  }

  static async mount(stage: HTMLElement, document: Blob, revision: string, callbacks: SuperDocViewerCallbacks) {
    const viewer = new SuperDocDocumentViewer(stage, revision, callbacks);
    const { SuperDoc: SuperDocConstructor } = await import("superdoc");
    viewer.instance = new SuperDocConstructor({
      selector: stage,
      document,
      documentMode: "viewing",
      role: "viewer",
      ui: false,
      hyperlinks: false,
      viewing: { comments: false, trackedChanges: "original" },
      onReady: () => { viewer.state = { ...viewer.state, ready: true, dirty: false, renderedRevision: revision }; callbacks.onReady(); },
      onContentError: ({ error }) => viewer.fail(error),
      onException: ({ error }) => viewer.fail(error),
    });
    return viewer;
  }

  getState(): DocumentSurfaceState { return { ...this.state }; }

  async captureVisible(): Promise<DocumentVisibleCapture> {
    if (!this.state.ready) throw new Error("DOCUMENT_VIEW_NOT_READY");
    return captureDocumentViewport(this.stage);
  }

  destroy() { this.instance?.destroy(); this.instance = undefined; this.state = { ...this.state, ready: false, dirty: false }; }

  private fail(error: unknown) {
    this.callbacks.onError(`SuperDoc 查看器错误：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

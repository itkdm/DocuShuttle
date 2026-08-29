import { toBlob } from "html-to-image";

import type { DocumentPageCapture, DocumentSurfacePort, DocumentSurfaceState, DocumentVisibleCapture } from "@/modules/documents/application/document-surface-port";

const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const MAX_DIMENSION = 10_000;

export class DocxPreviewDocumentSurface implements DocumentSurfacePort {
  constructor(
    private readonly root: HTMLElement,
    private readonly state: DocumentSurfaceState,
  ) {}

  getState(): DocumentSurfaceState {
    return { ...this.state, pageCount: this.pages().length };
  }

  async capturePage(pageNumber: number): Promise<DocumentPageCapture> {
    if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new Error("DOCUMENT_VIEW_PAGE_INVALID");
    if (!this.state.ready || this.state.dirty) throw new Error(this.state.dirty ? "DOCUMENT_VIEW_DIRTY" : "DOCUMENT_VIEW_NOT_READY");
    const page = this.pages()[pageNumber - 1];
    if (!page) throw new Error("DOCUMENT_VIEW_PAGE_NOT_FOUND");
    if (!this.state.renderedRevision) throw new Error("DOCUMENT_VIEW_REVISION_UNAVAILABLE");
    const originalSources = [...page.querySelectorAll("img")].map((image) => image.getAttribute("src"));
    try {
      await Promise.all([...page.querySelectorAll("img")].map(async (image) => {
        const source = image.getAttribute("src");
        if (!source || source.startsWith("data:")) return;
        const response = await fetch(source);
        if (!response.ok) throw new Error("DOCUMENT_VIEW_CAPTURE_IMAGE_UNREADABLE");
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        image.setAttribute("src", `data:${response.headers.get("content-type") || "image/png"};base64,${btoa(binary)}`);
      }));
      const rect = page.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.width > MAX_DIMENSION || rect.height > MAX_DIMENSION) throw new Error("DOCUMENT_VIEW_CAPTURE_TOO_LARGE");
      const blob = await toBlob(page, { backgroundColor: "#ffffff", cacheBust: true, pixelRatio: 1 });
      if (!blob || blob.type !== "image/png" || blob.size === 0) throw new Error("DOCUMENT_VIEW_CAPTURE_FAILED");
      if (blob.size > MAX_CAPTURE_BYTES) throw new Error("DOCUMENT_VIEW_CAPTURE_TOO_LARGE");
      return { blob, mimeType: "image/png", pageNumber, width: Math.round(rect.width), height: Math.round(rect.height) };
    } finally {
      [...page.querySelectorAll("img")].forEach((image, index) => {
        const source = originalSources[index];
        if (source === null) image.removeAttribute("src"); else image.setAttribute("src", source);
      });
    }
  }

  async captureVisible(): Promise<DocumentVisibleCapture> {
    if (!this.state.ready || this.state.dirty) throw new Error(this.state.dirty ? "DOCUMENT_VIEW_DIRTY" : "DOCUMENT_VIEW_NOT_READY");
    const viewport = this.root.querySelector(".paper-stage");
    if (!viewport) throw new Error("DOCUMENT_VIEW_NOT_READY");
    const visible = this.pages().map((page, index) => ({ page, pageNumber: index + 1, area: this.visibleArea(page, viewport) })).filter((item) => item.area > 0).sort((a, b) => b.area - a.area).slice(0, 2);
    if (!visible.length) throw new Error("DOCUMENT_VIEW_PAGE_NOT_FOUND");
    const captures = [];
    for (const item of visible) captures.push(await this.capturePage(item.pageNumber));
    return captures.length === 1 ? captures[0]! : { captures };
  }

  private pages(): HTMLElement[] {
    const numbered = [...this.root.querySelectorAll<HTMLElement>("[data-page-number]")];
    if (numbered.length) return numbered;
    return [...this.root.querySelectorAll<HTMLElement>(".docx-preview-host .paperduck-docx-wrapper > section, .docx-preview-host .paperduck-docx-wrapper > div")].filter((element) => element.querySelector("table, p, img"));
  }

  private visibleArea(page: HTMLElement, viewport: Element): number {
    const pageRect = page.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const width = Math.max(0, Math.min(pageRect.right, viewportRect.right) - Math.max(pageRect.left, viewportRect.left));
    const height = Math.max(0, Math.min(pageRect.bottom, viewportRect.bottom) - Math.max(pageRect.top, viewportRect.top));
    return width * height;
  }
}

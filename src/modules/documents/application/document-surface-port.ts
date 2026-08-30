export type DocumentSurfaceState = {
  ready: boolean;
  renderedRevision?: string;
  dirty: boolean;
  pageCount?: number;
  currentPage?: number;
};

export type DocumentPageCapture = {
  blob: Blob;
  mimeType: "image/png";
  pageNumber: number;
  width: number;
  height: number;
};

export type DocumentVisibleCapture = {
  blob: Blob;
  mimeType: "image/png";
  width: number;
  height: number;
  pageNumber?: number;
};

export type DocumentScrollCommand =
  | { kind: "relative"; direction: "up" | "down"; amount: "small" | "viewport" }
  | { kind: "edge"; target: "top" | "bottom" };

export type DocumentScrollResult = {
  revision: string;
  beforeScrollTop: number;
  scrollTop: number;
  maxScrollTop: number;
  viewportHeight: number;
  moved: boolean;
  atTop: boolean;
  atBottom: boolean;
};

/** Browser-neutral surface contract; concrete DOM/document engines stay in adapters. */
export interface DocumentSurfacePort {
  getState(): DocumentSurfaceState;
  capturePage?(pageNumber: number): Promise<DocumentPageCapture>;
  captureVisible(): Promise<DocumentVisibleCapture>;
  scrollViewport(command: DocumentScrollCommand, targetScrollTop?: number): Promise<DocumentScrollResult>;
  navigate?(pageNumber: number): Promise<void>;
  setZoom?(zoom: number): Promise<void>;
}

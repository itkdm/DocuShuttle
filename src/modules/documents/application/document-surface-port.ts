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

/** Browser-neutral surface contract; concrete DOM/document engines stay in adapters. */
export interface DocumentSurfacePort {
  getState(): DocumentSurfaceState;
  capturePage?(pageNumber: number): Promise<DocumentPageCapture>;
  captureVisible(): Promise<DocumentVisibleCapture>;
  navigate?(pageNumber: number): Promise<void>;
  setZoom?(zoom: number): Promise<void>;
}

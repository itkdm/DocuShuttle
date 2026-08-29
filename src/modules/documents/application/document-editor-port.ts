export type DocumentEditorState = {
  ready: boolean;
  dirty: boolean;
  baseRevision: string;
};

export type ExportedDocument = {
  blob: Blob;
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
};

/** Browser-neutral editing lifecycle. Concrete editor APIs stay in adapters. */
export interface DocumentEditorPort {
  getState(): DocumentEditorState;
  exportDocument(): Promise<ExportedDocument>;
  destroy(): void;
}

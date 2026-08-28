export interface VersionItem { id: string; label: string; time: string; actor: "你" | "纸上鸭"; versionNumber?: number; current?: boolean; }
export interface UploadAsset { kind: "template" | "example"; name: string; size: string; }
export interface LoadedDocument {
  file: File;
  bytes: ArrayBuffer;
}
export type DocumentLoadState =
  | { status: "empty" }
  | { status: "loading"; fileName: string }
  | { status: "ready"; document: LoadedDocument }
  | { status: "error"; message: string };

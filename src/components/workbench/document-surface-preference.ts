export type DocumentSurfacePreference = "docx-preview" | "superdoc";

export function resolveDocumentSurfacePreference(): DocumentSurfacePreference {
  if (process.env.NODE_ENV === "production") return "docx-preview";
  if (typeof window === "undefined") return "docx-preview";
  return window.localStorage.getItem("paperduck.documentSurface") === "superdoc" ? "superdoc" : "docx-preview";
}

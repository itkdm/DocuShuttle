export type DiagnosticSeverity = "info" | "warning" | "error";

export interface DocumentDiagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  entry?: string;
  address?: string;
  details?: Readonly<Record<string, string | number | boolean>>;
}

export interface PackageEntryManifest {
  path: string;
  size: number;
  sha256: string;
  contentType?: string;
}

export type DocumentNodeKind = "paragraph" | "table-cell" | "image";

/**
 * Provider-neutral logical identity for a semantic document node.
 *
 * `path` is only the address in one revision. Consumers must persist and
 * exchange `nodeId`; the address is resolved again when a revision is opened.
 */
export interface DocumentNodeManifest {
  nodeId: string;
  kind: DocumentNodeKind;
  entry: string;
  path: string;
  fingerprint: string;
}

export interface DocumentManifest {
  revision: string;
  entries: readonly PackageEntryManifest[];
  /** Logical node map persisted beside the package manifest. */
  nodes: readonly DocumentNodeManifest[];
}

interface StableAddressBase {
  /** Logical identity stable across derived revisions. */
  nodeId: string;
  /** Revision at which the address was discovered. */
  sourceRevision: string;
  /** Fingerprint of the addressed semantic object, not of the whole package. */
  fingerprint: string;
  entry: string;
  path: string;
}

export interface ParagraphAddress extends StableAddressBase {
  kind: "paragraph";
  paraId?: string;
}

export interface TableCellAddress extends StableAddressBase {
  kind: "table-cell";
}

export interface ImageAddress extends StableAddressBase {
  kind: "image";
  relationshipId: string;
  mediaEntry: string;
  drawingId?: string;
  /** Number of drawing occurrences that resolve to this physical media part. */
  mediaReferenceCount: number;
}

export type StableDocumentAddress =
  | ParagraphAddress
  | TableCellAddress
  | ImageAddress;

export interface InspectedParagraph {
  address: ParagraphAddress;
  text: string;
}

export interface InspectedTableCell {
  address: TableCellAddress;
  text: string;
}

export interface InspectedImage {
  address: ImageAddress;
  contentType?: string;
  byteLength: number;
}

export interface DocumentInspection {
  manifest: DocumentManifest;
  paragraphs: readonly InspectedParagraph[];
  tableCells: readonly InspectedTableCell[];
  images: readonly InspectedImage[];
  diagnostics: readonly DocumentDiagnostic[];
  capabilities: Readonly<{
    replaceText: true;
    setCellText: true;
    replaceImage: true;
    trackedChanges: false;
  }>;
}

export interface ReplaceTextOperation {
  kind: "replace-text";
  address: ParagraphAddress;
  expectedText: string;
  replacement: string;
}

export interface SetCellTextOperation {
  kind: "set-cell-text";
  address: TableCellAddress;
  expectedText?: string;
  expectedHash?: string;
  text: string;
}

export interface ReplaceImageOperation {
  kind: "replace-image";
  address: ImageAddress;
  expectedHash: string;
  bytes: Uint8Array;
  /** When supplied, it must match the existing part's content type. */
  contentType?: string;
}

export type DocumentMutation =
  | ReplaceTextOperation
  | SetCellTextOperation
  | ReplaceImageOperation;

export interface MutationRequest {
  expectedRevision: string;
  operations: readonly DocumentMutation[];
}

export interface MutationResult {
  bytes: Uint8Array;
  manifest: DocumentManifest;
  changedEntries: readonly string[];
  diagnostics: readonly DocumentDiagnostic[];
}

export class DocumentKernelError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly diagnostics: readonly DocumentDiagnostic[] = [],
  ) {
    super(message);
    this.name = "DocumentKernelError";
  }
}

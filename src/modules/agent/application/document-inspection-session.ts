import type { DocumentEnginePort } from "@/modules/documents/application/document-engine-port";
import type { DocumentInspection } from "@/modules/documents/domain/types";
import { blockingPackageErrors } from "@/modules/documents/infrastructure/ooxml/diagnostic-policy";
import type { WorkingDocumentAccessPort } from "./document-tools";

export class WorkingDocumentInspectionSession {
  private cached?: { bytes: Uint8Array; inspection: DocumentInspection; revision: string };
  constructor(private readonly documents: DocumentEnginePort, private readonly working: WorkingDocumentAccessPort, private readonly onEvent?: (event: { event: string; metadata: Record<string, unknown> }) => void) {}
  async inspect(): Promise<{ bytes: Uint8Array; inspection: DocumentInspection }> {
    if (this.cached) { this.onEvent?.({ event: "document.inspect.completed", metadata: { cacheHit: true, revision: this.cached.revision, paragraphCount: this.cached.inspection.paragraphs.length, tableCellCount: this.cached.inspection.tableCells.length, imageCount: this.cached.inspection.images.length } }); return { bytes: this.cached.bytes, inspection: this.cached.inspection }; }
    const started = performance.now(); const current = await this.working.load(); const inspection = await this.documents.inspect(current.bytes);
    if (inspection.manifest.revision !== current.revision) throw new Error("WORKING_DOCUMENT_REVISION_MISMATCH");
    if (blockingPackageErrors(inspection.diagnostics).length) throw new Error("WORKING_DOCUMENT_INSPECTION_FAILED");
    this.cached = { bytes: current.bytes, inspection, revision: current.revision }; this.onEvent?.({ event: "document.inspect.completed", metadata: { cacheHit: false, revision: current.revision, durationMs: performance.now() - started, paragraphCount: inspection.paragraphs.length, tableCellCount: inspection.tableCells.length, imageCount: inspection.images.length } }); return { bytes: current.bytes, inspection };
  }
  invalidate() { this.cached = undefined; }
}

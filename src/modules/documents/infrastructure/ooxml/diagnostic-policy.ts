import type { DocumentDiagnostic } from "../../domain/types";

/**
 * Constructs the V1 kernel cannot safely address or mutate.
 * These must not block opening or preserving a package; they only lock writes
 * to the affected regions.
 */
const CAPABILITY_CODES = new Set([
  "NESTED_TABLE_UNSUPPORTED",
  "COMPLEX_CONTENT_UNSUPPORTED",
  "FIELD_PRESENT",
  "REVISION_PRESENT",
  "CONTENT_CONTROL_PRESENT",
  "BOOKMARK_PRESENT",
  "SIGNED_PACKAGE_GUARDED",
]);

export function isCapabilityDiagnostic(diagnostic: DocumentDiagnostic): boolean {
  return CAPABILITY_CODES.has(diagnostic.code);
}

/** Package is not a trustworthy OOXML document. Upload and mutation both refuse. */
export function isBlockingPackageError(diagnostic: DocumentDiagnostic): boolean {
  return diagnostic.severity === "error" && !isCapabilityDiagnostic(diagnostic);
}

export function blockingPackageErrors(diagnostics: readonly DocumentDiagnostic[]): DocumentDiagnostic[] {
  return diagnostics.filter(isBlockingPackageError);
}

import JSZip from "jszip";

import type { DocumentEnginePort } from "../../application/document-engine-port";
import {
  DocumentKernelError,
  type DocumentInspection,
  type DocumentManifest,
  type DocumentNodeManifest,
  type DocumentMutation,
  type MutationRequest,
  type MutationResult,
} from "../../domain/types";
import { sha256, utf8 } from "./hash";
import {
  indexDocument,
  type DocumentIndex,
  type IndexedCell,
  type IndexedImage,
  type IndexedParagraph,
} from "./inspector";
import { blockingPackageErrors } from "./diagnostic-policy";
import { loadPackage, type LoadedPackage } from "./package-model";
import { assertSupportedImage } from "./media";
import {
  decodeXml,
  replaceRange,
  setElementText,
  setTextNodeText,
  textNodes,
} from "./xml";
import { capabilitiesFor } from "./capability-registry";

interface EntryPatch {
  start: number;
  end: number;
  replacement: string;
  operation: DocumentMutation;
}

function inspection(
  loaded: LoadedPackage,
  index: DocumentIndex,
): DocumentInspection {
  const manifest = manifestWithNodes(loaded.manifest, index);
  return {
    manifest,
    paragraphs: index.paragraphs.map(({ address, text }) => ({ address, text })),
    tableCells: index.cells.map(({ address, text }) => ({ address, text })),
    images: index.images.map(({ address, contentType, byteLength }) => ({
      address,
      contentType,
      byteLength,
    })),
    diagnostics: [...loaded.diagnostics, ...index.diagnostics],
    capabilities: {
      replaceText: true,
      setCellText: true,
      replaceImage: true,
      trackedChanges: false,
    },
  };
}

function manifestWithNodes(
  manifest: DocumentManifest,
  index: DocumentIndex,
): DocumentManifest {
  const nodes: DocumentNodeManifest[] = [
    ...index.paragraphs.map(({ address }) => ({
      nodeId: address.nodeId,
      kind: address.kind,
      entry: address.entry,
      path: address.path,
      fingerprint: address.fingerprint,
      capabilities: address.capabilities ?? capabilitiesFor(address.kind),
    })),
    ...index.cells.map(({ address }) => ({
      nodeId: address.nodeId,
      kind: address.kind,
      entry: address.entry,
      path: address.path,
      fingerprint: address.fingerprint,
    })),
    ...index.images.map(({ address }) => ({
      nodeId: address.nodeId,
      kind: address.kind,
      entry: address.entry,
      path: address.path,
      fingerprint: address.fingerprint,
    })),
  ];
  return { ...manifest, nodes };
}

function addressMatches(
  indexed: IndexedParagraph | IndexedCell | IndexedImage,
  operation: DocumentMutation,
): boolean {
  const expected = operation.address;
  const actual = indexed.address;
  if (actual.kind !== expected.kind || actual.entry !== expected.entry) return false;
  if (actual.nodeId !== expected.nodeId) return false;
  if (actual.kind === "paragraph" && expected.kind === "paragraph" && expected.paraId) {
    return actual.paraId === expected.paraId;
  }
  if (actual.kind === "image" && expected.kind === "image") {
    return actual.relationshipId === expected.relationshipId && actual.mediaEntry === expected.mediaEntry;
  }
  return actual.path === expected.path;
}

function ensureAddressPrecondition(
  indexed: IndexedParagraph | IndexedCell | IndexedImage,
  operation: DocumentMutation,
): void {
  if (indexed.address.fingerprint !== operation.address.fingerprint) {
    throw new DocumentKernelError(
      "ADDRESS_PRECONDITION_FAILED",
      `The target at ${operation.address.path} no longer has the inspected fingerprint.`,
    );
  }
}

function assertSafeTextContainer(xml: string): void {
  const unsafe = [
    /<w:fld(?:Simple|Char)\b/,
    /<w:(?:ins|del|moveFrom|moveTo)\b/,
    /<w:sdt\b/,
    /<w:(?:txbxContent|altChunk|object)\b/,
  ];
  if (unsafe.some((pattern) => pattern.test(xml))) {
    throw new DocumentKernelError(
      "UNSUPPORTED_TEXT_CONTAINER",
      "V1 refuses text mutation inside fields, tracked revisions, or content controls.",
    );
  }
}

function assertPlainTextValue(value: string): void {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new DocumentKernelError(
      "TEXT_CONTROL_UNSUPPORTED",
      "V1 plain-text mutations do not accept tabs, line breaks, or control characters.",
    );
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function textPatch(target: IndexedParagraph, operation: Extract<DocumentMutation, { kind: "replace-text" }>): EntryPatch {
  assertSafeTextContainer(target.range.xml);
  assertPlainTextValue(operation.replacement);
  if (operation.expectedText.length === 0) {
    throw new DocumentKernelError("EMPTY_TEXT_PRECONDITION", "replaceText requires a non-empty expectedText.");
  }
  const nodes = textNodes(target.range.xml);
  const decoded = nodes.map((node) => decodeXml(node.xml));
  const combined = decoded.join("");
  const first = combined.indexOf(operation.expectedText);
  if (first < 0 || combined.indexOf(operation.expectedText, first + 1) >= 0) {
    throw new DocumentKernelError(
      "TEXT_PRECONDITION_FAILED",
      "Expected text must occur exactly once in the addressed paragraph.",
    );
  }
  let cursor = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const nodeStart = cursor;
    const nodeEnd = cursor + decoded[index].length;
    const selectionEnd = first + operation.expectedText.length;
    if (first >= nodeStart && selectionEnd <= nodeEnd) {
      const localStart = first - nodeStart;
      const localEnd = selectionEnd - nodeStart;
      const replacementText =
        decoded[index].slice(0, localStart) + operation.replacement + decoded[index].slice(localEnd);
      const node = nodes[index];
      const replacementNode = setTextNodeText(target.range.xml, node, replacementText);
      return {
        start: target.range.start,
        end: target.range.end,
        replacement: replacementNode,
        operation,
      };
    }
    cursor = nodeEnd;
  }
  throw new DocumentKernelError(
    "UNSAFE_CROSS_RUN_EDIT",
    "The requested text spans formatted runs; V1 refuses to move text across run boundaries.",
  );
}

function cellPatch(target: IndexedCell, operation: Extract<DocumentMutation, { kind: "set-cell-text" }>): EntryPatch {
  assertSafeTextContainer(target.range.xml);
  if (/<w:tbl\b/u.test(target.range.xml)) {
    throw new DocumentKernelError(
      "NESTED_TABLE_CONTAINER_UNSUPPORTED",
      "The selected cell contains a nested table; address an inner cell instead of replacing the container text.",
    );
  }
  assertPlainTextValue(operation.text);
  if (operation.expectedText !== undefined && target.text !== operation.expectedText) {
    throw new DocumentKernelError(
      "CELL_TEXT_PRECONDITION_FAILED",
      "The table cell text differs from expectedText.",
    );
  }
  if (operation.expectedHash !== undefined && target.address.fingerprint !== operation.expectedHash) {
    throw new DocumentKernelError(
      "CELL_HASH_PRECONDITION_FAILED",
      "The table cell fingerprint differs from expectedHash.",
    );
  }
  return {
    start: target.range.start,
    end: target.range.end,
    replacement: setElementText(target.range.xml, operation.text),
    operation,
  };
}

async function assertUntouchedEntries(
  before: LoadedPackage,
  after: LoadedPackage,
  changedEntries: ReadonlySet<string>,
): Promise<void> {
  for (const [path, bytes] of before.entries) {
    if (changedEntries.has(path)) continue;
    const output = after.entries.get(path);
    if (!output || (await sha256(output)) !== (await sha256(bytes))) {
      throw new DocumentKernelError(
        "UNTOUCHED_ENTRY_CHANGED",
        `Exporter changed untouched package entry ${path}.`,
      );
    }
  }
  for (const path of after.entries.keys()) {
    if (!before.entries.has(path)) {
      throw new DocumentKernelError(
        "UNEXPECTED_ENTRY_ADDED",
        `Exporter added unexpected package entry ${path}.`,
      );
    }
  }
}

async function verifyMutationOutcomes(
  before: DocumentIndex,
  after: DocumentIndex,
  operations: readonly DocumentMutation[],
): Promise<void> {
  for (const operation of operations) {
    if (operation.kind === "replace-text") {
      const source = before.paragraphs.find((candidate) => addressMatches(candidate, operation));
      const output = after.paragraphs.find((candidate) => addressMatches(candidate, operation));
      const expected = source?.text.replace(operation.expectedText, operation.replacement);
      if (!source || !output || output.text !== expected) {
        throw new DocumentKernelError(
          "TARGET_SEMANTIC_MISMATCH",
          "Exported paragraph does not contain the requested semantic result.",
        );
      }
    } else if (operation.kind === "set-cell-text") {
      const output = after.cells.find((candidate) => addressMatches(candidate, operation));
      if (!output || output.text !== operation.text) {
        throw new DocumentKernelError(
          "TARGET_SEMANTIC_MISMATCH",
          "Exported table cell does not contain the requested semantic result.",
        );
      }
    } else {
      const output = after.images.find((candidate) => addressMatches(candidate, operation));
      if (!output || output.address.fingerprint !== (await sha256(operation.bytes))) {
        throw new DocumentKernelError(
          "TARGET_SEMANTIC_MISMATCH",
          "Exported image does not contain the requested bytes.",
        );
      }
    }
  }
}

export class OoxmlPreservationKernel implements DocumentEnginePort {
  async inspect(bytes: Uint8Array): Promise<DocumentInspection> {
    const loaded = await loadPackage(bytes);
    const indexed = await indexDocument(loaded);
    return inspection(loaded, indexed);
  }

  async validate(bytes: Uint8Array): Promise<DocumentInspection> {
    return this.inspect(bytes);
  }

  async mutate(bytes: Uint8Array, request: MutationRequest): Promise<MutationResult> {
    const loaded = await loadPackage(bytes);
    const indexed = await indexDocument(loaded);
    const sourceDiagnostics = [...loaded.diagnostics, ...indexed.diagnostics];
    const blocking = blockingPackageErrors(sourceDiagnostics);
    if (blocking.length > 0) {
      throw new DocumentKernelError(
        "SOURCE_PACKAGE_INVALID",
        "Refusing to mutate an invalid OOXML package.",
        blocking,
      );
    }
    if (loaded.manifest.revision !== request.expectedRevision) {
      throw new DocumentKernelError(
        "REVISION_PRECONDITION_FAILED",
        "The source package revision differs from expectedRevision.",
      );
    }
    if (request.operations.length === 0) {
      return {
        bytes: Uint8Array.from(bytes),
        manifest: manifestWithNodes(loaded.manifest, indexed),
        changedEntries: [],
        diagnostics: [{
          severity: "info",
          code: "NO_OP_PRESERVED",
          message: "No operations were requested; the original package bytes were returned exactly.",
        }],
      };
    }

    const patches = new Map<string, EntryPatch[]>();
    const binaryChanges = new Map<string, Uint8Array>();
    for (const operation of request.operations) {
      if (operation.address.sourceRevision !== request.expectedRevision) {
        throw new DocumentKernelError(
          "ADDRESS_REVISION_MISMATCH",
          "Operation address belongs to a different source revision.",
        );
      }
      if (operation.kind === "replace-text") {
        const target = indexed.paragraphs.find((candidate) => addressMatches(candidate, operation));
        if (!target) throw new DocumentKernelError("ADDRESS_NOT_FOUND", "Paragraph address was not found.");
        ensureAddressPrecondition(target, operation);
        const entryPatches = patches.get(target.address.entry) ?? [];
        entryPatches.push(textPatch(target, operation));
        patches.set(target.address.entry, entryPatches);
      } else if (operation.kind === "set-cell-text") {
        const target = indexed.cells.find((candidate) => addressMatches(candidate, operation));
        if (!target) throw new DocumentKernelError("ADDRESS_NOT_FOUND", "Table cell address was not found.");
        ensureAddressPrecondition(target, operation);
        const entryPatches = patches.get(target.address.entry) ?? [];
        entryPatches.push(cellPatch(target, operation));
        patches.set(target.address.entry, entryPatches);
      } else {
        const target = indexed.images.find((candidate) => addressMatches(candidate, operation));
        if (!target) throw new DocumentKernelError("ADDRESS_NOT_FOUND", "Image address was not found.");
        ensureAddressPrecondition(target, operation);
        if (operation.expectedHash !== target.address.fingerprint) {
          throw new DocumentKernelError("IMAGE_HASH_PRECONDITION_FAILED", "Image hash differs from expectedHash.");
        }
        if (target.address.mediaReferenceCount > 1) {
          throw new DocumentKernelError(
            "SHARED_MEDIA_PART_UNSUPPORTED",
            "The selected image part is shared by multiple drawings; V1 refuses a fan-out replacement.",
          );
        }
        if (operation.contentType && operation.contentType !== target.contentType) {
          throw new DocumentKernelError(
            "IMAGE_CONTENT_TYPE_CHANGE_UNSUPPORTED",
            "V1 only replaces an image with the existing package part content type.",
          );
        }
        assertSupportedImage(operation.bytes, target.contentType);
        if (binaryChanges.has(target.address.mediaEntry)) {
          throw new DocumentKernelError("OVERLAPPING_OPERATIONS", "Multiple operations target the same image part.");
        }
        binaryChanges.set(target.address.mediaEntry, Uint8Array.from(operation.bytes));
      }
    }

    const stagedText = new Map<string, string>();
    const decoder = new TextDecoder();
    for (const [entry, entryPatches] of patches) {
      const sorted = [...entryPatches].sort((left, right) => right.start - left.start);
      for (let index = 1; index < sorted.length; index += 1) {
        if (sorted[index - 1].start < sorted[index].end) {
          throw new DocumentKernelError("OVERLAPPING_OPERATIONS", "Atomic operations overlap in one XML part.");
        }
      }
      let xml = decoder.decode(loaded.entries.get(entry));
      for (const patch of sorted) {
        xml = replaceRange(xml, patch.start, patch.end, patch.replacement);
      }
      const originalXml = decoder.decode(loaded.entries.get(entry));
      if (xml !== originalXml) stagedText.set(entry, xml);
    }

    const stagedBinary = new Map<string, Uint8Array>();
    for (const [entry, replacement] of binaryChanges) {
      const original = loaded.entries.get(entry);
      if (!original || !bytesEqual(original, replacement)) stagedBinary.set(entry, replacement);
    }

    if (stagedText.size === 0 && stagedBinary.size === 0) {
      return {
        bytes: Uint8Array.from(bytes),
        manifest: manifestWithNodes(loaded.manifest, indexed),
        changedEntries: [],
        diagnostics: [{
          severity: "info",
          code: "NO_OP_PRESERVED",
          message: "Requested operations produced no package change; original bytes were returned exactly.",
        }],
      };
    }

    const zip = await JSZip.loadAsync(bytes);
    for (const [entry, xml] of stagedText) zip.file(entry, utf8(xml));
    for (const [entry, replacement] of stagedBinary) zip.file(entry, replacement);
    const output = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    const changedEntries = new Set([...stagedText.keys(), ...stagedBinary.keys()]);
    const validated = await loadPackage(output);
    const blockingOutput = blockingPackageErrors(validated.diagnostics);
    if (blockingOutput.length > 0) {
      throw new DocumentKernelError(
        "OUTPUT_PACKAGE_INVALID",
        "Mutation produced an invalid OOXML package.",
        blockingOutput,
      );
    }
    await assertUntouchedEntries(loaded, validated, changedEntries);
    const validatedIndex = await indexDocument(validated);
    await verifyMutationOutcomes(indexed, validatedIndex, request.operations);
    return {
      bytes: output,
      manifest: manifestWithNodes(validated.manifest, validatedIndex),
      changedEntries: [...changedEntries].sort(),
      diagnostics: [
        ...validated.diagnostics,
        {
          severity: "info",
          code: "MUTATION_APPLIED",
          message: `${request.operations.length} atomic operation(s) applied.`,
          details: { changedEntryCount: changedEntries.size },
        },
      ],
    };
  }
}

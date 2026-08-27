import JSZip from "jszip";

import type {
  DocumentDiagnostic,
  DocumentManifest,
  PackageEntryManifest,
} from "../../domain/types";
import { sha256 } from "./hash";
import { assertLoadedEntryPath, preflightZipPackage } from "./package-security";
import { attributes, validateXml } from "./xml";
import { relationshipBase, relationshipSource, resolveRelationshipTarget } from "./relationship-utils";
import { buildOpcPackageGraph, type OpcPackageGraph } from "./opc-graph";

export interface LoadedPackage {
  originalBytes: Uint8Array;
  zip: JSZip;
  entries: ReadonlyMap<string, Uint8Array>;
  manifest: DocumentManifest;
  contentTypes: ReadonlyMap<string, string>;
  diagnostics: readonly DocumentDiagnostic[];
  graph: OpcPackageGraph;
}

function parseContentTypes(xml: string): Map<string, string> {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const match of xml.matchAll(/<(?:\w+:)?Default\b[^>]*\/?\s*>/g)) {
    const attrs = attributes(match[0]);
    if (attrs.Extension && attrs.ContentType) {
      defaults.set(attrs.Extension.toLowerCase(), attrs.ContentType);
    }
  }
  for (const match of xml.matchAll(/<(?:\w+:)?Override\b[^>]*\/?\s*>/g)) {
    const attrs = attributes(match[0]);
    if (attrs.PartName && attrs.ContentType) {
      overrides.set(attrs.PartName.replace(/^\//, ""), attrs.ContentType);
    }
  }
  for (const [path] of overrides) defaults.delete(path);
  return new Map([...defaults, ...overrides]);
}

function contentTypeFor(
  path: string,
  contentTypes: ReadonlyMap<string, string>,
): string | undefined {
  const override = contentTypes.get(path);
  if (override) return override;
  const extension = path.includes(".") ? path.split(".").pop()?.toLowerCase() : undefined;
  return extension ? contentTypes.get(extension) : undefined;
}

function validateRelationships(
  entries: ReadonlyMap<string, Uint8Array>,
  texts: ReadonlyMap<string, string>,
): DocumentDiagnostic[] {
  const diagnostics: DocumentDiagnostic[] = [];
  let officeDocumentRelationshipFound = false;
  for (const [path, xml] of texts) {
    if (!path.endsWith(".rels")) continue;
    const base = relationshipBase(path);
    if (base === undefined) {
      diagnostics.push({
        severity: "warning",
        code: "RELATIONSHIP_SOURCE_UNKNOWN",
        message: "Relationship part is not in a recognized OOXML location.",
        entry: path,
      });
      continue;
    }
    const source = relationshipSource(path);
    if (path !== "_rels/.rels" && (!source || !entries.has(source))) {
      diagnostics.push({
        severity: "error",
        code: "RELATIONSHIP_SOURCE_MISSING",
        message: "Relationship part has no corresponding source package part.",
        entry: path,
      });
    }
    const ids = new Set<string>();
    for (const match of xml.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/?\s*>/g)) {
      const attrs = attributes(match[0]);
      if (!attrs.Id || !attrs.Target || !attrs.Type) {
        diagnostics.push({
          severity: "error",
          code: "RELATIONSHIP_INVALID",
          message: "Relationship is missing Id or Target.",
          entry: path,
        });
        continue;
      }
      if (ids.has(attrs.Id)) {
        diagnostics.push({
          severity: "error",
          code: "RELATIONSHIP_ID_DUPLICATE",
          message: `Relationship Id ${attrs.Id} is duplicated in one relationship part.`,
          entry: path,
          details: { relationshipId: attrs.Id },
        });
        continue;
      }
      ids.add(attrs.Id);
      // External targets are valid OPC, but they are not package parts and
      // must never be silently treated as local data. Hyperlinks are retained
      // as inert metadata; every other external relationship is rejected at
      // the upload boundary so later consumers cannot fetch an untrusted URL.
      if (attrs.TargetMode?.toLowerCase() === "external") {
        diagnostics.push({
          severity: attrs.Type?.toLowerCase().endsWith("/hyperlink") ? "warning" : "error",
          code: "RELATIONSHIP_EXTERNAL_TARGET",
          message: `Relationship ${attrs.Id} targets an external resource and is not fetched by PaperDuck.`,
          entry: path,
          details: {
            relationshipId: attrs.Id,
            target: attrs.Target,
            type: attrs.Type,
            source: source ?? "package",
          },
        });
        continue;
      }
      const target = resolveRelationshipTarget(path, attrs.Target);
      if (!target || !entries.has(target)) {
        diagnostics.push({
          severity: "error",
          code: "RELATIONSHIP_TARGET_MISSING",
          message: `Relationship ${attrs.Id} targets a missing package part.`,
          entry: path,
          details: { relationshipId: attrs.Id, target: attrs.Target },
        });
      }
      if (
        path === "_rels/.rels" &&
        attrs.Type.endsWith("/officeDocument") &&
        target === "word/document.xml"
      ) {
        officeDocumentRelationshipFound = true;
      }
    }
  }
  if (!officeDocumentRelationshipFound) {
    diagnostics.push({
      severity: "error",
      code: "OFFICE_DOCUMENT_RELATIONSHIP_MISSING",
      message: "Root relationships do not identify word/document.xml as the office document.",
      entry: "_rels/.rels",
    });
  }
  return diagnostics;
}

/**
 * Macro-enabled OOXML is deliberately outside the V1 product scope.  Detect
 * it from both package parts and declarations/relationships: relying only on
 * the filename or MIME type would allow a renamed .docm (or a hand-crafted
 * package) to reach the editor.
 */
function detectMacroDiagnostics(
  entries: ReadonlyMap<string, Uint8Array>,
  texts: ReadonlyMap<string, string>,
): DocumentDiagnostic[] {
  const diagnostics: DocumentDiagnostic[] = [];
  for (const path of entries.keys()) {
    if (/(^|\/)vba(?:project|data)\.(?:bin|xml)$/i.test(path)) {
      diagnostics.push({
        severity: "error",
        code: "MACRO_CONTENT_UNSUPPORTED",
        message: "Macro/VBA content is not accepted by the V1 DOCX editor.",
        entry: path,
      });
    }
  }

  const contentTypes = texts.get("[Content_Types].xml") ?? "";
  if (/macroEnabled|vbaProject/i.test(contentTypes)) {
    diagnostics.push({
      severity: "error",
      code: "MACRO_CONTENT_UNSUPPORTED",
      message: "The package declares macro-enabled OOXML content, which V1 does not execute or preserve.",
      entry: "[Content_Types].xml",
    });
  }

  for (const [path, xml] of texts) {
    if (!path.endsWith(".rels")) continue;
    for (const match of xml.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/?\s*>/g)) {
      const attrs = attributes(match[0]);
      if (/\/vbaProject$/i.test(attrs.Type ?? "")) {
        diagnostics.push({
          severity: "error",
          code: "MACRO_CONTENT_UNSUPPORTED",
          message: "The package contains a VBA project relationship, which V1 does not execute or preserve.",
          entry: path,
          details: {
            relationshipId: attrs.Id ?? "unknown",
            target: attrs.Target ?? "unknown",
          },
        });
      }
    }
  }
  return diagnostics;
}

export async function loadPackage(bytes: Uint8Array): Promise<LoadedPackage> {
  preflightZipPackage(bytes);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  } catch (error) {
    throw new Error(`Invalid DOCX ZIP package: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  const entries = new Map<string, Uint8Array>();
  for (const entry of Object.values(zip.files)) {
    assertLoadedEntryPath(entry.unsafeOriginalName, entry.name);
    if (!entry.dir) entries.set(entry.name, await entry.async("uint8array"));
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const texts = new Map<string, string>();
  const diagnostics: DocumentDiagnostic[] = [];
  for (const [path, entryBytes] of entries) {
    if (!path.endsWith(".xml") && !path.endsWith(".rels")) continue;
    try {
      const text = decoder.decode(entryBytes);
      texts.set(path, text);
      const validity = validateXml(text);
      if (validity !== true) {
        diagnostics.push({
          severity: "error",
          code: "XML_INVALID",
          message: validity,
          entry: path,
        });
      }
    } catch {
      diagnostics.push({
        severity: "error",
        code: "XML_NOT_UTF8",
        message: "OOXML XML part is not valid UTF-8.",
        entry: path,
      });
    }
  }

  if (!entries.has("[Content_Types].xml")) {
    diagnostics.push({
      severity: "error",
      code: "CONTENT_TYPES_MISSING",
      message: "The package has no [Content_Types].xml part.",
    });
  }
  if (!entries.has("_rels/.rels")) {
    diagnostics.push({
      severity: "error",
      code: "ROOT_RELATIONSHIPS_MISSING",
      message: "The package has no root relationships part.",
    });
  }
  if (!entries.has("word/document.xml")) {
    diagnostics.push({
      severity: "error",
      code: "MAIN_DOCUMENT_MISSING",
      message: "The package has no word/document.xml part.",
    });
  }

  diagnostics.push(...validateRelationships(entries, texts));
  diagnostics.push(...detectMacroDiagnostics(entries, texts));
  const contentTypes = parseContentTypes(texts.get("[Content_Types].xml") ?? "");
  for (const path of entries.keys()) {
    if (path === "[Content_Types].xml") continue;
    if (!contentTypeFor(path, contentTypes)) {
      diagnostics.push({
        severity: "error",
        code: "CONTENT_TYPE_MISSING",
        message: "Package part has no matching content type declaration.",
        entry: path,
      });
    }
  }
  const manifestEntries: PackageEntryManifest[] = await Promise.all(
    [...entries].map(async ([path, entryBytes]) => ({
      path,
      size: entryBytes.byteLength,
      sha256: await sha256(entryBytes),
      contentType: contentTypeFor(path, contentTypes),
    })),
  );
  manifestEntries.sort((left, right) => left.path.localeCompare(right.path));
  const graph = await buildOpcPackageGraph({
    entries,
    texts,
    contentTypeFor: (path) => contentTypeFor(path, contentTypes),
  });

  return {
    originalBytes: Uint8Array.from(bytes),
    zip,
    entries,
    manifest: {
      revision: await sha256(bytes),
      entries: manifestEntries,
      nodes: [],
    },
    contentTypes,
    diagnostics,
    graph,
  };
}

export function getContentType(
  loaded: LoadedPackage,
  path: string,
): string | undefined {
  return contentTypeFor(path, loaded.contentTypes);
}

export { resolveRelationshipTarget } from "./relationship-utils";

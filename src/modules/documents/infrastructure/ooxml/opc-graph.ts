import type { DocumentDiagnostic } from "../../domain/types";
import { sha256 } from "./hash";
import { attributes } from "./xml";
import { relationshipSource, resolveRelationshipTarget } from "./relationship-utils";

/** A relationship edge in the OPC package graph. */
export interface OpcRelationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly targetMode: "Internal" | "External";
  /** Normalized package part name for internal targets only. */
  readonly resolvedPart?: string;
}

/** Package parts are opaque bytes; semantic adapters decide how to interpret them. */
export interface OpcPackagePart {
  readonly partName: string;
  readonly contentType?: string;
  readonly rawBytes: Uint8Array;
  readonly sourceHash: string;
  readonly relationships: readonly OpcRelationship[];
}

export interface OpcPackageGraph {
  readonly parts: ReadonlyMap<string, OpcPackagePart>;
  readonly rootRelationships: readonly OpcRelationship[];
  readonly diagnostics: readonly DocumentDiagnostic[];
  relationshipsFor(sourcePartName?: string): readonly OpcRelationship[];
  resolve(sourcePartName: string | undefined, relationshipId: string): OpcRelationship | undefined;
}

export interface OpcPackageGraphInput {
  readonly entries: ReadonlyMap<string, Uint8Array>;
  readonly texts: ReadonlyMap<string, string>;
  readonly contentTypeFor: (partName: string) => string | undefined;
}

function relationshipPartPath(sourcePartName: string): string {
  const slash = sourcePartName.lastIndexOf("/");
  const directory = slash >= 0 ? sourcePartName.slice(0, slash) : "";
  const basename = slash >= 0 ? sourcePartName.slice(slash + 1) : sourcePartName;
  return directory ? `${directory}/_rels/${basename}.rels` : `_rels/${basename}.rels`;
}

function parseRelationshipPart(
  relsPath: string,
  xml: string,
  entries: ReadonlyMap<string, Uint8Array>,
  diagnostics: DocumentDiagnostic[],
): OpcRelationship[] {
  const sourcePart = relationshipSource(relsPath);
  const relationships: OpcRelationship[] = [];
  const ids = new Set<string>();
  for (const match of xml.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/?\s*>/g)) {
    const value = attributes(match[0]);
    if (!value.Id || !value.Target || !value.Type) continue;
    if (ids.has(value.Id)) continue;
    ids.add(value.Id);
    const targetMode = value.TargetMode?.toLowerCase() === "external" ? "External" : "Internal";
    const resolvedPart = targetMode === "Internal" ? resolveRelationshipTarget(relsPath, value.Target) : undefined;
    if (targetMode === "Internal" && (!resolvedPart || !entries.has(resolvedPart))) {
      diagnostics.push({
        severity: "error",
        code: "RELATIONSHIP_TARGET_MISSING",
        message: `Relationship ${value.Id} targets a missing package part.`,
        entry: relsPath,
        details: { relationshipId: value.Id, target: value.Target },
      });
    }
    relationships.push({
      id: value.Id,
      type: value.Type,
      target: value.Target,
      targetMode,
      ...(resolvedPart ? { resolvedPart } : {}),
    });
  }
  if (sourcePart && !entries.has(sourcePart)) {
    diagnostics.push({
      severity: "error",
      code: "RELATIONSHIP_SOURCE_MISSING",
      message: "Relationship part has no corresponding source package part.",
      entry: relsPath,
    });
  }
  return relationships;
}

export async function buildOpcPackageGraph(input: OpcPackageGraphInput): Promise<OpcPackageGraph> {
  const relationshipsBySource = new Map<string | undefined, readonly OpcRelationship[]>();
  const diagnostics: DocumentDiagnostic[] = [];
  for (const [path, xml] of input.texts) {
    if (!path.endsWith(".rels")) continue;
    const source = path === "_rels/.rels" ? undefined : relationshipSource(path);
    if (path !== "_rels/.rels" && source === undefined) {
      diagnostics.push({
        severity: "warning",
        code: "RELATIONSHIP_SOURCE_UNKNOWN",
        message: "Relationship part is not in a recognized OOXML location.",
        entry: path,
      });
      continue;
    }
    relationshipsBySource.set(source, parseRelationshipPart(path, xml, input.entries, diagnostics));
  }
  const parts = new Map<string, OpcPackagePart>();
  for (const [partName, rawBytes] of input.entries) {
    parts.set(partName, {
      partName,
      contentType: input.contentTypeFor(partName),
      rawBytes: Uint8Array.from(rawBytes),
      sourceHash: await sha256(rawBytes),
      relationships: relationshipsBySource.get(partName) ?? [],
    });
  }
  return {
    parts,
    rootRelationships: relationshipsBySource.get(undefined) ?? [],
    diagnostics,
    relationshipsFor(sourcePartName) { return relationshipsBySource.get(sourcePartName) ?? []; },
    resolve(sourcePartName, relationshipId) { return (relationshipsBySource.get(sourcePartName) ?? []).find((relationship) => relationship.id === relationshipId); },
  };
}

export function relationshipPartFor(sourcePartName: string): string {
  return relationshipPartPath(sourcePartName);
}

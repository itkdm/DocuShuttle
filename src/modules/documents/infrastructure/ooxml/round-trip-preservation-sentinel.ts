import { logger } from "@/infrastructure/observability";
import type {
  DocumentRoundTripPreservationIssue,
  DocumentRoundTripPreservationReport,
  DocumentRoundTripSentinelPort,
} from "../../application/document-round-trip-sentinel-port";
import { getContentType, loadPackage, type LoadedPackage } from "./package-model";
import type { OpcRelationship } from "./opc-graph";

const managedPart = (path: string): boolean => (
  path === "[Content_Types].xml"
  || path === "_rels/.rels"
  || path.endsWith(".rels")
  || path === "docProps/core.xml"
  || path === "docProps/app.xml"
  || /^word\/(?:document|styles|numbering|settings|fontTable)\.xml$/u.test(path)
  || /^word\/(?:header|footer)\d+\.xml$/u.test(path)
  || path.startsWith("word/media/")
);

const issue = (
  value: DocumentRoundTripPreservationIssue,
): DocumentRoundTripPreservationIssue => value;

function protectedParts(source: LoadedPackage): ReadonlySet<string> {
  return new Set([...source.entries.keys()].filter((path) => !managedPart(path)));
}

function compareProtectedParts(
  source: LoadedPackage,
  output: LoadedPackage,
  protectedEntries: ReadonlySet<string>,
): DocumentRoundTripPreservationIssue[] {
  const issues: DocumentRoundTripPreservationIssue[] = [];
  for (const entry of protectedEntries) {
    const sourcePart = source.graph.parts.get(entry);
    const outputPart = output.graph.parts.get(entry);
    if (!outputPart) {
      issues.push(issue({ code: "ROUND_TRIP_PART_MISSING", entry, reason: "protected source part is missing from output" }));
      continue;
    }
    if (sourcePart?.sourceHash !== outputPart.sourceHash) {
      issues.push(issue({ code: "ROUND_TRIP_PART_CHANGED", entry, reason: "protected source part bytes changed" }));
    }
    if (getContentType(source, entry) !== getContentType(output, entry)) {
      issues.push(issue({ code: "ROUND_TRIP_CONTENT_TYPE_CHANGED", entry, reason: "protected source part content type changed" }));
    }
  }
  for (const entry of output.entries.keys()) {
    if (!source.entries.has(entry) && !managedPart(entry)) {
      issues.push(issue({ code: "ROUND_TRIP_UNSUPPORTED_PART_ADDED", entry, reason: "output added an unmanaged package part" }));
    }
  }
  return issues;
}

function compareRelationshipSet(
  sourcePart: string | undefined,
  sourceRelationships: readonly OpcRelationship[],
  output: LoadedPackage,
  protectedEntries: ReadonlySet<string>,
): DocumentRoundTripPreservationIssue[] {
  const sourceIsProtected = sourcePart !== undefined && protectedEntries.has(sourcePart);
  const issues: DocumentRoundTripPreservationIssue[] = [];
  for (const relationship of sourceRelationships) {
    const targetIsProtected = relationship.targetMode === "Internal"
      && relationship.resolvedPart !== undefined
      && protectedEntries.has(relationship.resolvedPart);
    if (!sourceIsProtected && !targetIsProtected) continue;

    const outputRelationships = output.graph.relationshipsFor(sourcePart);
    const outputById = outputRelationships.find((candidate) => candidate.id === relationship.id);
    const equivalentWithoutId = outputRelationships.find((candidate) => (
      candidate.type === relationship.type
      && candidate.target === relationship.target
      && candidate.targetMode === relationship.targetMode
      && candidate.resolvedPart === relationship.resolvedPart
    ));
    const entry = sourcePart ? `${sourcePart} relationships` : "_rels/.rels";
    if (!outputById) {
      issues.push(issue({
        code: equivalentWithoutId ? "ROUND_TRIP_RELATIONSHIP_CHANGED" : "ROUND_TRIP_RELATIONSHIP_LOST",
        entry,
        relationshipId: relationship.id,
        relationshipType: relationship.type,
        reason: equivalentWithoutId ? "protected relationship id changed" : "protected relationship is missing from output",
      }));
      continue;
    }
    if (
      outputById.type !== relationship.type
      || outputById.target !== relationship.target
      || outputById.targetMode !== relationship.targetMode
      || outputById.resolvedPart !== relationship.resolvedPart
    ) {
      issues.push(issue({
        code: "ROUND_TRIP_RELATIONSHIP_CHANGED",
        entry,
        relationshipId: relationship.id,
        relationshipType: relationship.type,
        reason: "protected relationship target or type changed",
      }));
    }
  }
  return issues;
}

function compareProtectedRelationships(
  source: LoadedPackage,
  output: LoadedPackage,
  protectedEntries: ReadonlySet<string>,
): DocumentRoundTripPreservationIssue[] {
  const issues = compareRelationshipSet(undefined, source.graph.rootRelationships, output, protectedEntries);
  for (const [sourcePart, sourcePackagePart] of source.graph.parts) {
    issues.push(...compareRelationshipSet(sourcePart, sourcePackagePart.relationships, output, protectedEntries));
  }
  return issues;
}

export class OoxmlRoundTripPreservationSentinel implements DocumentRoundTripSentinelPort {
  async verify(input: { sourceBytes: Uint8Array; outputBytes: Uint8Array }): Promise<DocumentRoundTripPreservationReport> {
    const started = performance.now();
    let protectedPartCount = 0;
    let issues: DocumentRoundTripPreservationIssue[] = [];
    try {
      const [source, output] = await Promise.all([
        loadPackage(input.sourceBytes),
        loadPackage(input.outputBytes),
      ]);
      const protectedEntries = protectedParts(source);
      protectedPartCount = protectedEntries.size;
      issues = [
        ...compareProtectedParts(source, output, protectedEntries),
        ...compareProtectedRelationships(source, output, protectedEntries),
      ];
    } catch {
      issues = [issue({ code: "ROUND_TRIP_PACKAGE_INVALID", reason: "source or output package could not be loaded" })];
    }
    logger.info("document.round_trip_sentinel.completed", {
      sourceBytes: input.sourceBytes.byteLength,
      outputBytes: input.outputBytes.byteLength,
      protectedPartCount,
      issueCount: issues.length,
      durationMs: performance.now() - started,
    });
    return { safe: issues.length === 0, issues };
  }
}

import type { DocumentDiagnostic } from "../../domain/types";
import { encodeXmlText } from "./xml";
import { getContentType, loadPackage } from "./package-model";

const IMAGE_RELATIONSHIP = "/officedocument/2006/relationships/image";
const EMU_PER_UNIT = {
  pt: 12_700,
  in: 914_400,
  cm: 360_000,
  mm: 36_000,
  px: 9_525,
} as const;

export interface ReadOnlyPreviewProjection {
  readonly bytes: Uint8Array;
  readonly transformedObjects: number;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

interface Dimensions {
  readonly cx: number;
  readonly cy: number;
}

function xmlAttribute(value: string): string {
  return encodeXmlText(value)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function parseDimension(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(pt|in|cm|mm|px)\s*$/i.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase() as keyof typeof EMU_PER_UNIT;
  const result = Math.round(amount * EMU_PER_UNIT[unit]);
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function styleDimension(style: string | undefined, name: "width" | "height"): number | undefined {
  if (!style) return undefined;
  const match = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i").exec(style);
  return parseDimension(match?.[1]);
}

function fallbackDimension(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const result = Number(value) * 635;
  return Number.isSafeInteger(result) && result > 0 ? result : undefined;
}

function dimensionsFor(objectXml: string, shapeXml: string): Dimensions | undefined {
  const objectAttributes = /^<w:object\b[^>]*>/i.exec(objectXml)?.[0];
  const shapeAttributes = /^<v:shape\b[^>]*>/i.exec(shapeXml)?.[0];
  const shapeStyle = shapeAttributes ? /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(shapeAttributes) : undefined;
  const cx = styleDimension(shapeStyle?.[1] ?? shapeStyle?.[2], "width") ?? fallbackDimension(objectAttributes ? /\bw:dxaOrig\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(objectAttributes)?.[1] : undefined);
  const cy = styleDimension(shapeStyle?.[1] ?? shapeStyle?.[2], "height") ?? fallbackDimension(objectAttributes ? /\bw:dyaOrig\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(objectAttributes)?.[1] : undefined);
  return cx && cy ? { cx, cy } : undefined;
}

function existingDrawingIds(xmlParts: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const xml of xmlParts) {
    for (const match of xml.matchAll(/<(?:wp:docPr|pic:cNvPr)\b[^>]*>/g)) {
      const value = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[0]);
      if (value?.[1] ?? value?.[2]) ids.add(value[1] ?? value[2]);
    }
  }
  return ids;
}

function nextDrawingId(ids: Set<string>): string {
  let candidate = 1;
  while (ids.has(String(candidate))) candidate += 1;
  const result = String(candidate);
  ids.add(result);
  return result;
}

function drawingXml(relationshipId: string, dimensions: Dimensions, docPrId: string): string {
  const name = `VML preview ${docPrId}`;
  return `<w:drawing xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><wp:inline><wp:extent cx="${dimensions.cx}" cy="${dimensions.cy}"/><wp:docPr id="${docPrId}" name="${xmlAttribute(name)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${xmlAttribute(name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${xmlAttribute(relationshipId)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${dimensions.cx}" cy="${dimensions.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}

function unsupported(entry: string, reason: string, relationshipId?: string): DocumentDiagnostic {
  return {
    severity: "warning",
    code: "VML_PREVIEW_UNSUPPORTED",
    message: "A VML embedded object was left unchanged in the read-only preview.",
    entry,
    ...(relationshipId ? { details: { relationshipId, reason } } : { details: { reason } }),
  };
}

function transformStory(
  entry: string,
  xml: string,
  loaded: Awaited<ReturnType<typeof loadPackage>>,
  ids: Set<string>,
): { xml: string; transformedObjects: number; diagnostics: DocumentDiagnostic[] } {
  let transformedObjects = 0;
  const diagnostics: DocumentDiagnostic[] = [];
  let result = "";
  let cursor = 0;

  for (const objectMatch of xml.matchAll(/<w:object\b[^>]*>[\s\S]*?<\/w:object>/gi)) {
    const start = objectMatch.index ?? 0;
    const objectXml = objectMatch[0];
    result += xml.slice(cursor, start);
    cursor = start + objectXml.length;

    const shapeMatch = /<v:shape\b[^>]*>[\s\S]*?<\/v:shape>/i.exec(objectXml);
    const imageMatch = shapeMatch?.[0] ? /<v:imagedata\b[^>]*>/i.exec(shapeMatch[0]) : undefined;
    const relationshipId = imageMatch ? /\br:id\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(imageMatch[0]) : undefined;
    const imageRelationshipId = relationshipId?.[1] ?? relationshipId?.[2];
    if (!shapeMatch || !imageMatch || !imageRelationshipId) {
      diagnostics.push(unsupported(entry, "missing-image-reference"));
      result += objectXml;
      continue;
    }

    const relationship = loaded.graph.resolve(entry, imageRelationshipId);
    if (!relationship || relationship.targetMode !== "Internal" || !relationship.resolvedPart) {
      diagnostics.push(unsupported(entry, "image-relationship-not-in-package", imageRelationshipId));
      result += objectXml;
      continue;
    }
    if (!relationship.type.toLowerCase().endsWith(IMAGE_RELATIONSHIP) || !loaded.entries.has(relationship.resolvedPart)) {
      diagnostics.push(unsupported(entry, "relationship-is-not-an-internal-image", imageRelationshipId));
      result += objectXml;
      continue;
    }
    const mediaEntry = relationship.resolvedPart;
    const contentType = getContentType(loaded, mediaEntry)?.toLowerCase();
    if (contentType !== "image/png" && contentType !== "image/jpeg") {
      diagnostics.push(unsupported(entry, "image-type-is-not-supported", imageRelationshipId));
      result += objectXml;
      continue;
    }
    const dimensions = dimensionsFor(objectXml, shapeMatch[0]);
    if (!dimensions) {
      diagnostics.push(unsupported(entry, "image-dimensions-are-invalid", imageRelationshipId));
      result += objectXml;
      continue;
    }

    result += drawingXml(imageRelationshipId, dimensions, nextDrawingId(ids));
    transformedObjects += 1;
    diagnostics.push({
      severity: "info",
      code: "VML_OLE_PREVIEW_PROJECTED",
      message: "A VML embedded image was projected to DrawingML for read-only preview.",
      entry,
      details: {
        relationshipId: imageRelationshipId,
        mediaEntry,
      },
    });
  }

  return {
    xml: transformedObjects > 0 ? result + xml.slice(cursor) : xml,
    transformedObjects,
    diagnostics,
  };
}

export async function createReadOnlyPreviewProjection(bytes: Uint8Array): Promise<ReadOnlyPreviewProjection> {
  try {
    const loaded = await loadPackage(bytes);
    const xmlEntries = [...loaded.entries]
      .filter(([entry]) => entry.endsWith(".xml"))
      .map(([, value]) => new TextDecoder("utf-8", { fatal: true }).decode(value));
    const ids = existingDrawingIds(xmlEntries);
    const diagnostics: DocumentDiagnostic[] = [];
    const projectedEntries = new Map<string, string>();
    let transformedObjects = 0;

    for (const [entry, entryBytes] of loaded.entries) {
      if (!entry.endsWith(".xml")) continue;
      const xml = new TextDecoder("utf-8", { fatal: true }).decode(entryBytes);
      if (!/<w:object\b/i.test(xml)) continue;
      const projected = transformStory(entry, xml, loaded, ids);
      if (projected.transformedObjects > 0) projectedEntries.set(entry, projected.xml);
      transformedObjects += projected.transformedObjects;
      diagnostics.push(...projected.diagnostics);
    }

    if (transformedObjects === 0) return { bytes: Uint8Array.from(bytes), transformedObjects, diagnostics };
    for (const [entry, xml] of projectedEntries) loaded.zip.file(entry, xml);
    return {
      bytes: await loaded.zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
      transformedObjects,
      diagnostics,
    };
  } catch {
    if (process.env.NODE_ENV !== "production") console.warn("PaperDuck read-only preview projection skipped.");
    return {
      bytes: Uint8Array.from(bytes),
      transformedObjects: 0,
      diagnostics: [{ severity: "warning", code: "VML_PREVIEW_UNSUPPORTED", message: "Read-only VML preview projection was skipped." }],
    };
  }
}

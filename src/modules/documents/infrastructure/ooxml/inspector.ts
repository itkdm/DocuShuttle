import type {
  DocumentDiagnostic,
  ImageAddress,
  InspectedImage,
  InspectedParagraph,
  InspectedTableCell,
  ParagraphAddress,
  TableCellAddress,
} from "../../domain/types";
import { sha256, utf8 } from "./hash";
import {
  getContentType,
  type LoadedPackage,
  resolveRelationshipTarget,
} from "./package-model";
import { attributes, findElementRanges, visibleText, type XmlRange } from "./xml";

export interface IndexedParagraph extends InspectedParagraph {
  range: XmlRange;
}

export interface IndexedCell extends InspectedTableCell {
  range: XmlRange;
}

export interface IndexedImage extends InspectedImage {
  relationshipEntry: string;
}

export interface DocumentIndex {
  paragraphs: readonly IndexedParagraph[];
  cells: readonly IndexedCell[];
  images: readonly IndexedImage[];
  diagnostics: readonly DocumentDiagnostic[];
}

function storyEntries(loaded: LoadedPackage): string[] {
  return [...loaded.entries.keys()]
    .filter((path) =>
      /^word\/(?:document|header\d+|footer\d+)\.xml$/.test(path),
    )
    .sort((left, right) =>
      left === "word/document.xml" ? -1 : right === "word/document.xml" ? 1 : left.localeCompare(right),
    );
}

function relationshipsEntry(storyEntry: string): string {
  const slash = storyEntry.lastIndexOf("/");
  const directory = storyEntry.slice(0, slash);
  const file = storyEntry.slice(slash + 1);
  return `${directory}/_rels/${file}.rels`;
}

function containingCellPath(
  paragraph: XmlRange,
  cells: readonly IndexedCell[],
): string | undefined {
  const cell = cells.find(
    (candidate) => candidate.range.start < paragraph.start && candidate.range.end > paragraph.end,
  );
  if (!cell) return undefined;
  const earlier = findElementRanges(cell.range.xml, "w:p").filter(
    (candidate) => candidate.start < paragraph.start - cell.range.start,
  ).length;
  return `${cell.address.path}/p[${earlier}]`;
}

async function indexCells(
  entry: string,
  xml: string,
  revision: string,
): Promise<IndexedCell[]> {
  const result: IndexedCell[] = [];
  const tables = findElementRanges(xml, "w:tbl");
  for (let tableIndex = 0; tableIndex < tables.length; tableIndex += 1) {
    const table = tables[tableIndex];
    const rows = findElementRanges(table.xml, "w:tr");
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const cells = findElementRanges(row.xml, "w:tc");
      for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
        const local = cells[cellIndex];
        const range: XmlRange = {
          ...local,
          start: table.start + row.start + local.start,
          end: table.start + row.start + local.end,
          openEnd: table.start + row.start + local.openEnd,
        };
        const text = visibleText(local.xml);
        const fingerprint = await sha256(utf8(text));
        const path = `tbl[${tableIndex}]/tr[${rowIndex}]/tc[${cellIndex}]`;
        const address: TableCellAddress = {
          kind: "table-cell",
          sourceRevision: revision,
          fingerprint,
          entry,
          path,
        };
        result.push({ address, text, range });
      }
    }
  }
  return result;
}

async function indexParagraphs(
  entry: string,
  xml: string,
  revision: string,
  cells: readonly IndexedCell[],
): Promise<IndexedParagraph[]> {
  const paragraphs = findElementRanges(xml, "w:p");
  return Promise.all(
    paragraphs.map(async (range, index) => {
      const text = visibleText(range.xml);
      const openTag = range.xml.slice(0, range.xml.indexOf(">") + 1);
      const paraId = attributes(openTag)["w14:paraId"];
      const path = containingCellPath(range, cells) ?? `p[${index}]`;
      const address: ParagraphAddress = {
        kind: "paragraph",
        sourceRevision: revision,
        fingerprint: await sha256(utf8(text)),
        entry,
        path,
        ...(paraId ? { paraId } : {}),
      };
      return { address, text, range };
    }),
  );
}

function parseRelationships(xml: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of xml.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/?\s*>/g)) {
    const attrs = attributes(match[0]);
    if (attrs.Id && attrs.Target && attrs.TargetMode !== "External") {
      result.set(attrs.Id, attrs.Target);
    }
  }
  return result;
}

async function indexImages(
  loaded: LoadedPackage,
  entry: string,
  xml: string,
): Promise<IndexedImage[]> {
  const relsEntry = relationshipsEntry(entry);
  const relsBytes = loaded.entries.get(relsEntry);
  if (!relsBytes) return [];
  const relationships = parseRelationships(new TextDecoder().decode(relsBytes));
  const result: IndexedImage[] = [];
  let imageIndex = 0;
  for (const match of xml.matchAll(/r:embed\s*=\s*(?:"([^"]+)"|'([^']+)')/g)) {
    const relationshipId = match[1] ?? match[2];
    const target = relationships.get(relationshipId);
    const mediaEntry = target ? resolveRelationshipTarget(relsEntry, target) : undefined;
    const media = mediaEntry ? loaded.entries.get(mediaEntry) : undefined;
    if (!mediaEntry || !media) continue;
    const before = xml.slice(Math.max(0, match.index - 1500), match.index);
    const docPrTags = [...before.matchAll(/<wp:docPr\b[^>]*>/g)];
    const docPr = docPrTags.length > 0 ? attributes(docPrTags.at(-1)?.[0] ?? "") : {};
    const fingerprint = await sha256(media);
    const path = `drawing[${imageIndex}]`;
    const address: ImageAddress = {
      kind: "image",
      sourceRevision: loaded.manifest.revision,
      fingerprint,
      entry,
      path,
      relationshipId,
      mediaEntry,
      mediaReferenceCount: 1,
      ...(docPr.id ? { drawingId: docPr.id } : {}),
    };
    result.push({
      address,
      relationshipEntry: relsEntry,
      contentType: getContentType(loaded, mediaEntry),
      byteLength: media.byteLength,
    });
    imageIndex += 1;
  }
  return result;
}

function unsupportedConstructDiagnostics(entry: string, xml: string): DocumentDiagnostic[] {
  const constructs: ReadonlyArray<readonly [RegExp, string, string]> = [
    [/<w:fld(?:Simple|Char)\b/, "FIELD_PRESENT", "Fields are inspected but not safely editable in V1."],
    [/<w:(?:ins|del|moveFrom|moveTo)\b/, "REVISION_PRESENT", "Tracked revisions are preserved but not editable in V1."],
    [/<w:sdt\b/, "CONTENT_CONTROL_PRESENT", "Content controls are preserved but not editable in V1."],
    [/<w:bookmarkStart\b/, "BOOKMARK_PRESENT", "Bookmarks are preserved; edits spanning them may be rejected."],
    [/<w:(?:txbxContent|altChunk|object)\b/, "COMPLEX_CONTENT_UNSUPPORTED", "Text boxes, altChunk, and embedded objects are preserved but not editable in V1."],
  ];
  const diagnostics: DocumentDiagnostic[] = constructs
    .filter(([pattern]) => pattern.test(xml))
    .map(([, code, message]) => ({
      severity: code === "COMPLEX_CONTENT_UNSUPPORTED" ? "error" as const : "warning" as const,
      code,
      message,
      entry,
    }));
  const wordNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  for (const match of xml.matchAll(/xmlns(?::([\w.-]+))?\s*=\s*(?:"([^"]+)"|'([^']+)')/g)) {
    const prefix = match[1];
    const namespace = match[2] ?? match[3];
    if (namespace === wordNamespace && prefix !== "w") {
      diagnostics.push({
        severity: "error",
        code: "WORD_NAMESPACE_ALIAS_UNSUPPORTED",
        message: "V1 refuses mutation when WordprocessingML uses an alias other than w.",
        entry,
      });
      break;
    }
  }
  const wBinding = /xmlns:w\s*=\s*(?:"([^"]+)"|'([^']+)')/.exec(xml);
  if (wBinding && (wBinding[1] ?? wBinding[2]) !== wordNamespace) {
    diagnostics.push({
      severity: "error",
      code: "WORD_NAMESPACE_UNSUPPORTED",
      message: "V1 only supports the transitional WordprocessingML namespace bound to w.",
      entry,
    });
  }
  let tableDepth = 0;
  for (const match of xml.matchAll(/<\/?w:tbl(?:\s[^>]*)?>/g)) {
    if (match[0].startsWith("</")) tableDepth -= 1;
    else {
      tableDepth += 1;
      if (tableDepth > 1) {
        diagnostics.push({
          severity: "error",
          code: "NESTED_TABLE_UNSUPPORTED",
          message: "Nested tables cannot be safely addressed by the V1 kernel; mutation is refused.",
          entry,
        });
        break;
      }
    }
  }
  return diagnostics;
}

export async function indexDocument(loaded: LoadedPackage): Promise<DocumentIndex> {
  const decoder = new TextDecoder();
  const paragraphs: IndexedParagraph[] = [];
  const cells: IndexedCell[] = [];
  const images: IndexedImage[] = [];
  const diagnostics: DocumentDiagnostic[] = [];
  for (const entry of storyEntries(loaded)) {
    const xml = decoder.decode(loaded.entries.get(entry));
    const indexedCells = await indexCells(entry, xml, loaded.manifest.revision);
    cells.push(...indexedCells);
    paragraphs.push(
      ...(await indexParagraphs(entry, xml, loaded.manifest.revision, indexedCells)),
    );
    images.push(...(await indexImages(loaded, entry, xml)));
    diagnostics.push(...unsupportedConstructDiagnostics(entry, xml));
  }
  const referenceCounts = new Map<string, number>();
  for (const image of images) {
    referenceCounts.set(image.address.mediaEntry, (referenceCounts.get(image.address.mediaEntry) ?? 0) + 1);
  }
  const countedImages = images.map((image) => ({
    ...image,
    address: {
      ...image.address,
      mediaReferenceCount: referenceCounts.get(image.address.mediaEntry) ?? 1,
    },
  }));
  return { paragraphs, cells, images: countedImages, diagnostics };
}

import { DocumentKernelError } from "../../domain/types";
import { decodeXml, setTextNodeText, textNodes, type XmlRange } from "./xml";

export type CrossRunFormatPolicy = "inherit-start";

export interface TextProjectionSegment {
  readonly range: XmlRange;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export function projectParagraphText(xml: string): readonly TextProjectionSegment[] {
  let cursor = 0;
  return textNodes(xml).map((range) => {
    const text = decodeXml(range.xml);
    const segment = { range, text, start: cursor, end: cursor + text.length };
    cursor = segment.end;
    return segment;
  });
}

/** Compiles a visible-text replacement back into the original run XML. */
export function replaceProjectedText(xml: string, expectedText: string, replacement: string, formatPolicy?: CrossRunFormatPolicy): string {
  const segments = projectParagraphText(xml);
  const visible = segments.map((segment) => segment.text).join("");
  const first = visible.indexOf(expectedText);
  if (expectedText.length === 0) throw new DocumentKernelError("EMPTY_TEXT_PRECONDITION", "replaceText requires a non-empty expectedText.");
  if (first < 0 || visible.indexOf(expectedText, first + 1) >= 0) throw new DocumentKernelError("TEXT_PRECONDITION_FAILED", "Expected text must occur exactly once in the addressed paragraph.");
  const last = first + expectedText.length;
  const startIndex = segments.findIndex((segment) => first >= segment.start && first < segment.end);
  const endIndex = segments.findIndex((segment) => last > segment.start && last <= segment.end);
  if (startIndex < 0 || endIndex < 0) throw new DocumentKernelError("TEXT_PRECONDITION_FAILED", "Expected text could not be mapped to the paragraph text projection.");
  if (startIndex !== endIndex && !formatPolicy) throw new DocumentKernelError("UNSAFE_CROSS_RUN_EDIT", "The requested text spans formatted runs; choose an explicit cross-run format policy.");
  const edits = new Map<number, string>();
  if (startIndex === endIndex) {
    const segment = segments[startIndex];
    const localStart = first - segment.start;
    const localEnd = last - segment.start;
    edits.set(startIndex, segment.text.slice(0, localStart) + replacement + segment.text.slice(localEnd));
  } else {
    const startSegment = segments[startIndex];
    const endSegment = segments[endIndex];
    edits.set(startIndex, startSegment.text.slice(0, first - startSegment.start) + replacement);
    for (let index = startIndex + 1; index < endIndex; index += 1) edits.set(index, "");
    edits.set(endIndex, endSegment.text.slice(last - endSegment.start));
  }
  let output = xml;
  for (const index of [...edits.keys()].sort((left, right) => segments[right].range.start - segments[left].range.start)) {
    const segment = segments[index];
    output = setTextNodeText(output, segment.range, edits.get(index)!);
  }
  return output;
}

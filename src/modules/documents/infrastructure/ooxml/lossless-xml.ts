/**
 * A small source-preserving XML index for OOXML parts.
 *
 * Coordinates are UTF-16 code-unit offsets (the coordinate system used by
 * JavaScript strings). The parser never serializes XML: every node keeps a
 * slice of the original source, so unknown elements/attributes and lexical
 * formatting remain untouched unless a mutation explicitly replaces a span.
 */
export interface LosslessXmlNode {
  name: string;
  prefix?: string;
  localName: string;
  start: number;
  openEnd: number;
  contentStart: number;
  closeStart: number;
  end: number;
  selfClosing: boolean;
  rawSource: string;
  children: LosslessXmlNode[];
}

function tagEnd(source: string, start: number): number {
  let quote: string | undefined;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function nodeName(tag: string, closing = false): string | undefined {
  if (closing) return /^<\s*\/\s*([^\s>]+)/u.exec(tag)?.[1];
  const match = /^<\s*([^!?/\s>]+)/u.exec(tag);
  return match?.[1];
}

/** Parse element spans without constructing a replacement DOM. */
export function parseLosslessXml(source: string): LosslessXmlNode[] {
  const roots: LosslessXmlNode[] = [];
  const stack: LosslessXmlNode[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("<", cursor);
    if (start < 0) break;
    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4);
      cursor = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", start)) {
      const end = source.indexOf("]]>", start + 9);
      cursor = end < 0 ? source.length : end + 3;
      continue;
    }
    const end = tagEnd(source, start);
    if (end < 0) break;
    const tag = source.slice(start, end + 1);
    const closing = /^<\s*\//u.test(tag);
    const declaration = /^<\s*[!?]/u.test(tag);
    const name = nodeName(tag, closing);
    if (closing) {
      if (name) {
        const open = stack.at(-1);
        if (open?.name === name) {
          open.closeStart = start;
          open.end = end + 1;
          open.rawSource = source.slice(open.start, open.end);
          stack.pop();
        }
      }
    } else if (!declaration && name) {
      const selfClosing = /\/\s*>$/u.test(tag);
      const separator = name.indexOf(":");
      const node: LosslessXmlNode = {
        name,
        ...(separator > 0 ? { prefix: name.slice(0, separator) } : {}),
        localName: separator > 0 ? name.slice(separator + 1) : name,
        start,
        openEnd: end + 1,
        contentStart: end + 1,
        closeStart: selfClosing ? end : end + 1,
        end: selfClosing ? end + 1 : end + 1,
        selfClosing,
        rawSource: source.slice(start, end + 1),
        children: [],
      };
      const parent = stack.at(-1);
      if (parent) parent.children.push(node);
      else roots.push(node);
      if (!selfClosing) stack.push(node);
    }
    cursor = end + 1;
  }
  return roots;
}

export function flattenLosslessXml(nodes: readonly LosslessXmlNode[]): LosslessXmlNode[] {
  const result: LosslessXmlNode[] = [];
  const visit = (node: LosslessXmlNode) => {
    result.push(node);
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return result;
}

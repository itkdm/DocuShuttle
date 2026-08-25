import { XMLValidator } from "fast-xml-parser";

export interface XmlRange {
  start: number;
  end: number;
  openEnd: number;
  xml: string;
}

export function validateXml(xml: string): true | string {
  const result = XMLValidator.validate(xml, {
    allowBooleanAttributes: false,
  });
  return result === true ? true : result.err.msg;
}

export function attributes(tag: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  const attributePattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of tag.matchAll(attributePattern)) {
    result[match[1]] = decodeXml(match[2] ?? match[3] ?? "");
  }
  return result;
}

export function decodeXml(value: string): string {
  return value.replace(
    /&(?:#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,
    (entity) => {
      if (entity.startsWith("&#x")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(3, -1), 16));
      }
      if (entity.startsWith("&#")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2, -1), 10));
      }
      const named: Record<string, string> = {
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&apos;": "'",
      };
      return named[entity] ?? entity;
    },
  );
}

export function encodeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function textNodes(xml: string): readonly XmlRange[] {
  const nodes: XmlRange[] = [];
  const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  for (const match of xml.matchAll(pattern)) {
    const start = match.index;
    const openEnd = start + match[0].indexOf(">") + 1;
    nodes.push({
      start,
      end: start + match[0].length,
      openEnd,
      xml: match[1],
    });
  }
  return nodes;
}

export function visibleText(xml: string): string {
  return textNodes(xml).map((node) => decodeXml(node.xml)).join("");
}

export function replaceRange(
  source: string,
  start: number,
  end: number,
  replacement: string,
): string {
  return source.slice(0, start) + replacement + source.slice(end);
}

function textElement(value: string): string {
  const preserve = /^\s|\s$/u.test(value) ? ' xml:space="preserve"' : "";
  return `<w:t${preserve}>${encodeXmlText(value)}</w:t>`;
}

export function setTextNodeText(xml: string, node: XmlRange, value: string): string {
  let openTag = xml.slice(node.start, node.openEnd);
  if (/^\s|\s$/u.test(value)) {
    if (/\bxml:space\s*=/.test(openTag)) {
      openTag = openTag.replace(/\bxml:space\s*=\s*(?:"[^"]*"|'[^']*')/, 'xml:space="preserve"');
    } else {
      openTag = `${openTag.slice(0, -1)} xml:space="preserve">`;
    }
  }
  return replaceRange(
    xml,
    node.start,
    node.end,
    `${openTag}${encodeXmlText(value)}</w:t>`,
  );
}

export function findElementRanges(xml: string, qualifiedName: string): XmlRange[] {
  const escaped = qualifiedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<${escaped}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escaped}>`,
    "g",
  );
  return Array.from(xml.matchAll(pattern), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
    openEnd: match.index + match[0].indexOf(">") + 1,
    xml: match[0],
  }));
}

export function setElementText(xml: string, value: string): string {
  const nodes = textNodes(xml);
  if (nodes.length === 0) {
    const selfClosingParagraph = /<w:p(?:\s[^>]*)?\/>/.exec(xml);
    if (selfClosingParagraph) {
      const expanded = `${selfClosingParagraph[0].slice(0, -2)}><w:r>${textElement(value)}</w:r></w:p>`;
      return replaceRange(
        xml,
        selfClosingParagraph.index,
        selfClosingParagraph.index + selfClosingParagraph[0].length,
        expanded,
      );
    }
    const paragraphClose = xml.indexOf("</w:p>");
    if (paragraphClose >= 0) {
      return replaceRange(xml, paragraphClose, paragraphClose, `<w:r>${textElement(value)}</w:r>`);
    }
    const cellClose = xml.lastIndexOf("</w:tc>");
    if (cellClose < 0) return xml;
    return replaceRange(xml, cellClose, cellClose, `<w:p><w:r>${textElement(value)}</w:r></w:p>`);
  }

  let result = xml;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    result = setTextNodeText(result, node, index === 0 ? value : "");
  }
  return result;
}

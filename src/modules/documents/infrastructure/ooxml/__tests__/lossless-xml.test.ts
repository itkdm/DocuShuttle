import { describe, expect, it } from "vitest";
import { flattenLosslessXml, parseLosslessXml } from "../lossless-xml";

describe("lossless OOXML source index", () => {
  it("records nested spans and keeps the original lexical source", () => {
    const source = `<w:tbl data-x='1'><w:tr><w:tc>\n  <w:p><w:r><w:t>A</w:t></w:r></w:p>\n  <w:tbl><w:tr><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>\n</w:tc></w:tr></w:tbl>`;
    const roots = parseLosslessXml(source);
    const nodes = flattenLosslessXml(roots);
    const tables = nodes.filter((node) => node.name === "w:tbl");
    expect(tables).toHaveLength(2);
    expect(tables[0].rawSource).toBe(source);
    expect(tables[1].rawSource).toBe(source.slice(tables[1].start, tables[1].end));
    expect(tables[1].start).toBeGreaterThan(tables[0].start);
    expect(tables[1].end).toBeLessThan(tables[0].end);
    expect(nodes.find((node) => node.name === "w:t")?.rawSource).toBe("<w:t>A</w:t>");
  });

  it("skips comments, CDATA, and declarations without mistaking their text for elements", () => {
    const source = `<?xml version="1.0"?><root><!-- <fake/> --><![CDATA[<fake/>]]><x a=">">value</x></root>`;
    const nodes = flattenLosslessXml(parseLosslessXml(source));
    expect(nodes.map((node) => node.name)).toEqual(["root", "x"]);
    expect(nodes[1].rawSource).toBe('<x a=">">value</x>');
  });
});

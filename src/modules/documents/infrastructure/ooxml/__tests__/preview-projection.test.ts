import JSZip from "jszip";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createReadOnlyPreviewProjection } from "../preview-projection";
import { sha256 } from "../hash";
import { createDocx, documentRelationships, documentXml, unknownBytes } from "./fixture";

const objectXml = `<w:p><w:r><w:object w:dxaOrig="11086" w:dyaOrig="4842"><v:shape style="width:350pt;height:152.5pt"><v:imagedata r:id="rIdImage1"/></v:shape><o:OLEObject r:id="rIdOle" Type="Embed"/></w:object></w:r></w:p>`;

async function createVmlDocx(options: { document?: string; relationships?: string; contentTypes?: string; includeObject?: boolean } = {}): Promise<Uint8Array> {
  const sourceDocument = options.document ?? documentXml.replace('id="7" name="Picture 1"', 'id="1" name="Picture 1"');
  const document = sourceDocument
    .replace('xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"', 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"')
    .replace("</w:body>", options.includeObject === false ? "</w:body>" : `${objectXml}</w:body>`);
  const relationships = (options.relationships ?? documentRelationships).replace(
    "</Relationships>",
    '<Relationship Id="rIdOle" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="embeddings/oleObject1.bin"/></Relationships>',
  );
  const contentTypes = options.contentTypes;
  return createDocx({
    "word/document.xml": document,
    "word/_rels/document.xml.rels": relationships,
    "word/embeddings/oleObject1.bin": unknownBytes,
    ...(contentTypes ? { "[Content_Types].xml": contentTypes } : {}),
  });
}

async function readEntry(bytes: Uint8Array, pathName: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file(pathName);
  if (!file) throw new Error(`Missing test entry ${pathName}`);
  return file.async("uint8array");
}

async function readTextEntry(bytes: Uint8Array, pathName: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file(pathName);
  if (!file) throw new Error(`Missing test entry ${pathName}`);
  return file.async("string");
}

describe("read-only VML preview projection", () => {
  it("projects a VML image while preserving package parts and relationships", async () => {
    const input = await createVmlDocx();
    const inputCopy = Uint8Array.from(input);
    const projected = await createReadOnlyPreviewProjection(input);
    const document = await readTextEntry(projected.bytes, "word/document.xml");
    const relationships = await readTextEntry(projected.bytes, "word/_rels/document.xml.rels");

    expect(input).toEqual(inputCopy);
    expect(projected.transformedObjects).toBe(1);
    expect(document).toContain("<w:drawing");
    expect(document).toContain('r:embed="rIdImage1"');
    expect(document).toContain('cx="4445000" cy="1936750"');
    expect(document).toContain('id="2" name="VML preview 2"');
    expect(document).not.toContain("<w:object");
    expect(relationships).toContain('Id="rIdImage1"');
    expect(relationships).toContain('Id="rIdOle"');
    expect(await readEntry(projected.bytes, "word/media/image1.png")).toEqual(await readEntry(input, "word/media/image1.png"));
    expect(await readEntry(projected.bytes, "word/embeddings/oleObject1.bin")).toEqual(unknownBytes);
    expect(projected.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "VML_OLE_PREVIEW_PROJECTED", entry: "word/document.xml", details: { relationshipId: "rIdImage1", mediaEntry: "word/media/image1.png" } }),
    ]));
  });

  it.each([
    ["external image relationship", async () => createVmlDocx({ relationships: documentRelationships.replace('Target="media/image1.png"', 'Target="https://example.test/image.png" TargetMode="External"') })],
    ["missing image relationship", async () => createVmlDocx({ relationships: documentRelationships.replace(/\s*<Relationship Id="rIdImage1"[^>]*\/>/, "") })],
    ["invalid image dimensions", async () => createVmlDocx({ document: documentXml.replace("</w:body>", '<w:p><w:r><w:object><v:shape xmlns:v="urn:schemas-microsoft-com:vml" style="width:auto;height:auto"><v:imagedata xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rIdImage1"/></v:shape></w:object></w:r></w:p></w:body>'), includeObject: false })],
  ])("leaves %s unchanged", async (_name, build) => {
    const input = await build();
    const projected = await createReadOnlyPreviewProjection(input);
    expect(projected.transformedObjects).toBe(0);
    expect(projected.bytes).toEqual(input);
    expect(projected.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "VML_PREVIEW_UNSUPPORTED" })]));
  });

  it("leaves unsupported image types and normal DrawingML untouched", async () => {
    const contentTypes = (await readTextEntry(await createDocx(), "[Content_Types].xml"))
      .replace('<Default Extension="png" ContentType="image/png"/>', '<Default Extension="png" ContentType="application/octet-stream"/>');
    const unsupported = await createVmlDocx({ contentTypes });
    const unsupportedResult = await createReadOnlyPreviewProjection(unsupported);
    expect(unsupportedResult.transformedObjects).toBe(0);
    expect(unsupportedResult.bytes).toEqual(unsupported);

    const normal = await createDocx();
    const normalResult = await createReadOnlyPreviewProjection(normal);
    expect(normalResult.transformedObjects).toBe(0);
    expect(normalResult.bytes).toEqual(normal);
  });

  const exactFixture = path.resolve("2310250478-孔德明-实验1.2.docx");
  it.skipIf(!existsSync(exactFixture))("projects the known VML/OLE fixture without changing media bytes", async () => {
    const input = Uint8Array.from(await readFile(exactFixture));
    const projected = await createReadOnlyPreviewProjection(input);
    const document = await readTextEntry(projected.bytes, "word/document.xml");
    expect(await sha256(input)).toBe("4d3636af3887e7ddd896a4023538fecbae633bedd5cba5137185597fb76430c1");
    expect(projected.transformedObjects).toBeGreaterThan(0);
    expect(document).toContain('r:embed="rId7"');
    expect(document).toContain('cx="4445000" cy="1936750"');
    expect(await readEntry(projected.bytes, "word/media/image1.png")).toEqual(await readEntry(input, "word/media/image1.png"));
    expect(await readEntry(projected.bytes, "word/embeddings/oleObject1.bin")).toEqual(await readEntry(input, "word/embeddings/oleObject1.bin"));
  }, 120_000);
});

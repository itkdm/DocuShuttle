import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { OoxmlRoundTripPreservationSentinel } from "../round-trip-preservation-sentinel";
import { contentTypes, createDocx, documentRelationships, originalImage, unknownBytes } from "./fixture";

const sentinel = new OoxmlRoundTripPreservationSentinel();

async function rewrite(input: Uint8Array, changes: (zip: JSZip) => void | Promise<void>): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(input);
  await changes(zip);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}

async function entryText(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  if (!file) throw new Error(`missing test entry ${path}`);
  return file.async("string");
}

async function protectedRelationshipSource(): Promise<Uint8Array> {
  const relationships = `${documentRelationships.replace("</Relationships>", "  <Relationship Id=\"rIdFootnote\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes\" Target=\"footnotes.xml\"/>\n</Relationships>")}`;
  const types = contentTypes.replace("</Types>", "  <Override PartName=\"/word/footnotes.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml\"/>\n</Types>");
  return createDocx({
    "[Content_Types].xml": types,
    "word/_rels/document.xml.rels": relationships,
    "word/footnotes.xml": "<w:footnotes xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:footnote w:id=\"1\"/></w:footnotes>",
  });
}

async function protectedSourceRelationshipPackage(): Promise<Uint8Array> {
  return createDocx({
    "customXml/item1.xml": "<custom/>\n",
    "customXml/item2.xml": "<custom-target/>\n",
    "customXml/_rels/item1.xml.rels": "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rIdCustom\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml\" Target=\"item2.xml\"/></Relationships>",
  });
}

async function report(sourceBytes: Uint8Array, outputBytes: Uint8Array) {
  return sentinel.verify({ sourceBytes, outputBytes });
}

describe("OoxmlRoundTripPreservationSentinel", () => {
  it("allows managed document, styles, numbering, and media changes", async () => {
    const source = await createDocx();
    const output = await rewrite(source, async (zip) => {
      zip.file("word/document.xml", (await entryText(zip, "word/document.xml")).replace("Hello duck", "Changed duck"));
      zip.file("word/styles.xml", "changed styles");
      zip.file("word/numbering.xml", "changed numbering");
      zip.file("word/media/image1.png", Uint8Array.from([...originalImage, 9]));
      zip.file("word/media/image2.png", originalImage);
    });
    await expect(report(source, output)).resolves.toMatchObject({ safe: true, issues: [] });
  });

  it("allows a legal deletion of an unreferenced managed media part", async () => {
    const source = await createDocx();
    const output = await rewrite(source, async (zip) => {
      zip.remove("word/media/image1.png");
      zip.file("word/_rels/document.xml.rels", (await entryText(zip, "word/_rels/document.xml.rels")).replace(/\s*<Relationship Id="rIdImage1"[^>]*\/>/, ""));
    });
    await expect(report(source, output)).resolves.toMatchObject({ safe: true, issues: [] });
  });

  it.each([
    ["missing protected part", async (source: Uint8Array) => rewrite(source, (zip) => { zip.remove("customXml/item1.bin"); }), "ROUND_TRIP_PART_MISSING"],
    ["changed protected bytes", async (source: Uint8Array) => rewrite(source, (zip) => { zip.file("customXml/item1.bin", Uint8Array.from([...unknownBytes, 1])); }), "ROUND_TRIP_PART_CHANGED"],
    ["changed protected content type", async (source: Uint8Array) => rewrite(source, async (zip) => { zip.file("[Content_Types].xml", (await entryText(zip, "[Content_Types].xml")).replace("<Default Extension=\"bin\" ContentType=\"application/octet-stream\"/>", "<Default Extension=\"bin\" ContentType=\"application/xml\"/>")); }), "ROUND_TRIP_CONTENT_TYPE_CHANGED"],
    ["added unknown part", async (source: Uint8Array) => rewrite(source, (zip) => { zip.file("customXml/new.bin", unknownBytes); }), "ROUND_TRIP_UNSUPPORTED_PART_ADDED"],
  ] as const)("fails closed for %s", async (_name, outputFactory, code) => {
    const source = await createDocx();
    const result = await report(source, await outputFactory(source));
    expect(result.safe).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  });

  it.each([
    ["footnotes", async (source: Uint8Array) => rewrite(source, (zip) => { zip.remove("word/footnotes.xml"); })],
    ["OLE", async (source: Uint8Array) => rewrite(source, (zip) => { zip.remove("word/embeddings/oleObject1.bin"); })],
  ] as const)("detects removed %s", async (_name, outputFactory) => {
    const source = _name === "footnotes"
      ? await protectedRelationshipSource()
      : await createDocx({ "word/embeddings/oleObject1.bin": unknownBytes });
    const result = await report(source, await outputFactory(source));
    expect(result.safe).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "ROUND_TRIP_PART_MISSING" })]));
  });

  it("detects changed protected OLE bytes", async () => {
    const source = await createDocx({ "word/embeddings/oleObject1.bin": unknownBytes });
    const output = await rewrite(source, (zip) => { zip.file("word/embeddings/oleObject1.bin", Uint8Array.from([...unknownBytes, 2])); });
    await expect(report(source, output)).resolves.toMatchObject({ safe: false, issues: expect.arrayContaining([expect.objectContaining({ code: "ROUND_TRIP_PART_CHANGED", entry: "word/embeddings/oleObject1.bin" })]) });
  });

  it.each([
    ["removed", async (source: Uint8Array) => rewrite(source, async (zip) => { zip.file("word/_rels/document.xml.rels", (await entryText(zip, "word/_rels/document.xml.rels")).replace(/\s*<Relationship Id="rIdFootnote"[^>]*\/>/, "")); }), "ROUND_TRIP_RELATIONSHIP_LOST"],
    ["target", async (source: Uint8Array) => rewrite(source, async (zip) => { zip.file("word/_rels/document.xml.rels", (await entryText(zip, "word/_rels/document.xml.rels")).replace('Target="footnotes.xml"', 'Target="../customXml/item1.bin"')); }), "ROUND_TRIP_RELATIONSHIP_CHANGED"],
    ["type", async (source: Uint8Array) => rewrite(source, async (zip) => { zip.file("word/_rels/document.xml.rels", (await entryText(zip, "word/_rels/document.xml.rels")).replace("relationships/footnotes", "relationships/comments")); }), "ROUND_TRIP_RELATIONSHIP_CHANGED"],
    ["id", async (source: Uint8Array) => rewrite(source, async (zip) => { zip.file("word/_rels/document.xml.rels", (await entryText(zip, "word/_rels/document.xml.rels")).replace("Id=\"rIdFootnote\"", "Id=\"rIdOther\"")); }), "ROUND_TRIP_RELATIONSHIP_CHANGED"],
  ] as const)("detects protected relationship %s", async (_name, outputFactory, code) => {
    const source = await protectedRelationshipSource();
    const result = await report(source, await outputFactory(source));
    expect(result.safe).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code, relationshipId: "rIdFootnote" })]));
  });

  it("allows an unrelated normal image relationship change", async () => {
    const source = await createDocx();
    const output = await rewrite(source, async (zip) => {
      zip.file("word/media/image2.png", originalImage);
      zip.file("word/_rels/document.xml.rels", (await entryText(zip, "word/_rels/document.xml.rels")).replace("</Relationships>", '<Relationship Id="rIdImage2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.png"/></Relationships>'));
    });
    await expect(report(source, output)).resolves.toMatchObject({ safe: true, issues: [] });
  });

  it("rejects a relationship added to a protected source part", async () => {
    const source = await protectedSourceRelationshipPackage();
    const output = await rewrite(source, async (zip) => {
      zip.file("customXml/_rels/item1.xml.rels", (await entryText(zip, "customXml/_rels/item1.xml.rels")).replace("</Relationships>", '<Relationship Id="rIdAdded" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="item2.xml"/></Relationships>'));
    });
    await expect(report(source, output)).resolves.toMatchObject({ safe: false, issues: expect.arrayContaining([expect.objectContaining({ code: "ROUND_TRIP_RELATIONSHIP_ADDED", entry: "customXml/item1.xml relationships", relationshipId: "rIdAdded" })]) });
  });
});

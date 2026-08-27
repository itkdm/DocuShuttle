import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { DocumentKernelError } from "../../../domain/types";
import { OoxmlPreservationKernel } from "../ooxml-preservation-kernel";
import {
  contentTypes,
  createDocx,
  documentRelationships,
  documentXml,
  originalImage,
  unknownBytes,
} from "./fixture";

async function entry(bytes: Uint8Array, path: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file(path);
  if (!file) throw new Error(`Missing fixture entry: ${path}`);
  return file.async("uint8array");
}

describe("OoxmlPreservationKernel", () => {
  it("produces a dry-run mutation plan without changing source bytes", async () => {
    const bytes = await createDocx();
    const original = Uint8Array.from(bytes);
    const kernel = new OoxmlPreservationKernel();
    const inspection = await kernel.inspect(bytes);
    const paragraph = inspection.paragraphs[0];
    const plan = await kernel.planMutation!(bytes, {
      expectedRevision: inspection.manifest.revision,
      operations: [{ kind: "replace-text", address: paragraph.address, expectedText: paragraph.text, replacement: `${paragraph.text} updated` }],
    });
    expect(plan.changedParts).toEqual(["word/document.xml"]);
    expect(plan.targets).toEqual([paragraph.address.nodeId]);
    expect(plan.diagnostics[0]?.code).toBe("MUTATION_PLAN_READY");
    expect(bytes).toEqual(original);
  });

  it("rejects overlapping source ranges during planning", async () => {
    const bytes = await createDocx();
    const kernel = new OoxmlPreservationKernel();
    const inspection = await kernel.inspect(bytes);
    const paragraph = inspection.paragraphs[0];
    await expect(kernel.planMutation!(bytes, {
      expectedRevision: inspection.manifest.revision,
      operations: [
        { kind: "replace-text", address: paragraph.address, expectedText: paragraph.text, replacement: "one" },
        { kind: "replace-text", address: paragraph.address, expectedText: paragraph.text, replacement: "two" },
      ],
    })).rejects.toMatchObject({ code: "OVERLAPPING_OPERATIONS" });
  });
  it("inspects manifest, stable addresses, relationships, and package integrity", async () => {
    const bytes = await createDocx();
    const kernel = new OoxmlPreservationKernel();

    const inspected = await kernel.inspect(bytes);

    expect(inspected.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(inspected.validation?.valid).toBe(true);
    expect(inspected.validation?.tiers.map(({ tier }) => tier)).toEqual([
      "zip-security", "xml-well-formed", "source-preservation", "opc-integrity", "semantic", "identity",
    ]);
    expect(inspected.manifest.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(inspected.manifest.nodes).toHaveLength(
      inspected.paragraphs.length + inspected.tableCells.length + inspected.images.length,
    );
    expect(new Set(inspected.manifest.nodes.map(({ nodeId }) => nodeId)).size).toBe(
      inspected.manifest.nodes.length,
    );
    expect(inspected.paragraphs[0].address.nodeId).toMatch(/^node_[a-f0-9]{32}$/);
    expect(inspected.manifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "word/document.xml", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        expect.objectContaining({ path: "customXml/item1.bin", size: unknownBytes.byteLength }),
      ]),
    );
    expect(inspected.paragraphs[0]).toMatchObject({
      text: "Hello duck",
      address: { paraId: "A1B2C3D4", path: "p[0]" },
    });
    expect(inspected.tableCells[0]).toMatchObject({
      text: "Cell value",
      address: { path: "tbl[0]/tr[0]/tc[0]" },
    });
    expect(inspected.images[0]).toMatchObject({
      contentType: "image/png",
      byteLength: originalImage.byteLength,
      address: {
        relationshipId: "rIdImage1",
        mediaEntry: "word/media/image1.png",
        drawingId: "7",
      },
    });
    expect(inspected.paragraphs).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "Header duck", address: expect.objectContaining({ entry: "word/header1.xml" }) }),
      expect.objectContaining({ text: "Footer duck", address: expect.objectContaining({ entry: "word/footer1.xml" }) }),
    ]));
  });

  it("returns the exact original bytes for a no-op", async () => {
    const bytes = await createDocx();
    const kernel = new OoxmlPreservationKernel();
    const inspected = await kernel.inspect(bytes);

    const result = await kernel.mutate(bytes, {
      expectedRevision: inspected.manifest.revision,
      operations: [],
    });

    expect(result.bytes).toEqual(bytes);
    expect(result.manifest).toEqual(inspected.manifest);
    expect(result.changedEntries).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "NO_OP_PRESERVED" }));
  });

  it("atomically edits paragraph, cell, and image while preserving every untouched entry", async () => {
    const bytes = await createDocx();
    const kernel = new OoxmlPreservationKernel();
    const before = await kernel.inspect(bytes);
    const newImage = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 9, 8, 7, 6]);

    const result = await kernel.mutate(bytes, {
      expectedRevision: before.manifest.revision,
      operations: [
        {
          kind: "replace-text",
          address: before.paragraphs[0].address,
          expectedText: "duck",
          replacement: "PaperDuck",
        },
        {
          kind: "set-cell-text",
          address: before.tableCells[0].address,
          expectedText: "Cell value",
          expectedHash: before.tableCells[0].address.fingerprint,
          text: "Approved",
        },
        {
          kind: "replace-image",
          address: before.images[0].address,
          expectedHash: before.images[0].address.fingerprint,
          bytes: newImage,
          contentType: "image/png",
        },
      ],
    });

    expect(result.changedEntries).toEqual(["word/document.xml", "word/media/image1.png"]);
    expect(await entry(result.bytes, "customXml/item1.bin")).toEqual(unknownBytes);
    expect(await entry(result.bytes, "word/styles.xml")).toEqual(await entry(bytes, "word/styles.xml"));
    expect(await entry(result.bytes, "word/_rels/document.xml.rels")).toEqual(
      await entry(bytes, "word/_rels/document.xml.rels"),
    );
    expect(await entry(result.bytes, "word/media/image1.png")).toEqual(newImage);

    const after = await kernel.validate(result.bytes);
    expect(after.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(after.paragraphs.find(({ address }) => address.paraId === "A1B2C3D4")?.text).toBe(
      "Hello PaperDuck",
    );
    expect(after.tableCells[0].text).toBe("Approved");
    expect(after.paragraphs.find(({ address }) => address.paraId === "A1B2C3D4")?.address.nodeId).toBe(
      before.paragraphs[0].address.nodeId,
    );
    expect(after.tableCells[0].address.nodeId).toBe(before.tableCells[0].address.nodeId);
    expect(after.images[0].address.nodeId).toBe(before.images[0].address.nodeId);
    expect(after.manifest.nodes.find(({ kind, path }) => kind === "paragraph" && path === before.paragraphs[0].address.path)?.nodeId)
      .toBe(before.paragraphs[0].address.nodeId);
    expect(after.paragraphs.find(({ address }) => address.paraId === "A1B2C3D4")?.address.path).toBe(
      before.paragraphs[0].address.path,
    );
  });

  it("rejects all output when any precondition fails", async () => {
    const bytes = await createDocx();
    const kernel = new OoxmlPreservationKernel();
    const before = await kernel.inspect(bytes);

    await expect(
      kernel.mutate(bytes, {
        expectedRevision: before.manifest.revision,
        operations: [
          {
            kind: "set-cell-text",
            address: before.tableCells[0].address,
            expectedText: "wrong value",
            text: "must not be written",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "CELL_TEXT_PRECONDITION_FAILED" });
    expect(await entry(bytes, "word/document.xml")).toEqual(await entry(await createDocx(), "word/document.xml"));
  });

  it("refuses unsafe text edits spanning multiple formatted runs", async () => {
    const bytes = await createDocx({
      "word/document.xml": documentXml.replace(
        "<w:t>Hello duck</w:t>",
        "<w:t>Hello </w:t></w:r><w:r><w:t>duck</w:t>",
      ),
    });
    const kernel = new OoxmlPreservationKernel();
    const before = await kernel.inspect(bytes);

    await expect(
      kernel.mutate(bytes, {
        expectedRevision: before.manifest.revision,
        operations: [{
          kind: "replace-text",
          address: before.paragraphs[0].address,
          expectedText: "Hello duck",
          replacement: "PaperDuck",
        }],
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_CROSS_RUN_EDIT" });
  });

  it("supports explicit inherit-start policy for cross-run replacement", async () => {
    const splitXml = documentXml.replace("<w:r><w:t>Hello duck</w:t></w:r>", "<w:r><w:t>Hello </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>duck</w:t></w:r>");
    const bytes = await createDocx({ "word/document.xml": splitXml });
    const kernel = new OoxmlPreservationKernel();
    const inspected = await kernel.inspect(bytes);
    const paragraph = inspected.paragraphs.find(({ text }) => text.includes("Hello duck"));
    if (!paragraph) throw new Error("missing split-run fixture paragraph");
    const result = await kernel.mutate(bytes, { expectedRevision: inspected.manifest.revision, operations: [{ kind: "replace-text", address: paragraph.address, expectedText: "Hello duck", replacement: "PaperDuck", formatPolicy: "inherit-start" }] });
    const after = await kernel.inspect(result.bytes);
    expect(after.paragraphs.find(({ address }) => address.nodeId === paragraph.address.nodeId)?.text).toContain("PaperDuck");
  });

  it("reports broken relationship targets and refuses mutation", async () => {
    const bytes = await createDocx({ "word/media/image1.png": null });
    const kernel = new OoxmlPreservationKernel();
    const inspected = await kernel.inspect(bytes);

    expect(inspected.diagnostics).toContainEqual(
      expect.objectContaining({ code: "RELATIONSHIP_TARGET_MISSING", severity: "error" }),
    );
    await expect(
      kernel.mutate(bytes, {
        expectedRevision: inspected.manifest.revision,
        operations: [],
      }),
    ).rejects.toBeInstanceOf(DocumentKernelError);
  });

  it("reports and refuses text mutation inside unsupported fields", async () => {
    const bytes = await createDocx({
      "word/document.xml": documentXml.replace(
        "<w:t>Hello duck</w:t>",
        '<w:fldSimple w:instr="DATE"><w:r><w:t>Hello duck</w:t></w:r></w:fldSimple>',
      ),
    });
    const kernel = new OoxmlPreservationKernel();
    const inspected = await kernel.inspect(bytes);
    expect(inspected.diagnostics).toContainEqual(expect.objectContaining({ code: "FIELD_PRESENT" }));

    await expect(kernel.mutate(bytes, {
      expectedRevision: inspected.manifest.revision,
      operations: [{
        kind: "replace-text",
        address: inspected.paragraphs[0].address,
        expectedText: "duck",
        replacement: "PaperDuck",
      }],
    })).rejects.toMatchObject({ code: "UNSUPPORTED_TEXT_CONTAINER" });
  });

  it("rejects traversal names and unsafe ZIP expansion before package extraction", async () => {
    const traversalZip = await JSZip.loadAsync(await createDocx());
    traversalZip.file("../escape.bin", unknownBytes);
    const traversal = await traversalZip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const kernel = new OoxmlPreservationKernel();

    await expect(kernel.inspect(traversal)).rejects.toMatchObject({ code: "ZIP_ENTRY_PATH_UNSAFE" });

    const collisionZip = await JSZip.loadAsync(await createDocx());
    collisionZip.file("WORD/DOCUMENT.XML", documentXml);
    const collision = await collisionZip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    await expect(kernel.inspect(collision)).rejects.toMatchObject({ code: "ZIP_ENTRY_PATH_COLLISION" });

    const bomb = await createDocx({
      "customXml/highly-compressible.bin": new Uint8Array(1024 * 1024),
    });
    await expect(kernel.inspect(bomb)).rejects.toMatchObject({ code: "ZIP_COMPRESSION_RATIO_EXCEEDED" });
  });

  it("refuses namespace aliases that could bypass unsupported-construct checks", async () => {
    const wordNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const bytes = await createDocx({
      "word/document.xml": documentXml.replace(
        "<w:r><w:t>Hello duck</w:t></w:r>",
        `<x:fldSimple xmlns:x="${wordNamespace}" x:instr="DATE"><w:r><w:t>Hello duck</w:t></w:r></x:fldSimple>`,
      ),
    });
    const kernel = new OoxmlPreservationKernel();
    const inspected = await kernel.inspect(bytes);

    expect(inspected.diagnostics).toContainEqual(
      expect.objectContaining({ code: "WORD_NAMESPACE_ALIAS_UNSUPPORTED", severity: "error" }),
    );
    await expect(kernel.mutate(bytes, {
      expectedRevision: inspected.manifest.revision,
      operations: [],
    })).rejects.toMatchObject({ code: "SOURCE_PACKAGE_INVALID" });
  });

  it("refuses replacing a media part shared by multiple drawing occurrences", async () => {
    const duplicateDrawing = '<w:p w14:paraId="2A2B3C4D"><w:r><w:drawing><wp:inline><wp:docPr id="8" name="Picture 2"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rIdImage1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
    const bytes = await createDocx({
      "word/document.xml": documentXml.replace("    <w:sectPr>", `    ${duplicateDrawing}\n    <w:sectPr>`),
    });
    const kernel = new OoxmlPreservationKernel();
    const inspected = await kernel.inspect(bytes);

    expect(inspected.images).toHaveLength(2);
    expect(inspected.images[0].address.mediaReferenceCount).toBe(2);
    await expect(kernel.mutate(bytes, {
      expectedRevision: inspected.manifest.revision,
      operations: [{
        kind: "replace-image",
        address: inspected.images[0].address,
        expectedHash: inspected.images[0].address.fingerprint,
        bytes: Uint8Array.from([...originalImage, 99]),
        contentType: "image/png",
      }],
    })).rejects.toMatchObject({ code: "SHARED_MEDIA_PART_UNSUPPORTED" });
  });

  it("resolves root-absolute relationship targets and rejects duplicate relationship IDs", async () => {
    const kernel = new OoxmlPreservationKernel();
    const absolute = await createDocx({
      "word/_rels/document.xml.rels": documentRelationships.replace(
        'Target="media/image1.png"',
        'Target="/word/media/image1.png"',
      ),
    });
    expect((await kernel.inspect(absolute)).diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);

    const duplicated = await createDocx({
      "word/_rels/document.xml.rels": documentRelationships.replace(
        "</Relationships>",
        '<Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>',
      ),
    });
    expect((await kernel.inspect(duplicated)).diagnostics).toContainEqual(
      expect.objectContaining({ code: "RELATIONSHIP_ID_DUPLICATE", severity: "error" }),
    );
  });

  it("keeps external hyperlinks inert without fetching them", async () => {
    const bytes = await createDocx({
      "word/_rels/document.xml.rels": documentRelationships.replace(
        "</Relationships>",
        '<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/reference" TargetMode="External"/></Relationships>',
      ),
    });
    const kernel = new OoxmlPreservationKernel();
    const inspected = await kernel.inspect(bytes);

    expect(inspected.diagnostics).toContainEqual(expect.objectContaining({
      code: "RELATIONSHIP_EXTERNAL_TARGET",
      severity: "warning",
      entry: "word/_rels/document.xml.rels",
      details: expect.objectContaining({ target: "https://example.invalid/reference" }),
    }));
    const result = await kernel.mutate(bytes, {
      expectedRevision: inspected.manifest.revision,
      operations: [],
    });
    expect(result.bytes).toEqual(bytes);
  });

  it("detects macro/VBA parts, declarations, and relationships and refuses mutation", async () => {
    const macroContentTypes = contentTypes.replace(
      "</Types>",
      '<Override PartName="/word/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>',
    );
    const macroRelationships = documentRelationships.replace(
      "</Relationships>",
      '<Relationship Id="rIdVba" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>',
    );
    const bytes = await createDocx({
      "[Content_Types].xml": macroContentTypes,
      "word/_rels/document.xml.rels": macroRelationships,
      "word/vbaProject.bin": Uint8Array.from([0x44, 0x43, 0x46]),
    });
    const kernel = new OoxmlPreservationKernel();
    const inspected = await kernel.inspect(bytes);

    expect(inspected.diagnostics).toContainEqual(expect.objectContaining({
      code: "MACRO_CONTENT_UNSUPPORTED",
      severity: "error",
      entry: "word/vbaProject.bin",
    }));
    expect(inspected.diagnostics).toContainEqual(expect.objectContaining({
      code: "MACRO_CONTENT_UNSUPPORTED",
      severity: "error",
      entry: "[Content_Types].xml",
    }));
    await expect(kernel.mutate(bytes, {
      expectedRevision: inspected.manifest.revision,
      operations: [],
    })).rejects.toMatchObject({ code: "SOURCE_PACKAGE_INVALID" });
  });

  it("validates image signatures and plain-text control policy", async () => {
    const bytes = await createDocx();
    const kernel = new OoxmlPreservationKernel();
    const inspected = await kernel.inspect(bytes);

    await expect(kernel.mutate(bytes, {
      expectedRevision: inspected.manifest.revision,
      operations: [{
        kind: "replace-image",
        address: inspected.images[0].address,
        expectedHash: inspected.images[0].address.fingerprint,
        bytes: Uint8Array.from([1, 2, 3]),
        contentType: "image/png",
      }],
    })).rejects.toMatchObject({ code: "IMAGE_SIGNATURE_MISMATCH" });

    await expect(kernel.mutate(bytes, {
      expectedRevision: inspected.manifest.revision,
      operations: [{
        kind: "set-cell-text",
        address: inspected.tableCells[0].address,
        text: "line one\nline two",
      }],
    })).rejects.toMatchObject({ code: "TEXT_CONTROL_UNSUPPORTED" });
  });

  it("preserves leading/trailing spaces and returns exact bytes for semantic no-ops", async () => {
    const bytes = await createDocx();
    const kernel = new OoxmlPreservationKernel();
    const before = await kernel.inspect(bytes);
    const spaced = await kernel.mutate(bytes, {
      expectedRevision: before.manifest.revision,
      operations: [{
        kind: "set-cell-text",
        address: before.tableCells[0].address,
        text: " Approved ",
      }],
    });
    const xml = new TextDecoder().decode(await entry(spaced.bytes, "word/document.xml"));
    expect(xml).toContain('<w:t xml:space="preserve"> Approved </w:t>');

    const noOp = await kernel.mutate(bytes, {
      expectedRevision: before.manifest.revision,
      operations: [
        {
          kind: "set-cell-text",
          address: before.tableCells[0].address,
          expectedText: before.tableCells[0].text,
          text: before.tableCells[0].text,
        },
        {
          kind: "replace-image",
          address: before.images[0].address,
          expectedHash: before.images[0].address.fingerprint,
          bytes: originalImage,
          contentType: "image/png",
        },
      ],
    });
    expect(noOp.bytes).toEqual(bytes);
    expect(noOp.changedEntries).toEqual([]);
    expect(noOp.diagnostics).toContainEqual(expect.objectContaining({ code: "NO_OP_PRESERVED" }));
  });

  it("opens nested tables and text boxes as warnings without blocking safe paragraph writes", async () => {
    const bytes = await createDocx({
      "word/document.xml": documentXml.replace(
        "</w:body>",
        `<w:tbl><w:tr><w:tc><w:p w14:paraId="NESTED01"><w:r><w:t>outer</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p w14:paraId="NESTED02"><w:r><w:t>inner</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl><w:p><w:r><w:txbxContent><w:p><w:r><w:t>boxed</w:t></w:r></w:p></w:txbxContent></w:r></w:p></w:body>`,
      ),
    });
    const kernel = new OoxmlPreservationKernel();
    const inspected = await kernel.inspect(bytes);
    expect(inspected.diagnostics).toContainEqual(expect.objectContaining({ code: "NESTED_TABLE_UNSUPPORTED", severity: "warning" }));
    expect(inspected.diagnostics).toContainEqual(expect.objectContaining({ code: "COMPLEX_CONTENT_UNSUPPORTED", severity: "warning" }));
    expect(inspected.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    const nestedCell = inspected.tableCells.find(({ text }) => text === "inner");
    expect(nestedCell).toMatchObject({ text: "inner", address: { path: "tbl[1]/tr[0]/tc[0]/tbl[0]/tr[0]/tc[0]" } });
    const boxed = inspected.paragraphs.find(({ text, address }) => text === "boxed" && address.path.startsWith("textbox["));
    expect(boxed).toMatchObject({ address: { path: "textbox[0]/p[0]", capabilities: expect.arrayContaining([expect.objectContaining({ operation: "replace-text", state: "guarded", reasonCode: "TEXTBOX_MUTATION_UNSUPPORTED" })]) } });

    const hello = inspected.paragraphs.find((paragraph) => paragraph.text.includes("Hello duck"));
    expect(hello).toBeDefined();
    const mutated = await kernel.mutate(bytes, {
      expectedRevision: inspected.manifest.revision,
      operations: [{
        kind: "replace-text",
        address: hello!.address,
        expectedText: "duck",
        replacement: "PaperDuck",
      }],
    });
    const zip = await JSZip.loadAsync(mutated.bytes);
    expect(await zip.file("word/document.xml")?.async("string")).toContain("Hello PaperDuck");

    const nestedMutation = await kernel.mutate(bytes, {
      expectedRevision: inspected.manifest.revision,
      operations: [{ kind: "set-cell-text", address: nestedCell!.address, expectedText: "inner", text: "inner changed" }],
    });
    const nestedAfter = await kernel.validate(nestedMutation.bytes);
    expect(nestedAfter.tableCells.find(({ address }) => address.nodeId === nestedCell!.address.nodeId)?.text).toBe("inner changed");
    const outerCell = inspected.tableCells.find(({ text }) => text === "outerinner");
    await expect(kernel.mutate(bytes, {
      expectedRevision: inspected.manifest.revision,
      operations: [{ kind: "set-cell-text", address: outerCell!.address, text: "unsafe" }],
    })).rejects.toMatchObject({ code: "NESTED_TABLE_CONTAINER_UNSUPPORTED" });
  });

  it("ignores trailing bytes after a valid ZIP end record", async () => {
    const packed = await createDocx();
    const trailing = new Uint8Array(packed.byteLength + 12);
    trailing.set(packed);
    const kernel = new OoxmlPreservationKernel();
    const inspected = await kernel.inspect(trailing);
    expect(inspected.paragraphs.some((paragraph) => paragraph.text === "Hello duck")).toBe(true);
    expect(inspected.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
  });

  it("reports AlternateContent as a preserved coherence group", async () => {
    const bytes = await createDocx({
      "word/document.xml": documentXml.replace(
        "</w:body>",
        '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="wps"><w:p><w:r><w:t>choice</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>fallback</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent></w:body>',
      ),
    });
    const inspected = await new OoxmlPreservationKernel().inspect(bytes);
    expect(inspected.diagnostics).toContainEqual(expect.objectContaining({ code: "ALTERNATE_CONTENT_PRESENT", severity: "warning" }));
    expect(inspected.paragraphs.map(({ text }) => text)).toEqual(expect.arrayContaining(["choice", "fallback"]));
  });
});

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { DocumentKernelError } from "../../../domain/types";
import { OoxmlPreservationKernel } from "../ooxml-preservation-kernel";
import {
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
  it("inspects manifest, stable addresses, relationships, and package integrity", async () => {
    const bytes = await createDocx();
    const kernel = new OoxmlPreservationKernel();

    const inspected = await kernel.inspect(bytes);

    expect(inspected.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(inspected.manifest.revision).toMatch(/^[a-f0-9]{64}$/);
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
});

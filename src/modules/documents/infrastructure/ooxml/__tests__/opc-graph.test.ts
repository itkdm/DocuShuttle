import { describe, expect, it } from "vitest";
import { buildOpcPackageGraph, relationshipPartFor } from "../opc-graph";

const bytes = (value: string) => new TextEncoder().encode(value);

describe("OPC package graph", () => {
  it("resolves root and part relationships without assuming feature paths", async () => {
    const entries = new Map([
      ["[Content_Types].xml", bytes("<Types/>")],
      ["_rels/.rels", bytes('<Relationships><Relationship Id="rDoc" Type="officeDocument" Target="word/document.xml"/></Relationships>')],
      ["word/document.xml", bytes("<document/>")],
      ["word/_rels/document.xml.rels", bytes('<Relationships><Relationship Id="rImg" Type="image" Target="media/picture%201.png"/><Relationship Id="rLink" Type="hyperlink" Target="https://example.test" TargetMode="External"/></Relationships>')],
      ["word/media/picture 1.png", new Uint8Array([1, 2, 3])],
    ]);
    const graph = await buildOpcPackageGraph({ entries, texts: new Map([...entries].filter(([, value]) => value instanceof Uint8Array).filter(([path]) => path.endsWith(".xml") || path.endsWith(".rels")).map(([path, value]) => [path, new TextDecoder().decode(value)])), contentTypeFor: () => undefined });

    expect(graph.rootRelationships[0]?.resolvedPart).toBe("word/document.xml");
    expect(graph.relationshipsFor("word/document.xml")).toHaveLength(2);
    expect(graph.resolve("word/document.xml", "rImg")?.resolvedPart).toBe("word/media/picture 1.png");
    expect(graph.resolve("word/document.xml", "rLink")?.targetMode).toBe("External");
    expect(graph.parts.get("word/media/picture 1.png")?.sourceHash).toHaveLength(64);
    expect(relationshipPartFor("word/document.xml")).toBe("word/_rels/document.xml.rels");
  });

  it("keeps missing targets as graph diagnostics instead of fabricating parts", async () => {
    const entries = new Map([
      ["_rels/.rels", bytes('<Relationships><Relationship Id="missing" Type="image" Target="word/media/nope.png"/></Relationships>')],
    ]);
    const graph = await buildOpcPackageGraph({ entries, texts: new Map([["_rels/.rels", new TextDecoder().decode(entries.get("_rels/.rels")!)] ]), contentTypeFor: () => undefined });
    expect(graph.parts.has("word/media/nope.png")).toBe(false);
    expect(graph.diagnostics.some((diagnostic) => diagnostic.code === "RELATIONSHIP_TARGET_MISSING")).toBe(true);
  });
});

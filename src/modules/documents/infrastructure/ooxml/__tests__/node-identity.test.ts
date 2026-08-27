import { describe, expect, it } from "vitest";
import { remapNodeIdentities } from "../node-identity";
import type { DocumentNodeManifest } from "../../../domain/types";

const node = (overrides: Partial<DocumentNodeManifest> & Pick<DocumentNodeManifest, "nodeId" | "path" | "fingerprint">): DocumentNodeManifest => ({ kind: "paragraph", entry: "word/document.xml", capabilities: [], ...overrides });

describe("node identity sidecar remap", () => {
  it("retains native identities when a locator moves", () => {
    const previous = [node({ nodeId: "node_old", path: "p[1]", fingerprint: "same", nativeIdentity: { kind: "w14:paraId", value: "A", scope: "word/document.xml" } })];
    const current = [node({ nodeId: "node_new", path: "p[2]", fingerprint: "same", nativeIdentity: { kind: "w14:paraId", value: "A", scope: "word/document.xml" } })];
    expect(remapNodeIdentities(previous, current)).toMatchObject({ moved: ["node_old"], inserted: [], deleted: [], ambiguous: [] });
  });

  it("does not guess when a fingerprint has multiple candidates", () => {
    const previous = [node({ nodeId: "node_old", path: "p[1]", fingerprint: "same" })];
    const current = [node({ nodeId: "node_a", path: "p[2]", fingerprint: "same" }), node({ nodeId: "node_b", path: "p[3]", fingerprint: "same" })];
    expect(remapNodeIdentities(previous, current)).toMatchObject({ ambiguous: ["node_old"], inserted: ["node_a", "node_b"], deleted: [] });
  });
});

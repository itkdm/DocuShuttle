import { describe, expect, it } from "vitest";
import { capabilitiesFor, featureAdapterRegistry } from "../capability-registry";

describe("OOXML capability registry", () => {
  it("exposes a provider-neutral feature adapter registry", () => {
    expect(featureAdapterRegistry.list()).toEqual(["textbox", "cross-run-text", "nested-table-container", "shared-media"]);
    expect(featureAdapterRegistry.matching({ kind: "paragraph", textBox: true }).map(({ featureId }) => featureId)).toEqual(["textbox"]);
  });
  it("marks text boxes and nested containers guarded while keeping reads supported", () => {
    expect(capabilitiesFor("paragraph", { textBox: true })).toContainEqual(expect.objectContaining({ operation: "read", state: "supported" }));
    expect(capabilitiesFor("paragraph", { textBox: true })).toContainEqual(expect.objectContaining({ operation: "replace-text", state: "guarded" }));
    expect(capabilitiesFor("table-cell", { containsNestedTable: true })).toContainEqual(expect.objectContaining({ reasonCode: "NESTED_TABLE_CONTAINER_UNSUPPORTED" }));
  });

  it("keeps ordinary nodes independently writable", () => {
    expect(capabilitiesFor("paragraph")).toContainEqual({ operation: "replace-text", state: "supported" });
    expect(capabilitiesFor("table-cell")).toContainEqual({ operation: "set-cell-text", state: "supported" });
    expect(capabilitiesFor("image")).toContainEqual({ operation: "replace-image", state: "supported" });
  });

  it("guards paragraphs whose visible text crosses formatting runs", () => {
    expect(capabilitiesFor("paragraph", { crossRun: true })).toContainEqual(expect.objectContaining({ operation: "replace-text", state: "guarded", reasonCode: "UNSAFE_CROSS_RUN_EDIT" }));
  });
});

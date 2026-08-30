import { describe, expect, it } from "vitest";

import { shouldReloadDocumentForRevision } from "./document-reconciliation";

describe("shouldReloadDocumentForRevision", () => {
  it("does not reload an unchanged document", () => {
    expect(shouldReloadDocumentForRevision("r10", "r10")).toBe(false);
  });

  it("reloads when a mutation creates a new revision", () => {
    expect(shouldReloadDocumentForRevision("r10", "r11")).toBe(true);
  });

  it("reloads when no document is loaded yet", () => {
    expect(shouldReloadDocumentForRevision(undefined, "r10")).toBe(true);
  });

  it("does not reload when both revisions are absent", () => {
    expect(shouldReloadDocumentForRevision(undefined, undefined)).toBe(false);
  });
});

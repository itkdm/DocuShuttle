import { describe, expect, it } from "vitest";
import { captureDocumentViewInputSchema } from "./client-tools";

describe("capture_document_view input", () => {
  it("only allows the current visible viewport and keeps server fields out", () => {
    expect(captureDocumentViewInputSchema.parse({ target: "visible" })).toEqual({ target: "visible" });
    expect(() => captureDocumentViewInputSchema.parse({ target: "visible", expectedRevision: "rev-1" })).toThrow();
    expect(() => captureDocumentViewInputSchema.parse({ target: "page", pageNumber: 1 })).toThrow();
  });
});

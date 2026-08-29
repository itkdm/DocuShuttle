import { describe, expect, it } from "vitest";
import { captureDocumentViewInputSchema } from "./client-tools";

describe("capture_document_view input", () => {
  it("keeps the model input free of the server-owned revision token", () => {
    expect(captureDocumentViewInputSchema.parse({ target: "visible" })).toEqual({ target: "visible" });
    expect(captureDocumentViewInputSchema.parse({ target: "page", pageNumber: 1 })).toEqual({ target: "page", pageNumber: 1 });
    expect(() => captureDocumentViewInputSchema.parse({ target: "visible", expectedRevision: "rev-1" })).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { captureDocumentViewInputSchema, scrollDocumentViewInputSchema } from "./client-tools";

describe("capture_document_view input", () => {
  it("only allows the current visible viewport and keeps server fields out", () => {
    expect(captureDocumentViewInputSchema.parse({ target: "visible" })).toEqual({ target: "visible" });
    expect(() => captureDocumentViewInputSchema.parse({ target: "visible", expectedRevision: "rev-1" })).toThrow();
    expect(() => captureDocumentViewInputSchema.parse({ target: "page", pageNumber: 1 })).toThrow();
  });
});

describe("scroll_document_view input", () => {
  it("accepts only relative and edge commands", () => {
    expect(scrollDocumentViewInputSchema.parse({ kind: "relative", direction: "down", amount: "viewport" })).toEqual({ kind: "relative", direction: "down", amount: "viewport" });
    expect(scrollDocumentViewInputSchema.parse({ kind: "edge", target: "bottom" })).toEqual({ kind: "edge", target: "bottom" });
    expect(() => scrollDocumentViewInputSchema.parse({ kind: "relative", direction: "down", amount: "viewport", pixels: 100 })).toThrow();
    expect(() => scrollDocumentViewInputSchema.parse({ kind: "relative", direction: "sideways", amount: "viewport" })).toThrow();
  });
});

// @vitest-environment jsdom

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const toBlob = vi.hoisted(() => vi.fn(async () => new Blob(["png"], { type: "image/png" })));
vi.mock("html-to-image", () => ({ toBlob }));

import { DocxPreviewDocumentSurface } from "./docx-preview-document-surface";

const viewport = (scrollTop: number) => {
  const root = document.createElement("div");
  root.className = "paper-stage";
  const content = document.createElement("div");
  content.className = "real-document-wrap";
  content.textContent = scrollTop ? "滚动后的文档内容" : "顶部文档内容";
  root.append(content);
  Object.defineProperties(root, {
    clientWidth: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 600 },
    scrollWidth: { configurable: true, value: 800 },
    scrollHeight: { configurable: true, value: 5000 },
    scrollTop: { configurable: true, value: scrollTop },
    scrollLeft: { configurable: true, value: 0 },
  });
  document.body.append(root);
  return root;
};

describe("DocxPreviewDocumentSurface visible capture", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    toBlob.mockClear();
  });

  it("captures the surface viewport instead of the document scroll height", async () => {
    const root = viewport(0);
    const result = await new DocxPreviewDocumentSurface(root, { ready: true, dirty: false, pageCount: 1, renderedRevision: "rev-1" }).captureVisible();

    expect(result).toMatchObject({ width: 800, height: 600, mimeType: "image/png" });
    expect(result.pageNumber).toBeUndefined();
    expect(toBlob).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({ width: 800, height: 600 }));
  });

  it("applies the current scroll offset to the cloned document content", async () => {
    const root = viewport(320);
    await new DocxPreviewDocumentSurface(root, { ready: true, dirty: false, pageCount: 1, renderedRevision: "rev-1" }).captureVisible();

    const calls = toBlob.mock.calls as unknown as Array<[HTMLElement, unknown]>;
    const clonedViewport = calls[0]?.[0];
    expect((clonedViewport.querySelector(".real-document-wrap") as HTMLElement | null)?.style.transform).toBe("translate(0px, -320px)");
    expect(clonedViewport.style.height).toBe("600px");
  });
});

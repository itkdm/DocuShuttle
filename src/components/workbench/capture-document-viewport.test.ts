// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const toBlob = vi.hoisted(() => vi.fn(async () => new Blob(["png"], { type: "image/png" })));
vi.mock("html-to-image", () => ({ toBlob }));

import { captureDocumentViewport } from "./capture-document-viewport";

const createViewport = (scrollTop = 0) => {
  const root = document.createElement("div");
  root.className = "paper-stage";
  const content = document.createElement("div");
  content.className = "document-content";
  content.textContent = "visible document";
  root.append(content);
  Object.defineProperties(root, {
    clientWidth: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 600 },
    scrollTop: { configurable: true, value: scrollTop },
    scrollLeft: { configurable: true, value: 0 },
  });
  document.body.append(root);
  return root;
};

describe("captureDocumentViewport", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    toBlob.mockReset();
    toBlob.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    vi.unstubAllGlobals();
  });

  it("keeps the capture host offscreen while rendering the viewport clone", async () => {
    const root = createViewport(320);
    toBlob.mockImplementationOnce(async (...args: unknown[]) => {
      const target = args[0] as HTMLElement;
      const host = target.parentElement;
      expect(host).not.toBeNull();
      expect(host?.style.position).toBe("fixed");
      expect(host?.style.left).toBe("-100000px");
      expect(host?.style.top).toBe("0px");
      expect(host?.style.width).toBe("800px");
      expect(host?.style.height).toBe("600px");
      expect(target).not.toBe(host);
      expect(target.querySelector(".document-content")?.textContent).toBe("visible document");
      expect((target.querySelector(".document-content") as HTMLElement).style.transform).toBe("translate(0px, -320px)");
      return new Blob(["png"], { type: "image/png" });
    });

    await expect(captureDocumentViewport(root)).resolves.toMatchObject({ width: 800, height: 600 });
    expect(document.body.querySelectorAll(".document-content")).toHaveLength(1);
    expect(document.body.querySelector(".document-content")).toBe(root.querySelector(".document-content"));
  });

  it("removes the offscreen host when toBlob fails", async () => {
    const root = createViewport();
    toBlob.mockRejectedValueOnce(new Error("toBlob failed"));

    await expect(captureDocumentViewport(root)).rejects.toThrow("toBlob failed");
    expect(document.body.querySelectorAll(".document-content")).toHaveLength(1);
    expect(document.body.querySelectorAll("div")).toHaveLength(2);
  });

  it("removes the offscreen host when an image cannot be fetched", async () => {
    const root = createViewport();
    const image = document.createElement("img");
    image.src = "/missing-image.png";
    root.querySelector(".document-content")?.append(image);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("image fetch failed"); }));

    await expect(captureDocumentViewport(root)).rejects.toThrow("image fetch failed");
    expect(document.body.querySelectorAll(".document-content")).toHaveLength(1);
    expect(document.body.querySelectorAll("div")).toHaveLength(2);
  });
});

// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { scrollDocumentViewport } from "./scroll-document-viewport";

function createViewport({ scrollTop = 0, scrollHeight = 3_000, clientHeight = 1_000 } = {}) {
  const canvas = document.createElement("div");
  canvas.className = "paper-stage";
  let current = scrollTop;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: clientHeight },
    scrollHeight: { configurable: true, value: scrollHeight },
    scrollTop: { configurable: true, get: () => current, set: (value: number) => { current = value; } },
  });
  document.body.append(canvas);
  return canvas;
}

describe("scrollDocumentViewport", () => {
  it("uses deterministic viewport-relative distances and reports real boundaries", async () => {
    const viewport = createViewport();
    const result = await scrollDocumentViewport(viewport, { kind: "relative", direction: "down", amount: "viewport" }, "rev-1");
    expect(result).toMatchObject({ revision: "rev-1", beforeScrollTop: 0, scrollTop: 800, maxScrollTop: 2_000, viewportHeight: 1_000, moved: true, atTop: false, atBottom: false });
    const retry = await scrollDocumentViewport(viewport, { kind: "relative", direction: "down", amount: "viewport" }, "rev-1", result.scrollTop);
    expect(retry.scrollTop).toBe(800);
  });

  it("supports small/up/edge commands and clamps without scroll space", async () => {
    const viewport = createViewport({ scrollTop: 1_900 });
    expect((await scrollDocumentViewport(viewport, { kind: "relative", direction: "up", amount: "small" }, "rev-1")).scrollTop).toBe(1_550);
    expect((await scrollDocumentViewport(viewport, { kind: "edge", target: "bottom" }, "rev-1")).atBottom).toBe(true);
    expect((await scrollDocumentViewport(viewport, { kind: "edge", target: "top" }, "rev-1")).atTop).toBe(true);

    const staticViewport = createViewport({ scrollHeight: 1_000, clientHeight: 1_000 });
    await expect(scrollDocumentViewport(staticViewport, { kind: "relative", direction: "down", amount: "small" }, "rev-1")).resolves.toMatchObject({ moved: false, atTop: true, atBottom: true, maxScrollTop: 0 });
  });

  it("resolves a paper-stage ancestor when called from a renderer host", async () => {
    const canvas = createViewport();
    const host = document.createElement("div");
    canvas.append(host);
    const result = await scrollDocumentViewport(host, { kind: "edge", target: "bottom" }, "rev-1");
    expect(result.scrollTop).toBe(2_000);
  });
});

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const toBlob = vi.hoisted(() => vi.fn(async () => new Blob(["png"], { type: "image/png" })));
const superDocInstances = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("html-to-image", () => ({ toBlob }));
vi.mock("superdoc", () => ({
  SuperDoc: class {
    destroy = vi.fn();
    constructor(options: Record<string, unknown>) {
      superDocInstances.push(options);
      queueMicrotask(() => (options.onReady as (() => void))());
    }
  },
}));

import { SuperDocDocumentViewer } from "./superdoc-document-viewer";

describe("SuperDocDocumentViewer", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    superDocInstances.length = 0;
    toBlob.mockClear();
  });

  it("mounts public read-only configuration and binds the actual revision", async () => {
    const stage = document.createElement("div");
    stage.className = "paper-stage";
    const content = document.createElement("div");
    content.textContent = "document";
    stage.append(content);
    Object.defineProperties(stage, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
    document.body.append(stage);

    const onReady = vi.fn();
    const viewer = await SuperDocDocumentViewer.mount(stage, new Blob(["docx"]), "revision-42", { onReady, onError: vi.fn() });
    await Promise.resolve();

    expect(superDocInstances[0]).toMatchObject({ documentMode: "viewing", role: "viewer", ui: false, hyperlinks: false, viewing: { comments: false, trackedChanges: "original" } });
    expect(viewer.getState()).toMatchObject({ ready: true, dirty: false, renderedRevision: "revision-42" });
    expect(viewer.getState().pageCount).toBeUndefined();
    expect(onReady).toHaveBeenCalledOnce();

    const onError = vi.fn();
    const failingViewer = await SuperDocDocumentViewer.mount(stage, new Blob(["docx"]), "revision-43", { onReady: vi.fn(), onError });
    await Promise.resolve();
    (superDocInstances[1]?.onException as (event: { error: Error }) => void)({ error: new Error("render failed") });
    expect(failingViewer.getState().ready).toBe(false);
    expect(onError).toHaveBeenCalledWith("SuperDoc 查看器错误：render failed");
  });

  it("captures the current viewport and can be destroyed", async () => {
    const canvas = document.createElement("div");
    canvas.className = "paper-stage";
    const stage = document.createElement("div");
    stage.className = "superdoc-viewer-host";
    stage.append(document.createElement("div"));
    canvas.append(stage);
    let currentScrollTop = 120;
    Object.defineProperties(canvas, { clientWidth: { value: 640 }, clientHeight: { value: 480 }, scrollHeight: { value: 1_000 }, scrollTop: { configurable: true, get: () => currentScrollTop, set: (value: number) => { currentScrollTop = value; } }, scrollLeft: { value: 0 } });
    document.body.append(canvas);

    const viewer = await SuperDocDocumentViewer.mount(stage, new Blob(["docx"]), "revision-1", { onReady: vi.fn(), onError: vi.fn() });
    await Promise.resolve();
    const capture = await viewer.captureVisible();
    expect(capture).toMatchObject({ width: 640, height: 480, mimeType: "image/png" });
    const clonedViewport = (toBlob.mock.calls as unknown as Array<[HTMLElement]>)[0]?.[0];
    expect((clonedViewport.querySelector(".superdoc-viewer-host") as HTMLElement).style.transform).toBe("translate(0px, -120px)");
    await expect(viewer.scrollViewport({ kind: "edge", target: "bottom" })).resolves.toMatchObject({ revision: "revision-1", scrollTop: 520, maxScrollTop: 520, atBottom: true });
    viewer.destroy();
    expect(viewer.getState()).toMatchObject({ ready: false, dirty: false, renderedRevision: "revision-1" });
  });
});

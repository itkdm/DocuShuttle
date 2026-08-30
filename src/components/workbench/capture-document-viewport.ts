import { toBlob } from "html-to-image";

export function resolveDocumentViewport(root: HTMLElement): HTMLElement | null {
  return root.matches(".paper-stage")
    ? root
    : root.closest<HTMLElement>(".paper-stage") ?? root.querySelector<HTMLElement>(".paper-stage");
}

const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const MAX_DIMENSION = 10_000;

export async function captureDocumentViewport(root: HTMLElement) {
  const viewport = resolveDocumentViewport(root);
  if (!viewport) throw new Error("DOCUMENT_VIEW_NOT_READY");
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) throw new Error("DOCUMENT_VIEW_CAPTURE_TOO_LARGE");
  const style = getComputedStyle(viewport);
  const captureHost = document.createElement("div");
  const clone = document.createElement("div");
  const content = viewport.firstElementChild?.cloneNode(true) as HTMLElement | null;
  if (!content) throw new Error("DOCUMENT_VIEW_CAPTURE_FAILED");
  Object.assign(clone.style, {
    position: "absolute", left: "0", top: "0", width: `${width}px`, height: `${height}px`, overflow: "hidden",
    margin: "0", padding: `${parseFloat(style.paddingTop) || 0}px ${parseFloat(style.paddingRight) || 0}px ${parseFloat(style.paddingBottom) || 0}px ${parseFloat(style.paddingLeft) || 0}px`,
    boxSizing: "border-box", background: style.background, pointerEvents: "none",
  });
  if (viewport.scrollTop || viewport.scrollLeft) content.style.transform = `translate(${-viewport.scrollLeft}px, ${-viewport.scrollTop}px)`;
  clone.append(content);
  Object.assign(captureHost.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    width: `${width}px`,
    height: `${height}px`,
    pointerEvents: "none",
  });
  captureHost.append(clone);
  document.body.append(captureHost);
  try {
    await Promise.all([...clone.querySelectorAll("img")].map(async (image) => {
      const source = image.getAttribute("src");
      if (!source || source.startsWith("data:")) return;
      const response = await fetch(source);
      if (!response.ok) throw new Error("DOCUMENT_VIEW_CAPTURE_IMAGE_UNREADABLE");
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      image.setAttribute("src", `data:${response.headers.get("content-type") || "image/png"};base64,${btoa(binary)}`);
    }));
    const blob = await toBlob(clone, { backgroundColor: "#ffffff", cacheBust: true, pixelRatio: 1, width, height });
    if (!blob || blob.type !== "image/png" || blob.size === 0) throw new Error("DOCUMENT_VIEW_CAPTURE_FAILED");
    if (blob.size > MAX_CAPTURE_BYTES) throw new Error("DOCUMENT_VIEW_CAPTURE_TOO_LARGE");
    return { blob, mimeType: "image/png" as const, width, height };
  } finally {
    captureHost.remove();
  }
}

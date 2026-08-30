// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveDocumentSurfacePreference } from "./document-surface-preference";

describe("resolveDocumentSurfacePreference", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllEnvs();
  });

  it("defaults to docx-preview and ignores invalid values", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(resolveDocumentSurfacePreference()).toBe("docx-preview");
    window.localStorage.setItem("paperduck.documentSurface", "invalid");
    expect(resolveDocumentSurfacePreference()).toBe("docx-preview");
  });

  it("allows SuperDoc only through the development preference", () => {
    vi.stubEnv("NODE_ENV", "development");
    window.localStorage.setItem("paperduck.documentSurface", "superdoc");
    expect(resolveDocumentSurfacePreference()).toBe("superdoc");

    vi.stubEnv("NODE_ENV", "production");
    expect(resolveDocumentSurfacePreference()).toBe("docx-preview");
  });
});

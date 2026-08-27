import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { OoxmlPreservationKernel } from "../ooxml-preservation-kernel";

const fixturePaths = (process.env.PAPERDUCK_PRIVATE_DOCX_FIXTURES ?? "")
  .split(path.delimiter)
  .map((value) => value.trim())
  .filter(Boolean);

describe.skipIf(fixturePaths.length === 0)("private real DOCX regression", () => {
  it("reopens, edits twice, and preserves package validity for every configured local fixture", async () => {
    const kernel = new OoxmlPreservationKernel();
    let storyFixtureCount = 0;

    for (const fixturePath of fixturePaths) {
      const source = Uint8Array.from(await readFile(fixturePath));
      let before;
      try {
        before = await kernel.inspect(source);
      } catch (error) {
        // The corpus intentionally includes a malformed/renamed DOCX. The
        // upload boundary must reject it with a stable ZIP error, not make
        // the entire corpus test fail before valid fixtures are exercised.
        expect(error, fixturePath).toMatchObject({ code: expect.stringMatching(/^ZIP_/) });
        continue;
      }
      expect(before.diagnostics.filter(({ severity }) => severity === "error"), fixturePath).toEqual([]);

      const noOp = await kernel.mutate(source, {
        expectedRevision: before.manifest.revision,
        operations: [],
      });
      expect(noOp.bytes, fixturePath).toEqual(source);

      const target = before.tableCells.find(({ text }) => text.length > 0);
      expect(target, `${fixturePath} needs a non-empty table cell for the two-round regression`).toBeDefined();
      if (!target) continue;

      const marker = `${target.text} [PaperDuck local regression]`;
      const first = await kernel.mutate(source, {
        expectedRevision: before.manifest.revision,
        operations: [{
          kind: "set-cell-text",
          address: target.address,
          expectedText: target.text,
          expectedHash: target.address.fingerprint,
          text: marker,
        }],
      });
      const reopened = await kernel.validate(first.bytes);
      expect(reopened.diagnostics.filter(({ severity }) => severity === "error"), fixturePath).toEqual([]);
      const secondTarget = reopened.tableCells.find(({ address }) =>
        address.entry === target.address.entry && address.path === target.address.path,
      );
      expect(secondTarget?.text, fixturePath).toBe(marker);
      if (!secondTarget) continue;

      const second = await kernel.mutate(first.bytes, {
        expectedRevision: reopened.manifest.revision,
        operations: [{
          kind: "set-cell-text",
          address: secondTarget.address,
          expectedText: marker,
          expectedHash: secondTarget.address.fingerprint,
          text: target.text,
        }],
      });
      const finalInspection = await kernel.validate(second.bytes);
      expect(finalInspection.diagnostics.filter(({ severity }) => severity === "error"), fixturePath).toEqual([]);
      expect(
        finalInspection.tableCells.find(({ address }) =>
          address.entry === target.address.entry && address.path === target.address.path,
        )?.text,
        fixturePath,
      ).toBe(target.text);

      if (before.paragraphs.some(({ address }) => /word\/(?:header|footer)\d+\.xml/.test(address.entry))) {
        storyFixtureCount += 1;
      }
    }

    if (process.env.PAPERDUCK_REQUIRE_HEADER_FOOTER === "1") {
      expect(storyFixtureCount).toBeGreaterThan(0);
    }
  }, 120_000);
});

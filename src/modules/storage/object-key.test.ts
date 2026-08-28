import { describe, expect, it } from "vitest";

import { assertTaskObjectKey, buildTaskObjectKey } from "./object-key";
import { buildStableArtifactStem } from "./artifact-name";

describe("PaperDuck OSS object keys", () => {
  it("builds a tenant and task scoped key", () => {
    const key = buildTaskObjectKey({
      userId: "user-1",
      taskId: "task-1",
      category: "versions",
      fileName: "v2.docx",
    });
    expect(key).toBe("users/user-1/tasks/task-1/versions/v2.docx");
    expect(assertTaskObjectKey(key)).toBe(key);
  });

  it.each([
    "users/user-1/tasks/task-1/versions/../secret",
    "public/task.docx",
    "users/user-1/tasks/task-1/unknown/file.docx",
    "users/user-1/tasks/task-1/versions/folder/file.docx",
  ])("rejects an unsafe key: %s", (key) => {
    expect(() => assertTaskObjectKey(key)).toThrow(/namespace/);
  });

  it("derives stable safe stems from arbitrary idempotency keys", () => {
    const first = buildStableArtifactStem("run-uuid:call/with:special?chars");
    const second = buildStableArtifactStem("run-uuid:call/with:special?chars");
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    for (const category of ["versions", "manifests"] as const) {
      const key = buildTaskObjectKey({ userId: "user-1", taskId: "task-1", category, fileName: `${first}.${category === "versions" ? "docx" : "json"}` });
      expect(assertTaskObjectKey(key)).toBe(key);
      expect(key).not.toMatch(/[%:\\?]/);
    }
    expect(buildStableArtifactStem("different-key")).not.toBe(first);
  });
});

import { describe, expect, it } from "vitest";

import { assertTaskObjectKey, buildTaskObjectKey } from "./object-key";

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
});

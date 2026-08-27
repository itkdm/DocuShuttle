import { describe, expect, it, vi } from "vitest";

import type { TaskRecord, TaskSourceRecord, TaskSummary } from "../domain";
import { GetTaskWorkspace } from "../get-task-workspace";
import { ListTasks } from "../list-tasks";
import type { TaskRepositoryPort } from "../ports";
import { fileNameForTask, taskIdFromPathname, taskUrl } from "../task-url";

const task = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: "0872a73c-d403-429c-9ca7-d0e629b36c69",
  workspaceId: "workspace-1",
  title: "实验报告",
  goal: "完成文档",
  status: "ready",
  ...overrides,
});

const source = (overrides: Partial<TaskSourceRecord> = {}): TaskSourceRecord => ({
  id: "source-1",
  role: "template",
  originalName: "实验模板.docx",
  byteLength: 2048,
  ...overrides,
});

const createTasks = (overrides: Partial<TaskRepositoryPort> = {}): TaskRepositoryPort => ({
  create: vi.fn(),
  listByOwner: vi.fn().mockResolvedValue([]),
  getWorkspace: vi.fn().mockResolvedValue(undefined),
  belongsToOwner: vi.fn().mockResolvedValue(true),
  registerSource: vi.fn(),
  ...overrides,
});

describe("task URL", () => {
  it("treats / as a blank workspace with no task identity", () => {
    expect(taskIdFromPathname("/")).toBeUndefined();
    expect(taskIdFromPathname("/t/")).toBeUndefined();
    expect(taskIdFromPathname("/t/not-a-uuid")).toBeUndefined();
  });

  it("reads a task identity only from /t/:taskId", () => {
    const id = "0872a73c-d403-429c-9ca7-d0e629b36c69";
    expect(taskUrl(id)).toBe(`/t/${id}`);
    expect(taskIdFromPathname(`/t/${id}`)).toBe(id);
    expect(taskIdFromPathname(`/t/${id}/`)).toBe(id);
  });

  it("prefers the template file name for a restored task", () => {
    expect(fileNameForTask({
      title: "实验报告",
      sources: [source({ role: "example", originalName: "完成示例.docx" }), source()],
    })).toBe("实验模板.docx");
  });
});

describe("ListTasks", () => {
  it("returns the owner's recent tasks without opening one", async () => {
    const summaries: TaskSummary[] = [{
      id: task().id,
      title: "实验报告",
      status: "ready",
      updatedAt: "2026-08-27T10:00:00.000Z",
      fileName: "实验模板.docx",
    }];
    const tasks = createTasks({ listByOwner: vi.fn().mockResolvedValue(summaries) });
    await expect(new ListTasks(tasks).execute("user-1")).resolves.toEqual(summaries);
    expect(tasks.listByOwner).toHaveBeenCalledWith("user-1");
  });
});

describe("GetTaskWorkspace", () => {
  it("returns undefined when the task does not belong to the caller", async () => {
    await expect(new GetTaskWorkspace(createTasks()).execute({
      taskId: task().id,
      ownerUserId: "user-1",
    })).resolves.toBeUndefined();
  });

  it("hydrates a workspace snapshot for an explicit task URL", async () => {
    const tasks = createTasks({
      getWorkspace: vi.fn().mockResolvedValue({
        task: task(),
        sources: [source()],
        workingDocumentId: "working-1",
        latestRunId: "run-1",
      }),
    });
    await expect(new GetTaskWorkspace(tasks).execute({
      taskId: task().id,
      ownerUserId: "user-1",
    })).resolves.toMatchObject({
      task: task(),
      workingDocumentId: "working-1",
      latestRunId: "run-1",
      fileName: "实验模板.docx",
    });
  });
});

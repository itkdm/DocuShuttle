import type { TaskWorkspace } from "./domain";
import { fileNameForTask } from "./task-url";
import type { TaskRepositoryPort } from "./ports";

export class GetTaskWorkspace {
  constructor(private readonly tasks: TaskRepositoryPort) {}

  async execute(input: { taskId: string; ownerUserId: string }): Promise<TaskWorkspace | undefined> {
    const workspace = await this.tasks.getWorkspace(input.taskId, input.ownerUserId);
    if (!workspace) return undefined;
    return {
      ...workspace,
      fileName: fileNameForTask({ title: workspace.task.title, sources: workspace.sources }),
    };
  }
}

import type { TaskSummary } from "./domain";
import type { TaskRepositoryPort } from "./ports";

export class ListTasks {
  constructor(private readonly tasks: TaskRepositoryPort) {}

  execute(ownerUserId: string, options?: { limit?: number; offset?: number }): Promise<TaskSummary[]> {
    return options ? this.tasks.listByOwner(ownerUserId, options) : this.tasks.listByOwner(ownerUserId);
  }
}

import type { TaskSummary } from "./domain";
import type { TaskRepositoryPort } from "./ports";

export class ListTasks {
  constructor(private readonly tasks: TaskRepositoryPort) {}

  execute(ownerUserId: string): Promise<TaskSummary[]> {
    return this.tasks.listByOwner(ownerUserId);
  }
}

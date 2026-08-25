import type { TaskRepositoryPort } from "./ports";

export class CreateTask {
  constructor(private readonly tasks: TaskRepositoryPort) {}

  execute(input: { ownerUserId: string; title: string; goal: string }) {
    return this.tasks.create({
      ownerUserId: input.ownerUserId,
      title: input.title.trim(),
      goal: input.goal.trim(),
    });
  }
}

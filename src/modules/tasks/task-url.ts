const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const taskUrl = (taskId: string) => `/t/${taskId}`;

export function isTaskId(value: string): boolean {
  return TASK_ID.test(value);
}

export function taskIdFromPathname(pathname: string): string | undefined {
  const match = /^\/t\/([^/]+)\/?$/.exec(pathname);
  const taskId = match?.[1];
  if (!taskId || !isTaskId(taskId)) return undefined;
  return taskId;
}

export function fileNameForTask(input: { title: string; sources: ReadonlyArray<{ role: string; originalName: string }> }): string {
  const template = input.sources.find((source) => source.role === "template");
  const example = input.sources.find((source) => source.role === "example");
  const original = template?.originalName ?? example?.originalName;
  if (original) return original;
  return input.title.toLowerCase().endsWith(".docx") ? input.title : `${input.title}.docx`;
}

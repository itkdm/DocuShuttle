import { InvalidObjectKeyError } from "./ports";

const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const safeFilePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/;

export const buildTaskObjectKey = (input: {
  userId: string;
  taskId: string;
  category: "sources" | "versions" | "assets" | "exports" | "manifests";
  fileName: string;
}) => {
  if (!idPattern.test(input.userId) || !idPattern.test(input.taskId)) {
    throw new InvalidObjectKeyError("Invalid user or task identifier");
  }
  if (!safeFilePattern.test(input.fileName) || input.fileName.includes("..")) {
    throw new InvalidObjectKeyError("Invalid object file name");
  }
  return `users/${input.userId}/tasks/${input.taskId}/${input.category}/${input.fileName}`;
};

export const assertTaskObjectKey = (objectKey: string) => {
  const parts = objectKey.split("/");
  if (
    parts.length !== 6 ||
    parts[0] !== "users" ||
    !idPattern.test(parts[1] ?? "") ||
    parts[2] !== "tasks" ||
    !idPattern.test(parts[3] ?? "") ||
    !["sources", "versions", "assets", "exports", "manifests"].includes(parts[4] ?? "") ||
    !safeFilePattern.test(parts[5] ?? "")
  ) {
    throw new InvalidObjectKeyError("Object key is outside the PaperDuck task namespace");
  }
  return objectKey;
};

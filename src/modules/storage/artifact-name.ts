import { createHash } from "node:crypto";

/** Derive a stable, validator-safe filename stem from an arbitrary idempotency key. */
export const buildStableArtifactStem = (idempotencyKey: string) => createHash("sha256").update(idempotencyKey, "utf8").digest("hex");

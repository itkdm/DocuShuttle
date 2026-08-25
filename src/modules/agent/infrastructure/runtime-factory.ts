import type { SupabaseClient } from "@supabase/supabase-js";

import { OoxmlPreservationKernel } from "@/modules/documents";
import { createDeepSeekAdapterFromEnvironment } from "@/modules/generation/adapters/deepseek";
import { SupabaseStorageAdapter } from "@/modules/storage/adapters/supabase-storage";

import { AgentRuntime } from "../application/runtime";
import { PaperDuckStepExecutor } from "./paperduck-step-executor";
import {
  StorageCancelledEffectReconciler,
  SupabaseAgentRunStore,
  SupabaseDocumentVersionCommit,
  SupabaseEffectReceiptStore,
} from "./supabase/runtime-persistence";

export const createAgentRuntime = (client: SupabaseClient, runId: string) => {
  const storage = new SupabaseStorageAdapter(client);
  return new AgentRuntime(
    new SupabaseAgentRunStore(client),
    new PaperDuckStepExecutor(
      client,
      storage,
      new OoxmlPreservationKernel(),
      createDeepSeekAdapterFromEnvironment(),
    ),
    new SupabaseEffectReceiptStore(client, runId),
    new SupabaseDocumentVersionCommit(client),
    new StorageCancelledEffectReconciler(storage),
    { now: () => new Date().toISOString() },
    { next: (prefix) => `${prefix}_${crypto.randomUUID()}` },
  );
};

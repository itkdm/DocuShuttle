import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { performance } from "node:perf_hooks";

import { logger } from "@/infrastructure/observability";
import { getSupabasePublicEnvironment } from "./environment";

export const createSupabaseServerClient = async () => {
  const cookieStore = await cookies();
  const environment = getSupabasePublicEnvironment();

  return createServerClient(environment.url, environment.publishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components cannot write cookies. The root proxy refreshes
          // sessions; Server Actions and Route Handlers can write them here.
        }
      },
    },
  });
};

export const requireSupabaseIdentity = async () => {
  const started = performance.now();
  const client = await createSupabaseServerClient();
  const { data, error } = await client.auth.getClaims();
  const userId = data?.claims?.sub;
  if (error || typeof userId !== "string" || userId.trim().length === 0) throw new Error("AUTHENTICATION_REQUIRED");
  logger.info("server.auth.identity.completed", { durationMs: performance.now() - started, strategy: "claims" });
  return { client, userId };
};

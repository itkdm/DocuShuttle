import { createBrowserClient } from "@supabase/ssr";

import { getSupabasePublicEnvironment } from "./environment";

let browserClient: ReturnType<typeof createBrowserClient> | undefined;

export const getSupabaseBrowserClient = () => {
  if (!browserClient) {
    const environment = getSupabasePublicEnvironment();
    browserClient = createBrowserClient(environment.url, environment.publishableKey);
  }
  return browserClient;
};

export const ensureAnonymousSession = async () => {
  const client = getSupabaseBrowserClient();
  const { data: existing, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  if (existing.session) return existing.session;

  const { data, error } = await client.auth.signInAnonymously();
  if (error) throw error;
  if (!data.session) throw new Error("Supabase did not create an anonymous session");
  return data.session;
};

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

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

export const requireSupabaseUser = async () => {
  const client = await createSupabaseServerClient();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new Error("AUTHENTICATION_REQUIRED");
  return { client, user: data.user };
};

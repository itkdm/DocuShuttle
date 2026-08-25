const requirePublicEnvironment = (name: string, value: string | undefined) => {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

export const getSupabasePublicEnvironment = () => ({
  url: requirePublicEnvironment("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
  publishableKey: requirePublicEnvironment(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  ),
});

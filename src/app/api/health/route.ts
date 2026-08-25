import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  const checks = {
    supabase: Boolean(
      process.env.NEXT_PUBLIC_SUPABASE_URL &&
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    ),
    objectStorage: Boolean(
      process.env.NEXT_PUBLIC_SUPABASE_URL &&
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    ),
    textProvider: Boolean(process.env.DEEPSEEK_API_KEY),
    imageProvider: Boolean(process.env.APIMART_API_KEY),
  };

  return NextResponse.json(
    {
      ok: true,
      service: "paperduck",
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? "development",
      configured: checks,
      timestamp: new Date().toISOString(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

import { NextResponse } from "next/server";

export function POST() {
  if (process.env.NODE_ENV === "production") return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ accepted: true });
}

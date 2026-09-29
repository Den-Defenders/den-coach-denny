import { NextResponse } from "next/server";
import { canViewOwner } from "@/lib/ownerAccess";

export async function GET() {
  const allowed = await canViewOwner();
  return NextResponse.json({ allowed }, { headers: { "Cache-Control": "private, no-store" } });
}

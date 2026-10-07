import { NextResponse } from "next/server";
import { navFor } from "@/lib/access";
import { getCurrentAccess } from "@/lib/currentAccess";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await getCurrentAccess();
  const headers = { "Cache-Control": "private, no-store" };
  if (!access) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });

  return NextResponse.json({
    displayName: access.displayName,
    role: access.role,
    nav: navFor(access.role),
    technicianName: access.member?.stTechnicianName ?? null,
  }, { headers });
}

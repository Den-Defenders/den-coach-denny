/** GET /api/sms/results?days=30 — "Lead results" report (owners + managers; read-only). */
import { NextResponse } from "next/server";
import { getCurrentAccess } from "@/lib/currentAccess";
import { leadResults } from "@/lib/sms/leadResults";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await getCurrentAccess();
  if (access?.role !== "owner" && access?.role !== "manager") return NextResponse.json({ error: "Owners and managers only." }, { status: 403 });
  const days = Number(new URL(request.url).searchParams.get("days")) || 30;
  try {
    return NextResponse.json(await leadResults(days), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Couldn't build the report." }, { status: 500 });
  }
}

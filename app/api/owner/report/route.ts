import { NextResponse } from "next/server";
import { auth0 } from "@/lib/auth0";
import { canViewOwner } from "@/lib/ownerAccess";
import { latestOwnerReport, saveOwnerReport } from "@/lib/ownerStore";
import { parseOwnerReport } from "@/lib/ownerReport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!await canViewOwner()) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    return NextResponse.json({ report: await latestOwnerReport(), configured: Boolean(process.env.OWNER_DATABASE_URL) },
      { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Report storage unavailable." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  if (!await canViewOwner()) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 1_000_000) return NextResponse.json({ error: "JSON exceeds 1 MB." }, { status: 413 });
    const body = await request.text();
    if (body.length > 1_000_000) return NextResponse.json({ error: "JSON exceeds 1 MB." }, { status: 413 });
    const report = parseOwnerReport(JSON.parse(body));
    const session = await auth0.getSession();
    await saveOwnerReport(report, String(session?.user?.sub || "unknown"));
    return NextResponse.json({ ok: true, weekly: report.weekly.length, daily: report.daily.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid report.";
    return NextResponse.json({ error: message }, { status: /not configured|database/i.test(message) ? 503 : 400 });
  }
}

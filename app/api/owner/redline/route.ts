import { NextResponse } from "next/server";
import { auth0 } from "@/lib/auth0";
import { canViewOwner } from "@/lib/ownerAccess";
import { currentRedlineGoal, latestRedlineSnapshot, liveRedlineSnapshot, saveRedlineSnapshot } from "@/lib/ownerStore";
import { parseRedlineSnapshot } from "@/lib/ownerRedline";
import { pacificDay } from "@/lib/ownerRedlineLive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function configured() {
  return Boolean(process.env.OWNER_DATABASE_URL || process.env.OWNER_DATABASE_DATABASE_URL);
}

export async function GET() {
  if (!await canViewOwner()) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const headers = { "Cache-Control": "private, no-store" };
  let goal;
  try {
    goal = await currentRedlineGoal();
  } catch {
    return NextResponse.json({ error: "Redline storage unavailable." }, { status: 503 });
  }
  const today = pacificDay(Date.now());
  const base = { goal, today, configured: configured() };
  // A goal whose date has come doesn't break the card: it asks for a new goal.
  if (goal.targetDate <= today) {
    return NextResponse.json({ ...base, snapshot: null, live: false, goalPassed: true }, { headers });
  }
  // Nightly ServiceTitan snapshots first (updates on its own every night).
  // An imported snapshot is only the fallback when the live numbers can't be built.
  let liveProblem: string | null = null;
  try {
    const live = await liveRedlineSnapshot(goal);
    if (live) return NextResponse.json({ ...base, snapshot: live, live: true }, { headers });
    liveProblem = "No nightly snapshots were found.";
  } catch (error) {
    liveProblem = error instanceof Error ? error.message.slice(0, 300) : "The nightly numbers could not be built.";
    console.error("[owner-redline] live build failed:", error);
  }
  try {
    let imported = await latestRedlineSnapshot();
    if (imported && goal.targetDate > imported.snapshotDate) {
      imported = { ...imported, redline: goal.redline, targetDate: goal.targetDate };
    }
    return NextResponse.json({ ...base, snapshot: imported, live: false, liveProblem }, { headers });
  } catch {
    return NextResponse.json({ error: "Redline storage unavailable." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  if (!await canViewOwner()) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 200_000) return NextResponse.json({ error: "JSON exceeds 200 KB." }, { status: 413 });
    const body = await request.text();
    if (body.length > 200_000) return NextResponse.json({ error: "JSON exceeds 200 KB." }, { status: 413 });
    const snapshot = parseRedlineSnapshot(JSON.parse(body));
    const session = await auth0.getSession();
    await saveRedlineSnapshot(snapshot, String(session?.user?.sub || "unknown"));
    return NextResponse.json({ ok: true, snapshotDate: snapshot.snapshotDate });
  } catch (error) {
    const message = error instanceof SyntaxError ? "That file is not valid JSON." : error instanceof Error ? error.message : "Invalid snapshot.";
    return NextResponse.json({ error: message }, { status: /not configured|database/i.test(message) ? 503 : 400 });
  }
}

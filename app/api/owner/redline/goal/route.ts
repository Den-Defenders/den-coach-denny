import { NextResponse } from "next/server";
import { auth0 } from "@/lib/auth0";
import { canViewOwner } from "@/lib/ownerAccess";
import { saveRedlineGoal } from "@/lib/ownerStore";
import { parseRedlineGoal } from "@/lib/ownerRedline";
import { pacificDay } from "@/lib/ownerRedlineLive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Owner-only: set the redline amount and goal date shown on the dashboard. */
export async function POST(request: Request) {
  if (!await canViewOwner()) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const body = await request.text();
    if (body.length > 2_000) return NextResponse.json({ error: "Request too large." }, { status: 413 });
    const goal = parseRedlineGoal(JSON.parse(body), pacificDay(Date.now()));
    const session = await auth0.getSession();
    const who = String(session?.user?.email || session?.user?.sub || "unknown");
    await saveRedlineGoal(goal, who);
    return NextResponse.json({ ok: true, goal });
  } catch (error) {
    const message = error instanceof SyntaxError ? "That request was not valid." : error instanceof Error ? error.message : "Could not save the goal.";
    return NextResponse.json({ error: message }, { status: /not configured|database/i.test(message) ? 503 : 400 });
  }
}

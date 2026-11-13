/**
 * GET /api/sms/inbox/scoreboard?period=today|7|30
 *
 * Session 7 PR 4: the manager scoreboard (owners + managers only). See lib/sms/scoreboard.ts
 * for what each number means. Reachable only by Texting inbox users (proxy.ts rule for
 * /api/sms/inbox); the role check here keeps CSRs out.
 */
import { NextResponse } from "next/server";
import { canAccessTextingInbox, canUseTextingInbox } from "@/lib/access";
import { getCurrentAccess } from "@/lib/currentAccess";
import { buildScoreboard, periodStart } from "@/lib/sms/scoreboard";
import { smsNow } from "@/lib/sms/send";
import { listTeamMembers, teamDatabaseConfigured } from "@/lib/teamStore";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const access = await getCurrentAccess();
  if (!access || !canAccessTextingInbox(access) || (access.role !== "owner" && access.role !== "manager")) {
    return NextResponse.json({ error: "Only owners and managers can see the scoreboard." }, { status: 403, headers: NO_STORE });
  }
  try {
    const url = new URL(request.url);
    const period = url.searchParams.get("period") === "today" ? "today" : url.searchParams.get("period") === "30" ? "30" : "7";
    const now = smsNow();
    let team: { email: string; name: string; role: string }[] = [];
    if (teamDatabaseConfigured()) {
      team = (await listTeamMembers())
        .filter((m) => m.active && canUseTextingInbox(m.role))
        .map((m) => ({ email: m.email.toLowerCase(), name: m.displayName || m.email.split("@")[0], role: m.role }));
    }
    // CSRs and managers always get a row (even all zeros); owners only when they did something.
    const board = await buildScoreboard(periodStart(period, now), now, team.filter((m) => m.role !== "owner").map((m) => m.email));
    const byEmail = new Map(team.map((m) => [m.email, m]));
    return NextResponse.json({
      period,
      since: board.since,
      rows: board.rows.map((r) => ({
        ...r,
        name: byEmail.get(r.email)?.name || r.email.split("@")[0],
        role: byEmail.get(r.email)?.role || null,
      })),
    }, { headers: NO_STORE });
  } catch (error) {
    console.error("SMS scoreboard failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "The scoreboard couldn't load. Try again in a minute." }, { status: 500, headers: NO_STORE });
  }
}

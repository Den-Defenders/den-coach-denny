/**
 * GET /api/sms/inbox/count -> { followUpsDue }
 *
 * Session 7 (Steven, 2026-11-13): the Texting menu tile shows "Texting (3)" when the
 * signed-in person has follow-ups due (their own customers only, managers included).
 * No Slack reminder; the count is the nudge.
 */
import { NextResponse } from "next/server";
import { canAccessTextingInbox } from "@/lib/access";
import { getCurrentAccess } from "@/lib/currentAccess";
import { followUpList } from "@/lib/sms/folders";
import { smsNow } from "@/lib/sms/send";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  const access = await getCurrentAccess();
  if (!access?.email || !canAccessTextingInbox(access)) return NextResponse.json({ followUpsDue: 0 }, { headers: NO_STORE });
  try {
    const due = (await followUpList(access.email, smsNow())).filter((f) => f.reason !== "scheduled").length;
    return NextResponse.json({ followUpsDue: due }, { headers: NO_STORE });
  } catch (error) {
    console.error("SMS follow-up count failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ followUpsDue: 0 }, { headers: NO_STORE });
  }
}

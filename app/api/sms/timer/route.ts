/**
 * /api/sms/timer — the texting timer (build step 5). Sends every drip text
 * and AI follow-up that's due. Called every 15 minutes by GitHub Actions
 * (.github/workflows/sms-timer.yml) with "Authorization: Bearer <SMS_TIMER_SECRET>".
 *
 * Public in proxy.ts (no login); rejects any request without the secret.
 * Safe to call often: each lead is leased while it's worked on, and every text
 * still goes through the one send helper (hours, holidays, caps, opt-outs).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runDueDrips } from "@/lib/sms/drip";
import { runDueFollowUps } from "@/lib/sms/followup";
import { smsDatabaseConfigured } from "@/lib/sms/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };
const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();

function authorized(request: Request): boolean {
  const secret = (process.env.SMS_TIMER_SECRET || "").trim();
  if (secret.length < 24) return false;
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return Boolean(given) && timingSafeEqual(digest(given), digest(secret));
}

async function run(request: Request) {
  if (!(process.env.SMS_TIMER_SECRET || "").trim()) {
    return NextResponse.json({ ok: false, error: "SMS_TIMER_SECRET is not set." }, { status: 503, headers: NO_STORE });
  }
  if (!authorized(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  if (!smsDatabaseConfigured()) return NextResponse.json({ ok: false, error: "Texting database is not configured." }, { status: 503, headers: NO_STORE });
  try {
    const drips = await runDueDrips({ budgetMs: 25_000 });
    const followUps = await runDueFollowUps({ budgetMs: 25_000 });
    return NextResponse.json({ ok: true, drips, followUps }, { headers: NO_STORE });
  } catch (error) {
    console.error("SMS timer failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: "Timer run failed." }, { status: 500, headers: NO_STORE });
  }
}

export const POST = run;
export const GET = run;

/**
 * /api/sms/timer — the texting timer (build step 5). Sends every drip text
 * and AI follow-up that's due, and (Session 7) puts owned chats back in the shared
 * queue when the owner didn't reply within 1 team hour. Called every 5 minutes by
 * cron-job.org (GitHub Actions .github/workflows/sms-timer.yml is the backup) with
 * "Authorization: Bearer <SMS_TIMER_SECRET>".
 *
 * Public in proxy.ts (no login); rejects any request without the secret.
 * Safe to call often: each lead is leased while it's worked on, and every text
 * still goes through the one send helper (hours, holidays, caps, opt-outs).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runDueDrips } from "@/lib/sms/drip";
import { runDueFollowUps } from "@/lib/sms/followup";
import { runAutoReleases } from "@/lib/sms/ownership";
import { smsNow } from "@/lib/sms/send";
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
    // Releases first: they're quick, and a slow drip run must never hold them up.
    const releases = await runAutoReleases(smsNow(), { budgetMs: 8_000 }).catch((error) => {
      console.error("SMS auto-release failed:", error instanceof Error ? error.message : error);
      return { checked: 0, released: 0, phones: [], error: "failed" };
    });
    const drips = await runDueDrips({ budgetMs: 22_000 });
    const followUps = await runDueFollowUps({ budgetMs: 22_000 });
    return NextResponse.json({ ok: true, releases: { checked: releases.checked, released: releases.released }, drips, followUps }, { headers: NO_STORE });
  } catch (error) {
    console.error("SMS timer failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: "Timer run failed." }, { status: 500, headers: NO_STORE });
  }
}

export const POST = run;
export const GET = run;

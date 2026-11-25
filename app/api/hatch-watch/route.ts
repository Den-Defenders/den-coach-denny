/**
 * /api/hatch-watch — the daily "did Hatch miss any leads?" check (lib/sms/hatchWatch.ts).
 *
 * Called by GitHub Actions (.github/workflows/hatch-watch.yml) every 30 minutes in the
 * morning with "Authorization: Bearer <SMS_TIMER_SECRET>" (same secret as the texting timer).
 * Public in proxy.ts (no login); rejects any request without the secret.
 * Safe to call often: it only checks leads the stored Hatch copy covers, and posts the
 * Slack summary once everything covered has been checked.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runHatchWatch } from "@/lib/sms/hatchWatch";
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
    const result = await runHatchWatch(new Date(), { budgetMs: 40_000 });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    console.error("Hatch watch failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: "Hatch watch run failed." }, { status: 500, headers: NO_STORE });
  }
}

export const POST = run;
export const GET = run;

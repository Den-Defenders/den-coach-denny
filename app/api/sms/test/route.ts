/**
 * /api/sms/test — owners only (proxy.ts + the check below).
 *   GET  -> texting settings, recent texts, opt-outs and the guardrail log
 *   POST -> send one test text through the real send helper (all rules apply)
 */
import { NextResponse } from "next/server";
import { getCurrentAccess } from "@/lib/currentAccess";
import { formatPhone, type SendKind } from "@/lib/sms/rules";
import { allowList, promoTextsEnabled, sendSms, sendingEnabled, smsLimits } from "@/lib/sms/send";
import { recentActivity, smsDatabaseConfigured } from "@/lib/sms/store";
import { messagingConfig, webhookBaseUrl } from "@/lib/sms/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

async function requireOwner() {
  const access = await getCurrentAccess();
  return access?.role === "owner" ? access : null;
}

function settings() {
  const allowed = allowList();
  const base = webhookBaseUrl();
  return {
    sendingEnabled: sendingEnabled(),
    twilioConfigured: Boolean(messagingConfig()),
    databaseConfigured: smsDatabaseConfigured(),
    webhookBaseUrl: base,
    inboundUrl: base ? `${base}/api/sms/inbound` : null,
    statusUrl: base ? `${base}/api/sms/status` : null,
    allowList: allowed.everyone ? "Everyone (*)" : allowed.numbers.length ? allowed.numbers.map(formatPhone).join(", ") : "Nobody yet",
    promoTextsEnabled: promoTextsEnabled(),
    limits: smsLimits(),
  };
}

export async function GET() {
  if (!await requireOwner()) return NextResponse.json({ error: "Owners only." }, { status: 403, headers: NO_STORE });
  if (!smsDatabaseConfigured()) return NextResponse.json({ settings: settings(), messages: [], optOuts: [], audit: [] }, { headers: NO_STORE });
  try {
    return NextResponse.json({ settings: settings(), ...(await recentActivity(50)) }, { headers: NO_STORE });
  } catch (error) {
    console.error("SMS test GET failed:", error);
    return NextResponse.json({ error: "Could not load texting activity.", settings: settings() }, { status: 500, headers: NO_STORE });
  }
}

const TEST_KINDS: SendKind[] = ["manual", "reply", "automated"];

export async function POST(request: Request) {
  const access = await requireOwner();
  if (!access) return NextResponse.json({ error: "Owners only." }, { status: 403, headers: NO_STORE });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
  const kind = TEST_KINDS.includes(body.kind as SendKind) ? (body.kind as SendKind) : "manual";
  try {
    const result = await sendSms({
      to: String(body.to || ""),
      body: String(body.body || ""),
      kind,
      purpose: body.purpose === "marketing" ? "marketing" : "care",
      sentBy: access.email || "owner",
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 422, headers: NO_STORE });
  } catch (error) {
    console.error("SMS test send failed:", error);
    return NextResponse.json({ ok: false, reason: "error", message: "Something went wrong sending the text." }, { status: 500, headers: NO_STORE });
  }
}

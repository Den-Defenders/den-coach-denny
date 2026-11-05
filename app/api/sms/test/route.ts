/**
 * /api/sms/test — owners only (proxy.ts + the check below).
 *   GET  -> texting settings, recent texts, opt-outs and the guardrail log
 *   POST -> send one test text through the real send helper (all rules apply)
 *   POST {action:"resume_bot", phone} -> turn the AI back on for a number after a handoff
 * GET also returns the newest Zapier leads (/api/leads, step 5) with every field.
 *   POST {action:"reset_lead_test", phone, skipServiceTitan} -> let the next lead for this test
 *        number start a fresh drip (texts stay); optionally skip the ServiceTitan check for it
 * Session 6 PR 2 (Hatch opt-outs, lib/sms/hatchOptOuts.ts):
 *   POST {action:"hatch_scan", start, end} -> scan one window of stored Hatch texts for STOP/START
 *   POST {action:"hatch_summary"}          -> counts + masked samples (no full numbers)
 *   POST {action:"hatch_import"}           -> add the STOP numbers to Denny's opt-out list
 *   POST {action:"hatch_clear_scan"}       -> forget the scan results (the opt-out list stays)
 */
import { NextResponse } from "next/server";
import { getCurrentAccess } from "@/lib/currentAccess";
import { botEnabled, botModel } from "@/lib/sms/bot";
import { dripEnabled, DRIP_STEPS } from "@/lib/sms/drip";
import { consentSources, leadsMode, leadsSecretConfigured, recentLeads, resetLeadForTest } from "@/lib/sms/leads";
import { formatPhone, normalizePhone, type SendKind } from "@/lib/sms/rules";
import { allowList, promoTextsEnabled, sendSms, sendingEnabled, smsLimits } from "@/lib/sms/send";
import { audit, recentActivity, resumeBot, smsDatabaseConfigured } from "@/lib/sms/store";
import { clearHatchScan, hatchOptOutSummary, importHatchOptOuts, scanHatchWindow } from "@/lib/sms/hatchOptOuts";
import { messagingConfig, webhookBaseUrl } from "@/lib/sms/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A Hatch scan window runs about 13 read-only searches.
export const maxDuration = 120;

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
    botEnabled: botEnabled(),
    botModel: botModel(),
    openAiConfigured: Boolean(process.env.OPENAI_API_KEY),
    slackAlerts: Boolean((process.env.SMS_SLACK_WEBHOOK_URL || "").trim()),
    leadsSecretSet: leadsSecretConfigured(),
    leadsMode: leadsMode(),
    leadsUrl: base ? `${base}/api/leads` : null,
    dripEnabled: dripEnabled(),
    dripSteps: DRIP_STEPS.length,
    timerSecretSet: (process.env.SMS_TIMER_SECRET || "").trim().length >= 24,
    consentSources: consentSources().join(", "),
  };
}

export async function GET() {
  if (!await requireOwner()) return NextResponse.json({ error: "Owners only." }, { status: 403, headers: NO_STORE });
  if (!smsDatabaseConfigured()) return NextResponse.json({ settings: settings(), messages: [], optOuts: [], audit: [], handoffs: [], leads: [] }, { headers: NO_STORE });
  try {
    const leads = await recentLeads(25).catch((error) => {
      console.error("SMS test leads failed:", error);
      return [];
    });
    return NextResponse.json({ settings: settings(), ...(await recentActivity(50)), leads }, { headers: NO_STORE });
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

  if (body.action === "reset_lead_test") {
    const phone = normalizePhone(String(body.phone || ""));
    if (!phone) return NextResponse.json({ ok: false, message: "Invalid number." }, { status: 400, headers: NO_STORE });
    // Only pilot test numbers (never a real lead once the list is "*").
    const allowed = allowList();
    if (allowed.everyone || !allowed.numbers.includes(phone)) {
      return NextResponse.json({ ok: false, message: "Only numbers on the pilot test list (SMS_ALLOWED_TO) can be reset." }, { status: 400, headers: NO_STORE });
    }
    try {
      const ok = await resetLeadForTest(phone, { skipServiceTitan: body.skipServiceTitan === true });
      if (ok) await audit({ phone, action: "lead_test_reset", reason: body.skipServiceTitan === true ? "skip ServiceTitan check" : null, actor: access.email || "owner" });
      return NextResponse.json({ ok, message: ok ? `Ready: the next test lead for ${formatPhone(phone)} starts a fresh drip.` : "No conversation for that number yet (a new lead will start fresh anyway)." }, { headers: NO_STORE });
    } catch (error) {
      console.error("SMS lead test reset failed:", error);
      return NextResponse.json({ ok: false, message: "Could not reset that number." }, { status: 500, headers: NO_STORE });
    }
  }

  if (typeof body.action === "string" && body.action.startsWith("hatch_")) {
    try {
      if (body.action === "hatch_scan") {
        const result = await scanHatchWindow(String(body.start || ""), String(body.end || ""));
        return NextResponse.json({ ok: true, result }, { headers: NO_STORE });
      }
      if (body.action === "hatch_summary") return NextResponse.json({ ok: true, summary: await hatchOptOutSummary() }, { headers: NO_STORE });
      if (body.action === "hatch_import") {
        const { added } = await importHatchOptOuts(access.email || "owner", new Date());
        return NextResponse.json({ ok: true, added, summary: await hatchOptOutSummary(), message: `Added ${added} Hatch STOP number${added === 1 ? "" : "s"} to Denny's opt-out list.` }, { headers: NO_STORE });
      }
      if (body.action === "hatch_clear_scan") {
        await clearHatchScan();
        return NextResponse.json({ ok: true, summary: await hatchOptOutSummary() }, { headers: NO_STORE });
      }
      return NextResponse.json({ ok: false, message: "Unknown action." }, { status: 400, headers: NO_STORE });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      console.error("Hatch opt-out action failed:", why);
      return NextResponse.json({ ok: false, message: `Hatch step failed: ${why.slice(0, 200)}` }, { status: 500, headers: NO_STORE });
    }
  }

  if (body.action === "resume_bot") {
    const phone = normalizePhone(String(body.phone || ""));
    if (!phone) return NextResponse.json({ ok: false, message: "Invalid number." }, { status: 400, headers: NO_STORE });
    try {
      const ok = await resumeBot(phone);
      if (ok) await audit({ phone, action: "bot_resumed", reason: "owner", actor: access.email || "owner" });
      return NextResponse.json({ ok, message: ok ? `AI replies are back on for ${formatPhone(phone)}.` : "No conversation for that number." }, { headers: NO_STORE });
    } catch (error) {
      console.error("SMS resume bot failed:", error);
      return NextResponse.json({ ok: false, message: "Could not turn the bot back on." }, { status: 500, headers: NO_STORE });
    }
  }

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

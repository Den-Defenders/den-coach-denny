/**
 * POST /api/sms/inbound — Twilio calls this when someone texts our number.
 *
 * Public (no login) but every request must carry a valid X-Twilio-Signature.
 * We save the text, mirror STOP/START, record "they texted us" consent, and
 * answer with empty TwiML: Twilio's Opt-Out Management sends the STOP/START/HELP
 * auto-replies, so we never send a second one, except when Twilio doesn't know:
 *   - opt-out wording Twilio doesn't catch ("please stop texting me") -> our opt-out confirmation
 *   - START after such a Denny-only opt-out -> our opt-in confirmation
 *
 * Step 2: a normal text (not a keyword, not opted out) gets an AI reply from
 * lib/sms/bot.ts. That runs after Twilio already has its answer (next/server
 * after(), inside scheduleBotReply), so Twilio's 15-second webhook limit never matters.
 */
import { scheduleBotReply } from "@/lib/sms/bot";
import { DENNY_ONLY_OPT_OUT_SOURCES, classifyKeyword, normalizePhone } from "@/lib/sms/rules";
import { sendOptInConfirmation, sendOptOutConfirmation, smsNow } from "@/lib/sms/send";
import {
  addConsent,
  audit,
  clearOptOut,
  findOptOut,
  markOptOutKnownToTwilio,
  recordOptOut,
  saveInbound,
  smsDatabaseConfigured,
} from "@/lib/sms/store";
import { emptyTwiml, verifyTwilioRequest } from "@/lib/sms/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Room for the AI reply that runs after the response (debounce + OpenAI + Twilio).
export const maxDuration = 60;

export async function POST(request: Request) {
  const params = new URLSearchParams(await request.text());
  if (!verifyTwilioRequest(request, params)) {
    console.warn("SMS inbound: bad or missing Twilio signature");
    return new Response("Forbidden", { status: 403 });
  }
  if (!smsDatabaseConfigured()) {
    console.error("SMS inbound: texting database is not configured");
    return emptyTwiml(500);
  }

  const sid = params.get("MessageSid") || params.get("SmsMessageSid") || "";
  const from = normalizePhone(params.get("From") || "");
  const body = (params.get("Body") || "").slice(0, 2000);
  if (!sid || !from) {
    await audit({ phone: null, action: "inbound_ignored", reason: "not_us_number", detail: { sid, from: (params.get("From") || "").slice(0, 20) }, actor: "twilio" });
    return emptyTwiml();
  }

  const now = smsNow();
  const media: string[] = [];
  const numMedia = Math.min(Number(params.get("NumMedia") || 0) || 0, 10);
  for (let i = 0; i < numMedia; i++) {
    const url = params.get(`MediaUrl${i}`);
    if (url) media.push(url);
  }

  try {
    const optOut = await findOptOut(from);
    const keyword = classifyKeyword(body, { optedOut: Boolean(optOut), twilioOptOutType: params.get("OptOutType") });
    const { saved, messageId } = await saveInbound({ phone: from, ourNumber: normalizePhone(params.get("To") || ""), body, twilioSid: sid, media, at: now });
    // One line per text in Vercel Runtime Logs (no message body), to trace texts that don't show up.
    console.info(`SMS inbound ${sid} saved=${saved} keyword=${keyword.keyword || "none"} twilioOptOutType=${params.get("OptOutType") || "-"}`);
    if (!saved) return emptyTwiml(); // Twilio retry of a text we already have

    if (keyword.keyword === "stop") {
      if (optOut && keyword.handledByTwilio) await markOptOutKnownToTwilio(from);
      await recordOptOut(from, keyword.handledByTwilio ? "keyword" : "keyword_extra", keyword.matched, now);
      await audit({ phone: from, action: "opt_out", reason: keyword.handledByTwilio ? "keyword" : "keyword_extra", detail: { keyword: keyword.matched, sid }, actor: "customer" });
      if (!keyword.handledByTwilio) {
        const confirmation = await sendOptOutConfirmation(from);
        if (!confirmation.ok) console.warn("SMS opt-out confirmation not sent:", confirmation.reason);
      }
    } else if (keyword.keyword === "start") {
      if (optOut) await clearOptOut(from);
      await addConsent(from, "conversational", "start_keyword", body.slice(0, 200), now);
      await audit({ phone: from, action: "opt_in", reason: "start_keyword", detail: { keyword: keyword.matched, sid, wasOptedOut: Boolean(optOut), optOutSource: optOut?.source ?? null }, actor: "customer" });
      // Twilio never blocked this number, so it won't confirm the START. We do, once.
      if (optOut && DENNY_ONLY_OPT_OUT_SOURCES.has(optOut.source)) {
        const confirmation = await sendOptInConfirmation(from);
        if (!confirmation.ok) console.warn("SMS opt-in confirmation not sent:", confirmation.reason);
      }
    } else if (keyword.keyword === "help") {
      await audit({ phone: from, action: "help", reason: "help_keyword", detail: { sid }, actor: "customer" });
    } else if (optOut) {
      // Still opted out: keep the text, but it isn't consent. Only START/YES opts back in.
      await audit({ phone: from, action: "inbound_while_opted_out", detail: { sid }, actor: "customer" });
    } else {
      const added = await addConsent(from, "conversational", "inbound_text", body.slice(0, 200), now);
      if (added) await audit({ phone: from, action: "consent_added", reason: "inbound_text", detail: { sid }, actor: "customer" });
      // AI reply, after Twilio has its empty TwiML. All send rules still apply inside.
      if (messageId) scheduleBotReply(from, messageId);
    }
  } catch (error) {
    console.error("SMS inbound failed:", error instanceof Error ? error.message : error);
    return emptyTwiml(500);
  }

  return emptyTwiml();
}

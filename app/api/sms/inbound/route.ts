/**
 * POST /api/sms/inbound — Twilio calls this when someone texts our number.
 *
 * Public (no login) but every request must carry a valid X-Twilio-Signature.
 * We save the text, mirror STOP/START, record "they texted us" consent, and
 * answer with empty TwiML: Twilio's Opt-Out Management sends the STOP/START/HELP
 * auto-replies, so we never send a second one (except for opt-out wording
 * Twilio doesn't know, like "please stop texting me").
 *
 * Step 1 doesn't reply to normal texts yet; the bot comes in step 2.
 */
import { classifyKeyword, normalizePhone } from "@/lib/sms/rules";
import { sendOptOutConfirmation, smsNow } from "@/lib/sms/send";
import { addConsent, audit, clearOptOut, findOptOut, recordOptOut, saveInbound, smsDatabaseConfigured } from "@/lib/sms/store";
import { emptyTwiml, verifyTwilioRequest } from "@/lib/sms/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const { saved } = await saveInbound({ phone: from, ourNumber: normalizePhone(params.get("To") || ""), body, twilioSid: sid, media, at: now });
    if (!saved) return emptyTwiml(); // Twilio retry of a text we already have

    if (keyword.keyword === "stop") {
      await recordOptOut(from, keyword.handledByTwilio ? "keyword" : "keyword_extra", keyword.matched, now);
      await audit({ phone: from, action: "opt_out", reason: keyword.handledByTwilio ? "keyword" : "keyword_extra", detail: { keyword: keyword.matched, sid }, actor: "customer" });
      if (!keyword.handledByTwilio) {
        const confirmation = await sendOptOutConfirmation(from);
        if (!confirmation.ok) console.warn("SMS opt-out confirmation not sent:", confirmation.reason);
      }
    } else if (keyword.keyword === "start") {
      if (optOut) await clearOptOut(from);
      await addConsent(from, "conversational", "start_keyword", body.slice(0, 200), now);
      await audit({ phone: from, action: "opt_in", reason: "start_keyword", detail: { keyword: keyword.matched, sid, wasOptedOut: Boolean(optOut) }, actor: "customer" });
    } else if (keyword.keyword === "help") {
      await audit({ phone: from, action: "help", reason: "help_keyword", detail: { sid }, actor: "customer" });
    } else if (optOut) {
      // Still opted out: keep the text, but it isn't consent. Only START/YES opts back in.
      await audit({ phone: from, action: "inbound_while_opted_out", detail: { sid }, actor: "customer" });
    } else {
      const added = await addConsent(from, "conversational", "inbound_text", body.slice(0, 200), now);
      if (added) await audit({ phone: from, action: "consent_added", reason: "inbound_text", detail: { sid }, actor: "customer" });
    }
  } catch (error) {
    console.error("SMS inbound failed:", error instanceof Error ? error.message : error);
    return emptyTwiml(500);
  }

  return emptyTwiml();
}

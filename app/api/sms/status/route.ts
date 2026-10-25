/**
 * POST /api/sms/status — Twilio delivery updates for texts we sent
 * (queued → sent → delivered / undelivered / failed).
 *
 * Public (no login) but signature-checked. Error 21610 means the person had
 * replied STOP, so we mirror the opt-out.
 */
import { smsNow } from "@/lib/sms/send";
import { applyStatusCallback, audit, recordOptOut, smsDatabaseConfigured } from "@/lib/sms/store";
import { TWILIO_UNSUBSCRIBED_ERROR, emptyTwiml, verifyTwilioRequest } from "@/lib/sms/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const params = new URLSearchParams(await request.text());
  if (!verifyTwilioRequest(request, params)) {
    console.warn("SMS status: bad or missing Twilio signature");
    return new Response("Forbidden", { status: 403 });
  }
  if (!smsDatabaseConfigured()) return emptyTwiml(500);

  const sid = params.get("MessageSid") || params.get("SmsSid") || "";
  const status = (params.get("MessageStatus") || params.get("SmsStatus") || "").toLowerCase();
  const errorCode = params.get("ErrorCode") || null;
  const errorMessage = params.get("ErrorMessage") || null;
  if (!sid || !status) return emptyTwiml();

  try {
    const result = await applyStatusCallback({ twilioSid: sid, status, errorCode, errorMessage });
    if (result.phone && (status === "failed" || status === "undelivered") && result.updated) {
      await audit({ phone: result.phone, action: "delivery_failed", reason: errorCode, detail: { sid, status, errorMessage }, actor: "twilio" });
    }
    if (result.phone && errorCode === TWILIO_UNSUBSCRIBED_ERROR) {
      await recordOptOut(result.phone, "twilio_21610", null, smsNow());
      await audit({ phone: result.phone, action: "opt_out", reason: "twilio_21610", detail: { sid, via: "status" }, actor: "twilio" });
    }
  } catch (error) {
    console.error("SMS status failed:", error instanceof Error ? error.message : error);
    return emptyTwiml(500);
  }
  return emptyTwiml();
}

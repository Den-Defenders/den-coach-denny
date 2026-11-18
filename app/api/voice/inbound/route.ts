/**
 * POST /api/voice/inbound — Session 8 PR 4. Twilio calls this when someone phones one of our
 * texting numbers. Public (no login), but every request must carry a valid X-Twilio-Signature.
 *
 * Answers with TwiML that forwards the call to that number's ServiceTitan tracked line
 * (Texting numbers page, "Calls forward to"); a number with no line set goes to (916) 409-6367.
 * The caller's own number shows on the ServiceTitan side. The call is logged for the inbox.
 * If this route ever fails, Twilio uses the number's "Primary handler fails" TwiML Bin.
 */
import { callFallback, forwardFor, forwardTwiml, logCall } from "@/lib/sms/calls";
import { normalizePhone } from "@/lib/sms/rules";
import { audit, smsDatabaseConfigured } from "@/lib/sms/store";
import { verifyTwilioRequest } from "@/lib/sms/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function twiml(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const params = new URLSearchParams(await request.text());
  if (!verifyTwilioRequest(request, params)) {
    console.warn("Voice inbound: bad or missing Twilio signature");
    return new Response("Forbidden", { status: 403 });
  }
  const ourNumber = normalizePhone(params.get("To") || "");
  const caller = normalizePhone(params.get("From") || "");
  const callSid = params.get("CallSid") || "";

  let forwardTo = callFallback();
  try {
    const found = await forwardFor(ourNumber);
    forwardTo = found.forwardTo;
    if (smsDatabaseConfigured()) {
      await logCall({ callSid, phone: caller, ourNumber, forwardedTo: forwardTo });
      await audit({ phone: caller, action: "call_forwarded", reason: found.fromPage ? "page" : "fallback", detail: { callSid, ourNumber, forwardTo, name: found.name }, actor: "twilio" });
    }
  } catch (error) {
    // Never drop a call over logging: it still rings ServiceTitan.
    console.error("Voice inbound log failed:", error instanceof Error ? error.message : error);
  }
  console.info(`Voice inbound ${callSid}: ${ourNumber || "?"} -> ${forwardTo}`);
  // Hidden or blocked caller ID: show our number instead (carriers can refuse an anonymous forward).
  return twiml(forwardTwiml(forwardTo, caller ? null : ourNumber));
}

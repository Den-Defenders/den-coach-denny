/**
 * lib/sms/twilio.ts
 *
 * The only file that talks to Twilio Messaging. REST with fetch (no npm
 * package), same as lib/websiteBotSms.ts.
 *
 *   - checks X-Twilio-Signature on every webhook
 *   - sends through the "Den Defenders" Messaging Service
 *
 * Nothing here decides WHETHER to text someone. That is lib/sms/send.ts.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

type MessagingConfig = { accountSid: string; authToken: string; messagingServiceSid: string };

function authToken(): string {
  return (process.env.TWILIO_AUTH_TOKEN || "").trim();
}

export function messagingConfig(): MessagingConfig | null {
  const accountSid = (process.env.TWILIO_ACCOUNT_SID || "").trim();
  const token = authToken();
  const messagingServiceSid = (process.env.TWILIO_MESSAGING_SERVICE_SID || "").trim();
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid) || !token || !/^MG[0-9a-f]{32}$/i.test(messagingServiceSid)) return null;
  return { accountSid, authToken: token, messagingServiceSid };
}

/** Public address Twilio calls, e.g. https://den-coach-denny.vercel.app (no trailing slash). */
export function webhookBaseUrl(): string | null {
  const base = (process.env.SMS_WEBHOOK_BASE_URL || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[^/]+$/i.test(base) ? base : null;
}

// ---------------------------------------------------------------------------
// Webhook signature
// ---------------------------------------------------------------------------

/** Twilio's signature: HMAC-SHA1(auth token, URL + each POST field name+value sorted by name), base64. */
export function twilioSignature(token: string, url: string, params: URLSearchParams): string {
  const keys = Array.from(new Set(params.keys())).sort();
  let data = url;
  for (const key of keys) {
    for (const value of params.getAll(key).sort()) data += key + value;
  }
  return createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * True only when the request really came from Twilio. We rebuild the URL from
 * SMS_WEBHOOK_BASE_URL (what's typed in the Twilio console) because Vercel can
 * see a different host internally.
 */
export function verifyTwilioRequest(request: Request, params: URLSearchParams): boolean {
  const token = authToken();
  const signature = request.headers.get("x-twilio-signature") || "";
  if (!token || !signature) return false;
  const actual = new URL(request.url);
  const base = webhookBaseUrl();
  const candidates = new Set<string>();
  if (base) candidates.add(`${base}${actual.pathname}${actual.search}`);
  candidates.add(request.url);
  for (const url of candidates) {
    if (safeEqual(twilioSignature(token, url, params), signature)) return true;
  }
  return false;
}

/** Twilio needs a TwiML answer. Empty = "no auto-reply from us". */
export function emptyTwiml(status = 200): Response {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status,
    headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type TwilioSendResult =
  | { ok: true; sid: string; status: string; from: string | null }
  | { ok: false; code: string | null; message: string; httpStatus: number };

/** Twilio error 21610 = this number replied STOP to us (Twilio blocks it). */
export const TWILIO_UNSUBSCRIBED_ERROR = "21610";

/** Send a text; mediaUrls (public https image links) turn it into a picture text (MMS). */
export async function twilioSendMessage(to: string, body: string, mediaUrls: string[] = []): Promise<TwilioSendResult> {
  const cfg = messagingConfig();
  if (!cfg) return { ok: false, code: null, message: "Twilio Messaging is not configured.", httpStatus: 0 };
  const form = new URLSearchParams({ To: to, Body: body, MessagingServiceSid: cfg.messagingServiceSid });
  for (const url of mediaUrls) form.append("MediaUrl", url);
  const base = webhookBaseUrl();
  if (base) form.set("StatusCallback", `${base}/api/sms/status`);
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok && typeof data.sid === "string") {
      return { ok: true, sid: data.sid, status: String(data.status || "queued"), from: typeof data.from === "string" ? data.from : null };
    }
    return {
      ok: false,
      code: data.code != null ? String(data.code) : null,
      message: String(data.message || `Twilio returned HTTP ${res.status}`).slice(0, 300),
      httpStatus: res.status,
    };
  } catch (error) {
    return { ok: false, code: null, message: error instanceof Error ? error.message : "Network error", httpStatus: 0 };
  }
}

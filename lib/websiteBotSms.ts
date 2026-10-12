/**
 * lib/websiteBotSms.ts
 *
 * Text-message verification for website bookings (Twilio Verify).
 *
 * Flow, after the visitor sees the booking preview card:
 *   1. {action:"send_code", token}  -> Twilio texts a 6-digit code to the
 *      phone number inside the signed booking ticket. The browser never
 *      chooses the number, so nobody can use the bot to text strangers.
 *   2. {action:"check_code", token, code} -> Twilio checks the code. On
 *      success we return a short-lived signed "proof" tied to this ticket.
 *   3. {action:"confirm", token, proof} -> books as before. Without a valid
 *      proof (when verification is turned on) nothing is booked.
 *
 * Off unless WEBSITE_BOT_SMS_VERIFY_ENABLED=true. When it is on but the
 * Twilio settings are missing, booking fails closed (asks them to call).
 *
 * Uses Twilio's REST API with fetch, so there is no extra npm package.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function smsVerifyEnabled(): boolean {
  return (process.env.WEBSITE_BOT_SMS_VERIFY_ENABLED || "").trim().toLowerCase() === "true";
}

type TwilioConfig = { accountSid: string; authToken: string; serviceSid: string };

function twilioConfig(): TwilioConfig | null {
  const accountSid = (process.env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = (process.env.TWILIO_AUTH_TOKEN || "").trim();
  const serviceSid = (process.env.TWILIO_VERIFY_SERVICE_SID || "").trim();
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid) || !authToken || !/^VA[0-9a-f]{32}$/i.test(serviceSid)) return null;
  return { accountSid, authToken, serviceSid };
}

export function smsVerifyReady(): boolean {
  return smsVerifyEnabled() && twilioConfig() !== null;
}

/** What the widget needs to draw the consent line under the preview card. */
export type SmsConsent = {
  required: true;
  text: string;
  termsUrl?: string;
  privacyUrl?: string;
};

export function smsConsent(): SmsConsent | undefined {
  if (!smsVerifyEnabled()) return undefined;
  const termsUrl = (process.env.WEBSITE_BOT_TERMS_URL || "").trim() || undefined;
  const privacyUrl = (process.env.WEBSITE_BOT_PRIVACY_URL || "").trim() || undefined;
  return {
    required: true,
    text:
      "By providing your mobile number, you agree to receive text messages from Den Defenders, including a one-time verification code and appointment confirmation / arrival-window updates. Msg & data rates may apply. Message frequency varies. Reply HELP for help, STOP to opt out.",
    termsUrl,
    privacyUrl,
  };
}

function e164(tenDigits: string): string {
  return `+1${tenDigits}`;
}

async function twilioPost(path: string, form: Record<string, string>): Promise<{ status: number; data: Record<string, unknown> }> {
  const cfg = twilioConfig();
  if (!cfg) throw new Error("Twilio Verify is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_VERIFY_SERVICE_SID).");
  const res = await fetch(`https://verify.twilio.com/v2/Services/${cfg.serviceSid}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data };
}

export type SendCodeResult =
  | { ok: true }
  | { ok: false; reason: "NOT_CONFIGURED" | "TOO_MANY" | "INVALID_NUMBER" | "BLOCKED" | "FAILED" };

/** Text a code to a 10-digit US/Canada number. */
export async function sendVerificationCode(phone10: string): Promise<SendCodeResult> {
  if (!twilioConfig()) return { ok: false, reason: "NOT_CONFIGURED" };
  try {
    const { status, data } = await twilioPost("Verifications", { To: e164(phone10), Channel: "sms" });
    if (status >= 200 && status < 300) return { ok: true };
    const code = Number(data.code);
    console.warn("Twilio Verify send refused:", status, code, String(data.message || "").slice(0, 200));
    if (status === 429 || code === 60203) return { ok: false, reason: "TOO_MANY" }; // max send attempts
    if (code === 60200 || code === 21211 || code === 60205) return { ok: false, reason: "INVALID_NUMBER" }; // bad / landline
    if (code === 60410 || code === 60605 || code === 21608) return { ok: false, reason: "BLOCKED" }; // fraud guard / geo permissions / account not cleared to text yet
    return { ok: false, reason: "FAILED" };
  } catch (error) {
    console.error("Twilio Verify send failed:", error instanceof Error ? error.message : error);
    return { ok: false, reason: "FAILED" };
  }
}

export type CheckCodeResult = { ok: true } | { ok: false; reason: "WRONG" | "EXPIRED" | "NOT_CONFIGURED" | "FAILED" };

export async function checkVerificationCode(phone10: string, code: string): Promise<CheckCodeResult> {
  if (!twilioConfig()) return { ok: false, reason: "NOT_CONFIGURED" };
  try {
    const { status, data } = await twilioPost("VerificationCheck", { To: e164(phone10), Code: code });
    if (status >= 200 && status < 300) {
      return data.status === "approved" ? { ok: true } : { ok: false, reason: "WRONG" };
    }
    // 404 = no pending code (expired, already used, or too many wrong tries).
    if (status === 404 || Number(data.code) === 20404 || Number(data.code) === 60202) return { ok: false, reason: "EXPIRED" };
    console.warn("Twilio Verify check refused:", status, data.code, String(data.message || "").slice(0, 200));
    return { ok: false, reason: "FAILED" };
  } catch (error) {
    console.error("Twilio Verify check failed:", error instanceof Error ? error.message : error);
    return { ok: false, reason: "FAILED" };
  }
}

// ---------------------------------------------------------------------------
// Proof that this booking ticket's phone number was verified
// ---------------------------------------------------------------------------

const PROOF_LIFETIME_MS = 20 * 60 * 1000;

function proofSecret(): string {
  const secret = (process.env.WEBSITE_BOT_SIGNING_SECRET || "").trim();
  if (secret.length < 16) throw new Error("WEBSITE_BOT_SIGNING_SECRET is not set (needs 16+ random characters).");
  return secret;
}

/** Ties the proof to one exact booking ticket (its token) and phone number. */
function ticketDigest(token: string): string {
  return createHash("sha256").update(token).digest("base64url").slice(0, 32);
}

export function signVerifiedProof(token: string, phone10: string): string {
  const payload = Buffer.from(JSON.stringify({
    t: "sms",
    d: ticketDigest(token),
    p: phone10,
    exp: Date.now() + PROOF_LIFETIME_MS,
  })).toString("base64url");
  const sig = createHmac("sha256", proofSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyVerifiedProof(proof: string, token: string, phone10: string): boolean {
  const [payload, sig] = (proof || "").split(".");
  if (!payload || !sig) return false;
  const expected = createHmac("sha256", proofSecret()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { t?: string; d?: string; p?: string; exp?: number };
    return data.t === "sms" && data.d === ticketDigest(token) && data.p === phone10 && typeof data.exp === "number" && data.exp > Date.now();
  } catch {
    return false;
  }
}

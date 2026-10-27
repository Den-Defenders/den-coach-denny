/**
 * lib/sms/send.ts
 *
 * THE one way Den Coach Denny sends a text. Every text (AI reply, CSR reply,
 * drip, follow-up) must go through sendSms(). The AI can't skip or change
 * these checks; only a code change can.
 *
 * Checks, in order (any "no" blocks the text and is written to sms_audit):
 *   1. message is valid (US/Canada number, not empty, <= 640 characters)
 *   2. on/off switch          SMS_SENDING_ENABLED=true
 *   3. Twilio is set up       TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_MESSAGING_SERVICE_SID
 *   4. pilot allow-list       SMS_ALLOWED_TO (comma list of numbers, or * for everyone; empty = nobody)
 *   5. not opted out          (STOP / END / ... or Twilio error 21610)
 *      (keyword confirmations: only right after the STOP / START they answer, once)
 *   6. consent                care texts: any active consent
 *                             automated texts: form consent (care/marketing), not just "they texted us"
 *                             promo texts: SMS_PROMO_TEXTS_ENABLED=true + form consent
 *   7. "reply" only within 24 hours of their last text
 *   8. sending hours in the customer's time: reply 8 AM–7 PM, manual 8 AM–9 PM, automated 9 AM–5 PM
 *   9. no automated texts on the holiday list
 *  10. caps: per number 8/hour and 20/day, 2 automated/day, 300/day for everyone (env can lower/raise)
 */
import {
  MAX_BODY_CHARS,
  OPT_IN_CONFIRMATION,
  OPT_OUT_CONFIRMATION,
  describeHours,
  isConfirmationKind,
  holidayName,
  localTime,
  normalizePhone,
  withinSendingHours,
  type SendKind,
} from "@/lib/sms/rules";
import {
  activeConsentTypes,
  audit,
  confirmationSent,
  countOutboundAll,
  countOutboundTo,
  createOutbound,
  ensureContact,
  findOptOut,
  markOutboundAccepted,
  markOutboundFailed,
  optOutConfirmationSent,
  recordOptOut,
  smsDatabaseConfigured,
} from "@/lib/sms/store";
import { TWILIO_UNSUBSCRIBED_ERROR, messagingConfig, twilioSendMessage, type TwilioSendResult } from "@/lib/sms/twilio";

export type SendPurpose = "care" | "marketing";

export type SendRequest = {
  to: string;
  body: string;
  kind: SendKind;
  /** "marketing" for promos/offers (the $400 offer, financing pitches). Default "care". */
  purpose?: SendPurpose;
  /** Who is sending, for the log: an email, "denny-ai", "drip", "system". */
  sentBy: string;
  /** Up to 2 public https photo links (door photo library) → sent as one picture text (MMS, ~2-3 cents). */
  mediaUrls?: string[];
};

export const MAX_MEDIA_PER_TEXT = 2;

export type BlockReason =
  | "invalid_number" | "empty_message" | "too_long" | "invalid_kind"
  | "sending_disabled" | "twilio_not_configured" | "not_on_allow_list" | "database_not_configured"
  | "opted_out" | "no_consent" | "promo_texts_disabled" | "no_marketing_consent"
  | "reply_window_closed" | "outside_hours" | "holiday"
  | "contact_hourly_cap" | "contact_daily_cap" | "automated_daily_cap" | "system_daily_cap"
  | "no_recent_opt_out" | "no_recent_opt_in" | "twilio_rejected" | "bad_media";

export type SendResult =
  | { ok: true; messageId: number; twilioSid: string; status: string }
  | { ok: false; reason: BlockReason; message: string };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt((process.env[name] || "").trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function smsLimits() {
  return {
    perContactPerHour: envInt("SMS_MAX_PER_CONTACT_PER_HOUR", 8),
    perContactPerDay: envInt("SMS_MAX_PER_CONTACT_PER_DAY", 20),
    automatedPerContactPerDay: envInt("SMS_MAX_AUTOMATED_PER_CONTACT_PER_DAY", 2),
    systemPerDay: envInt("SMS_DAILY_CAP", 300),
  };
}

export function sendingEnabled(): boolean {
  return (process.env.SMS_SENDING_ENABLED || "").trim().toLowerCase() === "true";
}

export function promoTextsEnabled(): boolean {
  return (process.env.SMS_PROMO_TEXTS_ENABLED || "").trim().toLowerCase() === "true";
}

/** Pilot allow-list. Empty = nobody, "*" = everyone. */
export function allowList(): { everyone: boolean; numbers: string[] } {
  const raw = (process.env.SMS_ALLOWED_TO || "").trim();
  if (raw === "*") return { everyone: true, numbers: [] };
  const numbers = raw.split(/[,;\n]+/).map((n) => normalizePhone(n)).filter((n): n is string => Boolean(n));
  return { everyone: false, numbers };
}

// Tests can swap the clock and Twilio.
let clock: () => Date = () => new Date();
let sender: (to: string, body: string, mediaUrls?: string[]) => Promise<TwilioSendResult> = twilioSendMessage;
export function setSendDepsForTests(deps: { now?: () => Date; send?: typeof sender } | null) {
  clock = deps?.now ?? (() => new Date());
  sender = deps?.send ?? twilioSendMessage;
}

/** Current time for texting code (the webhooks use it too, so tests can move the clock). */
export function smsNow(): Date {
  return clock();
}

const KINDS: SendKind[] = ["reply", "manual", "automated", "opt_out_confirmation", "opt_in_confirmation"];

export async function sendSms(request: SendRequest): Promise<SendResult> {
  const now = clock();
  const purpose: SendPurpose = request.purpose === "marketing" ? "marketing" : "care";
  const kind = request.kind;
  const phone = normalizePhone(request.to);
  const body = (request.body || "").trim();
  const actor = request.sentBy || "unknown";
  const media = (request.mediaUrls || []).filter(Boolean);

  const block = async (reason: BlockReason, message: string, detail?: Record<string, unknown>): Promise<SendResult> => {
    if (reason !== "database_not_configured") {
      await audit({ phone, action: "send_blocked", reason, detail: { kind, purpose, chars: body.length, ...detail }, actor });
    }
    return { ok: false, reason, message };
  };

  // 1. Valid message
  if (!KINDS.includes(kind)) return block("invalid_kind", "Unknown kind of text.");
  if (!phone) return block("invalid_number", "That isn't a valid US/Canada mobile number.");
  if (!body) return block("empty_message", "The message is empty.");
  if (body.length > MAX_BODY_CHARS) return block("too_long", `Keep texts under ${MAX_BODY_CHARS} characters (this one is ${body.length}).`);
  if (media.length > MAX_MEDIA_PER_TEXT || media.some((u) => !/^https:\/\/[^\s]+$/i.test(u))) {
    return block("bad_media", `Up to ${MAX_MEDIA_PER_TEXT} https photo links per text.`, { media: media.length });
  }

  // 2-4. Switches and setup
  if (!smsDatabaseConfigured()) return block("database_not_configured", "Texting database isn't set up.");
  if (!sendingEnabled()) return block("sending_disabled", "Texting is turned off (SMS_SENDING_ENABLED).");
  if (!messagingConfig()) return block("twilio_not_configured", "Twilio Messaging isn't set up in Vercel.");
  const allowed = allowList();
  if (!allowed.everyone && !allowed.numbers.includes(phone)) {
    return block("not_on_allow_list", "Pilot mode: this number isn't on the test list (SMS_ALLOWED_TO).");
  }

  // 5. Opt-out
  const optOut = await findOptOut(phone);
  if (kind === "opt_out_confirmation") {
    const recent = optOut && Date.parse(optOut.optedOutAt) >= now.getTime() - 10 * 60 * 1000;
    if (!recent || await optOutConfirmationSent(phone, new Date(Date.parse(optOut!.optedOutAt)))) {
      return block("no_recent_opt_out", "No new opt-out to confirm.");
    }
  } else if (optOut) {
    return block("opted_out", "This number opted out (STOP). Never text it unless they text START.");
  }

  const contact = await ensureContact(phone);

  if (kind === "opt_in_confirmation") {
    // Only right after their START: their newest text is under 10 minutes old and not yet confirmed.
    const last = contact.lastInboundAt ? Date.parse(contact.lastInboundAt) : 0;
    if (!last || now.getTime() - last > 10 * 60 * 1000 || await confirmationSent(phone, "opt_in_confirmation", new Date(last))) {
      return block("no_recent_opt_in", "No new START to confirm.");
    }
  }

  if (!isConfirmationKind(kind)) {
    // 6. Consent
    const consent = await activeConsentTypes(phone);
    if (!consent.length) return block("no_consent", "No texting consent on file for this number.");
    const formConsent = consent.includes("care") || consent.includes("marketing");
    if (purpose === "marketing") {
      if (!promoTextsEnabled()) return block("promo_texts_disabled", "Promo texts are turned off (SMS_PROMO_TEXTS_ENABLED).");
      if (!formConsent) return block("no_marketing_consent", "Promo texts need form consent, not just an incoming text.");
    }
    if (kind === "automated" && !formConsent) {
      return block("no_consent", "Automated texts need form consent, not just an incoming text.", { consent });
    }

    // 7. Reply window
    if (kind === "reply") {
      const last = contact.lastInboundAt ? Date.parse(contact.lastInboundAt) : 0;
      if (!last || now.getTime() - last > DAY) {
        return block("reply_window_closed", "Auto-replies only go out within 24 hours of their last text.");
      }
    }

    // 8-9. Hours and holidays in the customer's time zone
    const local = localTime(now, contact.timeZone);
    if (!withinSendingHours(kind, local)) {
      return block("outside_hours", `Outside sending hours (${describeHours(kind)} ${contact.timeZone}).`, { localHour: local.hour, timeZone: contact.timeZone });
    }
    if (kind === "automated") {
      const holiday = holidayName(local);
      if (holiday) return block("holiday", `No automated texts on ${holiday}.`, { holiday });
    }

    // 10. Caps
    const capHit = await checkCaps(phone, kind, now);
    if (capHit) return block(capHit.reason, capHit.message);
  }

  // Send. Record first so nothing goes out without a row.
  const messageId = await createOutbound({ conversationId: contact.conversationId, phone, body, kind, purpose, sentBy: actor, at: now, media });
  const result = await sender(phone, body, media);
  if (!result.ok) {
    await markOutboundFailed(messageId, result.code, result.message);
    if (result.code === TWILIO_UNSUBSCRIBED_ERROR) {
      await recordOptOut(phone, "twilio_21610", null, now);
      await audit({ phone, action: "opt_out", reason: "twilio_21610", detail: { via: "send" }, actor: "system" });
    }
    return block("twilio_rejected", `Twilio didn't accept the text: ${result.message}`, { code: result.code, httpStatus: result.httpStatus, messageId });
  }
  await markOutboundAccepted(messageId, result.sid, result.status, result.from);
  await audit({ phone, action: "sent", reason: kind, detail: { purpose, messageId, sid: result.sid, chars: body.length, ...(media.length ? { photos: media.length } : {}) }, actor });
  return { ok: true, messageId, twilioSid: result.sid, status: result.status };
}

/**
 * Rule 10 on its own, so the AI can check it BEFORE paying for an OpenAI call.
 * Returns null when another text of this kind may go to this number now.
 */
export async function checkCaps(phone: string, kind: SendKind, now: Date = clock()): Promise<{ reason: BlockReason; message: string } | null> {
  const limits = smsLimits();
  if (await countOutboundTo(phone, new Date(now.getTime() - HOUR)) >= limits.perContactPerHour) {
    return { reason: "contact_hourly_cap", message: `Hit the limit of ${limits.perContactPerHour} texts per hour to one number.` };
  }
  if (await countOutboundTo(phone, new Date(now.getTime() - DAY)) >= limits.perContactPerDay) {
    return { reason: "contact_daily_cap", message: `Hit the limit of ${limits.perContactPerDay} texts per 24 hours to one number.` };
  }
  if (kind === "automated" && await countOutboundTo(phone, new Date(now.getTime() - DAY), "automated") >= limits.automatedPerContactPerDay) {
    return { reason: "automated_daily_cap", message: `Hit the limit of ${limits.automatedPerContactPerDay} automated texts per 24 hours to one number.` };
  }
  if (await countOutboundAll(new Date(now.getTime() - DAY)) >= limits.systemPerDay) {
    return { reason: "system_daily_cap", message: `Hit the company-wide limit of ${limits.systemPerDay} texts per 24 hours.` };
  }
  return null;
}

/** The one opt-out confirmation for wording Twilio doesn't catch ("please stop texting me"). */
export function sendOptOutConfirmation(to: string): Promise<SendResult> {
  return sendSms({ to, body: OPT_OUT_CONFIRMATION, kind: "opt_out_confirmation", sentBy: "system" });
}

/** The one opt-in confirmation when START follows an opt-out Twilio never knew about. */
export function sendOptInConfirmation(to: string): Promise<SendResult> {
  return sendSms({ to, body: OPT_IN_CONFIRMATION, kind: "opt_in_confirmation", sentBy: "system" });
}

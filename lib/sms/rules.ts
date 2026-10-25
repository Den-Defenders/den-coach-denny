/**
 * lib/sms/rules.ts
 *
 * Plain rules for texting, with no database or network calls, so they are easy
 * to read and test:
 *   - phone number clean-up (E.164, US/Canada only)
 *   - STOP / START / HELP keywords
 *   - sending hours in the customer's own time zone
 *   - the holidays with no automated texts
 *
 * These are guardrails. The AI never changes them; only a code change can.
 */

export const DEFAULT_TIME_ZONE = "America/Los_Angeles";

/** Max characters in one text we send (about 4 SMS segments). */
export const MAX_BODY_CHARS = 640;

/** "(916) 555-1234", "916.555.1234", "+19165551234" -> "+19165551234". Null when not a US/Canada number. */
export function normalizePhone(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let digits = input.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  // NANP: area code and exchange can't start with 0 or 1.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;
  return `+1${digits}`;
}

/** "+19165551234" -> "(916) 555-1234" for screens. */
export function formatPhone(e164: string): string {
  const d = e164.replace(/^\+1/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164;
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

/**
 * One-word opt-out keywords Twilio handles on its own (it blocks the number and
 * sends the opt-out confirmation). We mirror the opt-out into Denny.
 */
const TWILIO_STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);

/** Extra opt-out wording we also honor (FCC: "any reasonable way" to revoke). */
const EXTRA_STOP_PHRASES = new Set([
  "REVOKE", "OPTOUT", "OPT OUT", "STOP ALL", "STOP TEXTING", "STOP TEXTING ME", "STOP MESSAGING ME",
  "PLEASE STOP", "STOP PLEASE", "UNSUBSCRIBE ME", "REMOVE ME", "REMOVE ME FROM YOUR LIST",
  "TAKE ME OFF", "TAKE ME OFF YOUR LIST", "DO NOT TEXT", "DO NOT TEXT ME", "DONT TEXT ME",
  "NO MORE TEXTS", "LEAVE ME ALONE",
]);

const START_WORDS = new Set(["START", "UNSTOP"]);
/** YES only opts someone back in when they are opted out; otherwise it's a normal reply. */
const START_IF_OPTED_OUT = new Set(["YES"]);
const HELP_WORDS = new Set(["HELP", "INFO"]);

export type Keyword = "stop" | "start" | "help";

function normalizeKeywordText(body: string): string {
  return body
    .toUpperCase()
    .replace(/[’']/g, "") // DON'T -> DONT
    .replace(/[^A-Z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type KeywordResult = {
  keyword: Keyword | null;
  /** True when Twilio already blocked/replied on its own (we must not send a second confirmation). */
  handledByTwilio: boolean;
  /** The cleaned-up text we matched, for the audit log. */
  matched: string | null;
};

/**
 * Decide whether an incoming text is STOP / START / HELP.
 * `twilioOptOutType` is the OptOutType field Twilio adds to the webhook when
 * its Opt-Out Management recognized a keyword (STOP, START or HELP).
 */
export function classifyKeyword(body: string, opts: { optedOut: boolean; twilioOptOutType?: string | null }): KeywordResult {
  const text = normalizeKeywordText(body || "");
  const twilioType = (opts.twilioOptOutType || "").trim().toUpperCase();

  if (twilioType === "STOP") return { keyword: "stop", handledByTwilio: true, matched: text || "STOP" };
  // Twilio's opt-in list includes YES, so Twilio tags EVERY "Yes" as START. Only treat it as
  // START when they're opted out or actually typed START/UNSTOP; otherwise "Yes" is a normal
  // answer the bot must reply to (Twilio sends no auto-reply to subscribed numbers).
  if (twilioType === "START" && (opts.optedOut || START_WORDS.has(text))) {
    return { keyword: "start", handledByTwilio: true, matched: text || "START" };
  }
  if (twilioType === "HELP") return { keyword: "help", handledByTwilio: true, matched: text || "HELP" };

  if (!text) return { keyword: null, handledByTwilio: false, matched: null };
  if (TWILIO_STOP_WORDS.has(text)) return { keyword: "stop", handledByTwilio: true, matched: text };
  // "Please stop texting me, thanks" -> "STOP TEXTING ME". Twilio only catches exact one-word
  // keywords, so anything matched after trimming is ours to confirm.
  const core = text
    .replace(/^(PLEASE|PLS|PLZ)\s+/, "")
    .replace(/\s+(PLEASE|PLS|PLZ|THANKS|THANK YOU|THX|NOW)$/, "")
    .trim();
  if (EXTRA_STOP_PHRASES.has(text) || EXTRA_STOP_PHRASES.has(core) || TWILIO_STOP_WORDS.has(core)) {
    return { keyword: "stop", handledByTwilio: false, matched: text };
  }
  if (START_WORDS.has(text)) return { keyword: "start", handledByTwilio: true, matched: text };
  if (START_IF_OPTED_OUT.has(text) && opts.optedOut) return { keyword: "start", handledByTwilio: true, matched: text };
  if (HELP_WORDS.has(text)) return { keyword: "help", handledByTwilio: true, matched: text };
  return { keyword: null, handledByTwilio: false, matched: null };
}

/** Sent by us only for the extra opt-out wording Twilio doesn't recognize. */
export const OPT_OUT_CONFIRMATION =
  "Den Defenders: You're unsubscribed and won't get more texts from us. Reply START to resubscribe.";

/**
 * Sent by us only when START follows an opt-out Twilio never knew about
 * ("please stop texting me"): Twilio then has nothing to confirm. Same wording
 * as the Twilio Opt-out tab's opt-in confirmation.
 */
export const OPT_IN_CONFIRMATION =
  "Den Defenders: You're resubscribed to texts about your consultation, quote or appointment. Msg&data rates may apply. Reply HELP for help, STOP to opt out.";

/** Opt-out sources Twilio doesn't know about (Twilio never blocked the number). */
export const DENNY_ONLY_OPT_OUT_SOURCES = new Set(["keyword_extra", "ai_detected"]);

// ---------------------------------------------------------------------------
// Sending hours and holidays
// ---------------------------------------------------------------------------

/**
 * Who/what is sending:
 *   reply      - an automatic (AI) answer to a text they sent in the last 24 hours
 *   manual     - a person typing in Denny
 *   automated  - drip and follow-ups nobody asked for just now
 *   opt_out_confirmation - the one confirmation after an opt-out (internal only)
 *   opt_in_confirmation  - the one confirmation after START, when Twilio won't send it (internal only)
 */
export type SendKind = "reply" | "manual" | "automated" | "opt_out_confirmation" | "opt_in_confirmation";

/** Keyword confirmations: sent right away, any hour, once per keyword. */
export function isConfirmationKind(kind: SendKind): kind is "opt_out_confirmation" | "opt_in_confirmation" {
  return kind === "opt_out_confirmation" || kind === "opt_in_confirmation";
}

/** [start hour, end hour) in the customer's local time. */
export const SENDING_HOURS: Record<Exclude<SendKind, "opt_out_confirmation" | "opt_in_confirmation">, [number, number]> = {
  reply: [8, 19],      // 8 AM - 7 PM (Melanie, 2026-10-22)
  manual: [8, 21],     // 8 AM - 9 PM (quiet-hours rule)
  automated: [9, 17],  // 9 AM - 5 PM (Melanie, 2026-10-22)
};

export type LocalTime = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

export function safeTimeZone(zone: string | null | undefined): string {
  if (!zone) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

export function localTime(now: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimeZone(timeZone),
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", weekday: "short", hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: weekdays.indexOf(get("weekday")),
  };
}

export function withinSendingHours(kind: SendKind, local: LocalTime): boolean {
  if (isConfirmationKind(kind)) return true;
  const [start, end] = SENDING_HOURS[kind];
  return local.hour >= start && local.hour < end;
}

export function describeHours(kind: SendKind): string {
  if (isConfirmationKind(kind)) return "any time";
  const [start, end] = SENDING_HOURS[kind];
  const fmt = (h: number) => `${((h + 11) % 12) + 1} ${h < 12 ? "AM" : "PM"}`;
  return `${fmt(start)}–${fmt(end)}`;
}

/** Day of month of the nth given weekday (0=Sun) in a month; n=-1 = last. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastWeekday = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return lastDay - ((lastWeekday - weekday + 7) % 7);
}

/** Western Easter Sunday (Anonymous Gregorian algorithm). */
function easter(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** No automated texts on these days (decided 2026-10-22). Returns the holiday name or null. */
export function holidayName(local: Pick<LocalTime, "year" | "month" | "day">): string | null {
  const { year, month, day } = local;
  const is = (m: number, d: number) => month === m && day === d;
  if (is(1, 1)) return "New Year's Day";
  if (is(7, 4)) return "Independence Day";
  if (is(12, 24)) return "Christmas Eve";
  if (is(12, 25)) return "Christmas Day";
  if (is(12, 31)) return "New Year's Eve";
  const e = easter(year);
  if (is(e.month, e.day)) return "Easter Sunday";
  if (is(5, nthWeekday(year, 5, 0, 2))) return "Mother's Day";
  if (is(5, nthWeekday(year, 5, 1, -1))) return "Memorial Day";
  if (is(6, nthWeekday(year, 6, 0, 3))) return "Father's Day";
  if (is(9, nthWeekday(year, 9, 1, 1))) return "Labor Day";
  if (is(11, nthWeekday(year, 11, 4, 4))) return "Thanksgiving";
  return null;
}

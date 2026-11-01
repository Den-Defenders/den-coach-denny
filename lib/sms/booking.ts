/**
 * lib/sms/booking.ts
 *
 * Texting step 4a: the AI offers REAL open consultation times and hands the one
 * the customer picks to a CSR, who books it in ServiceTitan. The AI never books.
 *
 *   find_open_times   -> recommend_sales_schedule (read-only, same M2M login and
 *                        reduction as the website bot: lib/websiteBotMcp.ts).
 *                        The customer and the AI only ever see date + arrival window;
 *                        the rep the scheduler picked stays on the server.
 *   choose_time       -> the customer picked one of the offered times
 *   request_booking   -> name + street address known: re-check the time at the street
 *                        address, then a "📅 Ready to book" handoff (pinned to the top
 *                        of Needs CSR + Slack alert) with everything the CSR needs.
 *
 * What we offered and what they picked live in the customer's notes under "_" keys
 * (code-only, hidden from the prompt's notes list), so the Simulator works the same way.
 */
import {
  findOpenSalesTimesWithReps,
  resolveSlotForBooking,
  type AvailabilityRequest,
  type RepTimeOption,
} from "@/lib/websiteBotMcp";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Times we show the customer per lookup. */
export const MAX_TIMES_OFFERED = 3;
/** Scheduler lookups per customer per day (each one is a ServiceTitan call). */
export const MAX_LOOKUPS_PER_DAY = 4;
/** Send the short "checking our calendar" text only when the lookup takes longer than this. */
export const LOOKUP_SLOW_MS = 8000;
const LOOKUP_TIMEOUT_MS = 40_000;
const ADDRESS_CHECK_TIMEOUT_MS = 25_000;

/** The one extra text while a slow lookup runs (~1.2¢). Sent as sent_by CHECKING_SENDER. */
export const CHECKING_TEXT = "Checking our calendar now, one moment.";

// Notes keys (code-only: "_" keys never show in the prompt's notes list or the inbox)
export const OPEN_TIMES_KEY = "_open_times";
export const CHOSEN_TIME_KEY = "_chosen_time";
export const LOOKUPS_KEY = "_time_lookups";

// ---------------------------------------------------------------------------
// Test hooks (swap the scheduler)
// ---------------------------------------------------------------------------

type FindTimes = (request: AvailabilityRequest, timeoutMs: number) => Promise<{ status: "options" | "none" | "outside_service_area"; options: RepTimeOption[] }>;
type CheckAddress = (fullAddress: string, date: string, windowLabel: string, timeoutMs: number) => Promise<{ consultantName: string } | null>;

const realFindTimes: FindTimes = (request, timeoutMs) => findOpenSalesTimesWithReps(request, timeoutMs);
const realCheckAddress: CheckAddress = async (fullAddress, date, windowLabel, timeoutMs) => {
  const slot = await resolveSlotForBooking(fullAddress, date, windowLabel, timeoutMs);
  return slot ? { consultantName: slot.consultantName } : null;
};

let findTimesImpl: FindTimes = realFindTimes;
let checkAddressImpl: CheckAddress = realCheckAddress;
let slowMs = LOOKUP_SLOW_MS;

export function setBookingDepsForTests(deps: { findTimes?: FindTimes; checkAddress?: CheckAddress; slowMs?: number } | null) {
  findTimesImpl = deps?.findTimes ?? realFindTimes;
  checkAddressImpl = deps?.checkAddress ?? realCheckAddress;
  slowMs = deps?.slowMs ?? LOOKUP_SLOW_MS;
}

export function lookupOpenTimes(request: AvailabilityRequest) {
  return findTimesImpl(request, LOOKUP_TIMEOUT_MS);
}

export function checkTimeAtAddress(fullAddress: string, date: string, windowLabel: string) {
  return checkAddressImpl(fullAddress, date, windowLabel, ADDRESS_CHECK_TIMEOUT_MS);
}

/** Resolves true if `work` is still running after the slow threshold (then the caller sends the checking text). */
export function isSlow(work: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), slowMs); });
  const done = work.then(() => false, () => false);
  return Promise.race([slow, done]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Times: how they're stored and said
// ---------------------------------------------------------------------------

/** One offered time. `rep` is server-side only (never in the prompt or a text). */
export type OfferedTime = { n: number; date: string; weekday: string; window: string; rep: string | null };
export type OpenTimesNote = { zip: string; at: string; times: OfferedTime[] };
export type ChosenTime = OfferedTime;

/** "8 AM - 12 PM" -> "8 AM to 12 PM" (no dashes in texts). */
export function windowWords(label: string): string {
  return label.replace(/\s*-\s*/, " to ");
}

/** "Tuesday, Nov 4" */
export function dayWords(date: string, weekday?: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(d);
  const wd = weekday || new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(d);
  return `${wd}, ${month} ${d.getUTCDate()}`;
}

/** "Tuesday, Nov 4, arriving between 8 AM and 12 PM" */
export function timeWords(t: { date: string; weekday?: string; window: string }): string {
  return `${dayWords(t.date, t.weekday)}, arriving between ${t.window.replace(/\s*-\s*/, " and ")}`;
}

/** Short form for alerts and the inbox: "Tue, Nov 4 · 8 AM to 12 PM" */
export function shortTimeWords(t: { date: string; weekday?: string; window: string }): string {
  return `${dayWords(t.date, t.weekday?.slice(0, 3))} · ${windowWords(t.window)}`;
}

function parseJson<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export function openTimesFrom(notes: Record<string, string>): OpenTimesNote | null {
  const v = parseJson<OpenTimesNote>(notes[OPEN_TIMES_KEY]);
  return v && Array.isArray(v.times) ? v : null;
}

export function chosenTimeFrom(notes: Record<string, string>): ChosenTime | null {
  const v = parseJson<ChosenTime>(notes[CHOSEN_TIME_KEY]);
  return v && v.date && v.window ? v : null;
}

/** Find an offered time by its number (1-3) or by date (+ window when the day has two). */
export function matchOffered(times: OfferedTime[], pick: { option?: unknown; date?: unknown; window?: unknown }): OfferedTime | null {
  const n = Number(pick.option);
  if (Number.isInteger(n) && n > 0) return times.find((t) => t.n === n) || null;
  const date = typeof pick.date === "string" ? pick.date.trim() : "";
  if (!date) return null;
  const sameDay = times.filter((t) => t.date === date);
  if (sameDay.length <= 1) return sameDay[0] || null;
  const w = typeof pick.window === "string" ? pick.window.replace(/\s+/g, " ").toLowerCase() : "";
  return sameDay.find((t) => w && (t.window.toLowerCase() === w || windowWords(t.window).toLowerCase() === w)) || null;
}

/** "2026-11-01:2" -> today's count of lookups for this customer. */
export function lookupsToday(notes: Record<string, string>, today: string): number {
  const [day, count] = (notes[LOOKUPS_KEY] || "").split(":");
  return day === today ? Number(count) || 0 : 0;
}

/** Nevada needs 2+ doors (a double / French set counts as two). */
export function hasTwoOrMoreDoors(doorCount: string): boolean {
  return /\b([2-9]|\d{2,}|two|three|four|five|six|double|doubles|french|pair|both)\b/i.test(doorCount || "");
}

export function partOfDay(value: unknown): Pick<AvailabilityRequest, "earliestStartTime" | "latestStartTime"> {
  if (value === "morning") return { latestStartTime: "11:00" };
  if (value === "afternoon") return { earliestStartTime: "12:00" };
  return {};
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
export function weekdaysArg(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map(String).filter((d) => WEEKDAYS.includes(d));
  return out.length ? out : undefined;
}

export function datesArg(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map(String).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 5);
  return out.length ? out : undefined;
}

// ---------------------------------------------------------------------------
// The "Ready to book" record (sms_conversations.booking_request)
// ---------------------------------------------------------------------------

export type SlotCheck = "open_at_address" | "zip_only" | "check_failed";

export type BookingRequest = {
  chosen: { date: string; weekday: string; window: string };
  backup: { date: string; weekday: string; window: string; customerSaidOk: boolean } | null;
  suggestedRep: string | null;
  name: string | null;
  address: string | null;
  zip: string | null;
  area: string | null;
  product: string | null;
  doorCount: string | null;
  slotCheck: SlotCheck;
  requestedAt: string;
};

export function bookingFrom(value: unknown): BookingRequest | null {
  let v: unknown = value;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { v = null; } }
  if (!v || typeof v !== "object") return null;
  const b = v as BookingRequest;
  return b.chosen?.date && b.chosen?.window ? b : null;
}

const SLOT_CHECK_WORDS: Record<SlotCheck, string> = {
  open_at_address: "still open when re-checked at the street address",
  zip_only: "⚠️ checked by ZIP only (no street address yet); make sure it's open before booking",
  check_failed: "⚠️ couldn't re-check at the street address; make sure it's open before booking",
};

export function slotCheckWords(check: SlotCheck): string {
  return SLOT_CHECK_WORDS[check] || "";
}

/** Plain lines a CSR copies into ServiceTitan (inbox "Copy" button and the handoff summary). */
export function bookingLines(b: BookingRequest, phoneLabel: string, notes: Record<string, string> = {}): string[] {
  const otherNotes = Object.entries(notes)
    .filter(([k, v]) => v && !k.startsWith("_") && !["first_name", "product", "door_count", "zip"].includes(k))
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
    .join("; ");
  return [
    `Time picked: ${shortTimeWords(b.chosen)}`,
    b.backup ? `Backup: ${shortTimeWords(b.backup)}${b.backup.customerSaidOk ? " (customer said it works)" : " (offered, customer didn't pick)"}` : "Backup: none offered",
    `Suggested rep: ${b.suggestedRep || "scheduler didn't name one"}`,
    `Name: ${b.name || "not given"}`,
    `Phone: ${phoneLabel}`,
    `Address: ${[b.address || "not given", b.zip && !(b.address || "").includes(b.zip) ? b.zip : ""].filter(Boolean).join(", ")}${b.area ? ` (${b.area})` : ""}`,
    `Project: ${[b.product, b.doorCount].filter(Boolean).join(", ") || "not given"}`,
    otherNotes ? `Notes: ${otherNotes}`.slice(0, 500) : "",
    `Time check: ${slotCheckWords(b.slotCheck)}`,
  ].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Never "booked", "scheduled" or "confirmed" (the AI can't book)
// ---------------------------------------------------------------------------

const BOOKED_WORDS = /\b(booked|scheduled|confirmed|reserved|locked in|you'?re all set|all set for|see you (on|then|monday|tuesday|wednesday|thursday|friday|tomorrow))\b/i;
const NEGATED = /\b(not|n't|nothing|until|yet|once|before)\b/i;

/** A sentence that tells the customer something is on the calendar. */
export function claimsBooked(reply: string): boolean {
  return reply.split(/(?<=[.?!])\s+|\n+/).some((s) => BOOKED_WORDS.test(s) && !NEGATED.test(s));
}

/** Last resort: drop those sentences. */
export function withoutBookingClaim(reply: string): string {
  return reply
    .split("\n\n")
    .map((part) => part.split(/(?<=[.?!])\s+/).filter((s) => !(BOOKED_WORDS.test(s) && !NEGATED.test(s))).join(" ").trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Used when nothing is left after removing a booking claim. */
export const SAFE_BOOKING_GOODBYE = "Thanks! I've passed your time to our team. A team member will text you shortly to finish setting it up.";

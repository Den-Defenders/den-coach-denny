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

// --- Session 6: product / door count only from the customer's own words ---------------
// On Nov 4 (Melanie's test lead) the AI answered "Sure" by guessing "security door
// (Centurion)" + "single" (copied from a tool example); code saved both as notes and the AI
// quoted a single-door price nobody asked for. These checks make sure a product or door
// count only counts when the customer (their texts or their lead form) actually said it.

const PRODUCT_WORDS = new Set([
  "door", "doors", "slider", "sliders", "sliding", "patio", "screen", "screens", "window", "windows",
  "centurion", "artisan", "woodhaven", "vistaluxe", "storm", "french", "front", "entry", "back", "side",
  "garage", "clearbreeze", "gate", "single", "double", "doubles",
]);
/** Count words, normalized so "one door" backs up "single" and "pair" backs up "double". */
const COUNT_WORDS: Record<string, string> = {
  single: "1", one: "1", "1": "1",
  double: "2", doubles: "2", french: "2", pair: "2", both: "2", two: "2", "2": "2",
  three: "3", "3": "3", four: "4", "4": "4", five: "5", "5": "5", six: "6", "6": "6",
};

function words(text: string): string[] {
  return (text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

/**
 * True when every product word in the AI's value comes from what the customer wrote
 * ("front door" from "my front door" is fine; "security door (Centurion)" from "I need a door" is not).
 */
export function customerSaidProduct(value: string, customerWords: string): boolean {
  const said = new Set(words(customerWords));
  const used = words(value).filter((w) => PRODUCT_WORDS.has(w));
  return used.length > 0 && used.every((w) => said.has(w) || (w === "doors" && said.has("door")) || (w === "door" && said.has("doors")));
}

/**
 * Door counts the customer actually wrote. "single", "double" and "French" count anywhere;
 * a number word ("one", "2", "both", "pair") only next to a door word ("two doors",
 * "one slider") or as the whole text ("2", "just one"). Simulator test 2026-11-04:
 * "The first one works" (picking a time) was read as "one door" = single.
 */
function customerCounts(customerWords: string): Set<string> {
  const said = new Set<string>();
  const NUM = "one|two|three|four|five|six|[1-9]|pair|both";
  for (const line of (customerWords || "").toLowerCase().split("\n")) {
    for (const m of line.matchAll(/\b(single|double|doubles|french)\b/g)) said.add(COUNT_WORDS[m[1]]);
    const nearDoor = new RegExp(`\\b(${NUM})\\b(?:\\s+[a-z]+){0,2}?\\s+(doors?|sliders?|windows?|screens?|entr(?:y|ies)|openings?)\\b`, "g");
    for (const m of line.matchAll(nearDoor)) said.add(COUNT_WORDS[m[1]]);
    const alone = new RegExp(`^\\s*(?:just|only)?\\s*(?:the\\s+)?(${NUM})\\s*(?:of them)?\\s*[.!]*\\s*$`);
    const a = alone.exec(line);
    if (a) said.add(COUNT_WORDS[a[1]]);
    if (/\b(just|only)\s+(the\s+)?one\b/.test(line)) said.add("1");
  }
  said.delete(undefined as unknown as string);
  return said;
}

/** True when every count in the AI's door count matches a count the customer wrote. */
export function customerSaidDoorCount(value: string, customerWords: string): boolean {
  const said = customerCounts(customerWords);
  const big = (t: string): string[] => t.match(/\b\d{2,}\b/g) || [];
  const used = words(value).map((w) => COUNT_WORDS[w]).filter(Boolean);
  if (!used.length) return big(value).length > 0 && big(value).every((n) => big(customerWords).includes(n));
  return used.every((n) => said.has(n));
}

/** Front door / French doors / slider / windows: enough to tell the team what the visit is for. */
export function doorTypeKnown(text: string): boolean {
  return /\b(front|entry|single|double|doubles|french|slider|sliders|sliding|windows?|vistaluxe|storm)\b/i.test(text || "");
}

/**
 * The door type in the customer's own texts (newest first), e.g. "front door", "French doors",
 * "sliding patio door". Used when the AI didn't save their answer (Simulator test 2026-11-04 4:35 PM:
 * "Front door" was answered but the card said "customer didn't say").
 */
export function doorTypeFromCustomer(customerTexts: string[]): string {
  const PHRASE = /\b(sliding patio doors?|patio sliders?|sliding (?:glass |screen |security )?doors?|sliders?|french doors?|double (?:front |entry )?doors?|single (?:front |entry )?door|front doors?|entry doors?|side doors?|back doors?|window screens?|windows|vistaluxe|storm doors?)\b/i;
  for (let i = customerTexts.length - 1; i >= 0; i--) {
    const m = PHRASE.exec(customerTexts[i] || "");
    if (m) return m[1].toLowerCase().replace(/\bfrench\b/, "French").replace(/\bvistaluxe\b/, "VistaLuxe");
  }
  return "";
}

/** The door-type question the AI asks before request_booking (no price in it). */
export const DOOR_TYPE_QUESTION = "Which door is this for: a front door, French doors, or a sliding patio door?";

/** We already asked them which door type (so a skipped answer doesn't block the booking). */
export function askedDoorType(ourTexts: string[]): boolean {
  return ourTexts.some((t) => /\?/.test(t) && /french doors?/i.test(t) && /slid(ing|er)/i.test(t));
}

/** "95610 (from their form, not checked yet)" -> "95610". */
export function zipFromNotes(notes: Record<string, string>): string {
  for (const key of ["zip", "form_zip"]) {
    const m = /\b(\d{5})\b/.exec(notes[key] || "");
    if (m) return m[1];
  }
  return "";
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
  /** Set when code made the request because the AI skipped request_booking: name/address are probably in here. */
  lastText?: string | null;
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

/** Plain-words names for the AI's saved notes, for the team (alerts, cards). */
const TEAM_NOTE_LABELS: Record<string, string> = {
  need: "why they're looking",
  door_count: "door count",
  decision_makers: "decision makers",
  preferred_days: "preferred days",
  photos_sent: "photos sent",
  first_name: "first name",
};

export function teamNoteLabel(key: string): string {
  return TEAM_NOTE_LABELS[key] || key.replace(/_/g, " ");
}

/** The AI's notes as one line for the team. Code-only "_" keys never show. */
export function teamNotesText(notes: Record<string, string>, skip: string[] = []): string {
  return Object.entries(notes)
    .filter(([k, v]) => v && !k.startsWith("_") && !skip.includes(k))
    .map(([k, v]) => `${teamNoteLabel(k)}: ${v}`)
    .join("; ");
}

/** Plain lines a CSR copies into ServiceTitan (inbox "Copy" button and the handoff summary). */
export function bookingLines(b: BookingRequest, phoneLabel: string, notes: Record<string, string> = {}): string[] {
  // Already in their own lines, or not needed to book (which photos we texted).
  const otherNotes = teamNotesText(notes, ["first_name", "product", "door_count", "zip", "photos_sent"]);
  return [
    `Time picked: ${shortTimeWords(b.chosen)}`,
    b.backup ? `Backup: ${shortTimeWords(b.backup)}${b.backup.customerSaidOk ? " (customer said it works)" : " (offered, customer didn't pick)"}` : "Backup: none offered",
    `Suggested rep: ${b.suggestedRep || "scheduler didn't name one"}`,
    `Name: ${b.name || "not given"}`,
    `Phone: ${phoneLabel}`,
    `Address: ${[b.address || "not given", b.zip && !(b.address || "").includes(b.zip) ? b.zip : ""].filter(Boolean).join(", ")}${b.area ? ` (${b.area})` : ""}`,
    `Project: ${[b.product, b.doorCount].filter(Boolean).join(", ") || "customer didn't say (ask on the call)"}`,
    otherNotes ? `Notes: ${otherNotes}`.slice(0, 500) : "",
    b.lastText ? `Their last text: "${b.lastText.slice(0, 200)}" (name/address may be here)` : "",
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

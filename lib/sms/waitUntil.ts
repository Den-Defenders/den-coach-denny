/**
 * lib/sms/waitUntil.ts
 *
 * "Check back later" (Steven, 2026-11-22, after Antonia texted "Ok after holiday" and her
 * AI follow-up was still due two days before Thanksgiving).
 *
 * When a customer asks us to reach out later, a date is saved in the customer's notes
 * (code-only "_" keys, never shown to the AI as notes or put in Slack):
 *   _wait_until  "2026-11-30" (or "none" = cleared)
 *   _wait_said   their words, e.g. "Ok after holiday"
 *   _wait_by     "ai" (check_back_later tool), "code" (holiday words below) or a team member's email
 * AI follow-ups (lib/sms/followup.ts) don't go out before 9 AM their time on that date.
 * The drip isn't affected (it stops as soon as they reply).
 *
 * Who sets it:
 *   - code, when their text says "after the holiday(s) / Thanksgiving / Christmas / New Year's…"
 *   - the AI (check_back_later) for anything else: "next month", "when my husband is back on the 10th"
 *   - a CSR in the inbox (📅 Wait until…)
 * Dates are calendar dates (Pacific "today"); the follow-up turns it into 9 AM in their time zone.
 */
import { DEFAULT_TIME_ZONE, holidayName, localTime } from "@/lib/sms/rules";

export const WAIT_UNTIL_KEY = "_wait_until";
export const WAIT_SAID_KEY = "_wait_said";
export const WAIT_BY_KEY = "_wait_by";
/** Saved in _wait_until when someone clears it (empty values can't be saved in notes). */
export const WAIT_CLEARED = "none";
/** Furthest a wait may go. */
export const MAX_WAIT_DAYS = 180;
/** "After the holiday" with no name: the next holiday within this many days. */
const UNNAMED_HOLIDAY_DAYS = 21;
/** A named holiday ("after Christmas") must be this close, or we leave it to the AI. */
const NAMED_HOLIDAY_DAYS = 60;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parts(ymd: string) {
  const [year, month, day] = ymd.split("-").map(Number);
  return { year, month, day };
}

export function addDaysYmd(ymd: string, days: number): string {
  const { year, month, day } = parts(ymd);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function weekday(ymd: string): number {
  const { year, month, day } = parts(ymd);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function isRealDate(ymd: string): boolean {
  if (!YMD.test(ymd)) return false;
  const { year, month, day } = parts(ymd);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** Today's calendar date (Pacific by default). */
export function todayYmd(now: Date, timeZone = DEFAULT_TIME_ZONE): string {
  const lt = localTime(now, timeZone);
  return `${lt.year}-${String(lt.month).padStart(2, "0")}-${String(lt.day).padStart(2, "0")}`;
}

/** "Mon, Nov 30" */
export function waitLabel(ymd: string): string {
  const { month, day } = parts(ymd);
  return `${WEEKDAYS[weekday(ymd)]}, ${MONTHS[month - 1]} ${day}`;
}

/** This day, or the next weekday that isn't a holiday. */
function firstWorkdayFrom(ymd: string): string {
  let d = ymd;
  for (let i = 0; i < 10 && (weekday(d) === 0 || weekday(d) === 6 || holidayName(parts(d))); i++) d = addDaysYmd(d, 1);
  return d;
}

/**
 * The first good day after a holiday. A holiday on Thursday (Thanksgiving, Christmas Eve 2026)
 * skips the long weekend: Monday. Otherwise the next weekday that isn't a holiday.
 */
export function dayAfterHoliday(holidayYmd: string): string {
  let d = addDaysYmd(holidayYmd, 1);
  if (weekday(holidayYmd) === 4) d = addDaysYmd(d, 1); // skip the Friday after a Thursday holiday
  return firstWorkdayFrom(d);
}

/** The next day (from today, today included) that is one of these holidays, within `withinDays`. */
function nextHoliday(fromYmd: string, names: string[] | null, withinDays: number): { ymd: string; name: string } | null {
  for (let i = 0; i <= withinDays; i++) {
    const d = addDaysYmd(fromYmd, i);
    const name = holidayName(parts(d));
    if (name && (!names || names.includes(name))) return { ymd: d, name };
  }
  return null;
}

/** Holidays a customer might name, and which day on our holiday list each one means. */
const NAMED_HOLIDAYS: Array<{ words: RegExp; names: string[] }> = [
  { words: /thanks\s*giving|turkey day/, names: ["Thanksgiving"] },
  { words: /christmas|x-?mas/, names: ["Christmas Day"] },
  { words: /new\s*year'?s?/, names: ["New Year's Day"] },
  { words: /easter/, names: ["Easter Sunday"] },
  { words: /memorial day/, names: ["Memorial Day"] },
  { words: /labor day/, names: ["Labor Day"] },
  { words: /(4th|fourth) of july|july (4th|fourth)|independence day/, names: ["Independence Day"] },
];

const HOLIDAY_WORDS = "holidays?|thanks\\s*giving|turkey day|christmas|x-?mas|new\\s*year'?s?|easter|memorial day|labor day|(?:4th|fourth) of july|july (?:4th|fourth)|independence day";
const AFTER_HOLIDAY = new RegExp(`\\b(after|past|until|till|til|once|following)\\b[^.?!\\n]{0,25}?\\b(${HOLIDAY_WORDS})\\b`, "i");
const HOLIDAYS_OVER = /\bholidays?\s+(are|is)\s+over\b/i;
/** Talking about the past ("after Christmas last year we got broken into"), not asking us to wait. */
const PAST = /\blast (year|time|christmas|thanksgiving|holiday)|\b(ago|happened|got broken|broke in)\b/i;

/**
 * Code's own read of their text: "Ok after holiday", "maybe after Thanksgiving",
 * "not until after the holidays", "once the holidays are over".
 * Null when it doesn't clearly say that (the AI's check_back_later covers everything else).
 */
export function waitFromText(text: string, now: Date): { date: string; said: string } | null {
  const body = (text || "").trim();
  if (!body) return null;
  const hit = AFTER_HOLIDAY.exec(body) || HOLIDAYS_OVER.exec(body);
  if (!hit || PAST.test(body)) return null;
  const word = (hit[2] || "holidays").toLowerCase();
  const today = todayYmd(now);
  const { month, day } = parts(today);
  let holiday: { ymd: string } | null = null;
  if (/^holidays?$/.test(word)) {
    // "after the holidays" in Nov/Dec (or on New Year's Day) = after New Year's Day.
    const endOfYear = word === "holidays" && (month >= 11 || (month === 1 && day === 1));
    holiday = endOfYear
      ? nextHoliday(today, ["New Year's Day"], NAMED_HOLIDAY_DAYS)
      : nextHoliday(today, null, UNNAMED_HOLIDAY_DAYS);
  } else {
    const named = NAMED_HOLIDAYS.find((h) => h.words.test(word));
    holiday = named ? nextHoliday(today, named.names, NAMED_HOLIDAY_DAYS) : null;
  }
  if (!holiday) return null;
  const date = dayAfterHoliday(holiday.ymd);
  return date > today ? { date, said: body.slice(0, 160) } : null;
}

/** Checks a date someone picked (the AI or a CSR). */
export function checkWaitDate(date: unknown, now: Date): { ok: true; date: string } | { ok: false; message: string } {
  const ymd = String(date || "").trim();
  if (!isRealDate(ymd)) return { ok: false, message: "Use a date like 2026-11-30." };
  const today = todayYmd(now);
  if (ymd <= today) return { ok: false, message: "Pick a day after today." };
  if (ymd > addDaysYmd(today, MAX_WAIT_DAYS)) return { ok: false, message: `Pick a day within ${MAX_WAIT_DAYS} days.` };
  return { ok: true, date: ymd };
}

/** The saved wait date (YYYY-MM-DD), or null when there isn't one or it was cleared. */
export function waitDateFrom(notes: Record<string, unknown> | null | undefined): string | null {
  const value = String(notes?.[WAIT_UNTIL_KEY] || "").trim();
  return isRealDate(value) ? value : null;
}

/** The notes to save for a wait (or a clear). */
export function waitNotes(date: string | null, said: string, by: string): Record<string, string> {
  return date
    ? { [WAIT_UNTIL_KEY]: date, [WAIT_SAID_KEY]: (said || "-").slice(0, 160), [WAIT_BY_KEY]: by.slice(0, 80) }
    : { [WAIT_UNTIL_KEY]: WAIT_CLEARED, [WAIT_SAID_KEY]: "-", [WAIT_BY_KEY]: by.slice(0, 80) };
}

/** Their words, if any were saved ("-" = none). */
export function waitSaidFrom(notes: Record<string, unknown> | null | undefined): string {
  const said = String(notes?.[WAIT_SAID_KEY] || "").trim();
  return said && said !== "-" ? said : "";
}

/** Dates the AI may need for check_back_later (it's bad at date math). */
export function dateHints(now: Date): string[] {
  const today = todayYmd(now);
  const { month } = parts(today);
  const fmt = (ymd: string) => `${waitLabel(ymd)} (${ymd})`;
  const lines = [`Today: ${fmt(today)}`];
  for (const name of ["Thanksgiving", "Christmas Day", "New Year's Day"]) {
    const h = nextHoliday(today, [name], NAMED_HOLIDAY_DAYS);
    if (h) lines.push(`After ${name === "Christmas Day" ? "Christmas" : name === "New Year's Day" ? "New Year's" : name} (${waitLabel(h.ymd)}): ${fmt(dayAfterHoliday(h.ymd))}`);
  }
  if (month >= 11) {
    const ny = nextHoliday(today, ["New Year's Day"], NAMED_HOLIDAY_DAYS);
    if (ny) lines.push(`"After the holidays": ${fmt(dayAfterHoliday(ny.ymd))}`);
  }
  const daysToMonday = ((8 - weekday(today)) % 7) || 7;
  lines.push(`Next week: ${fmt(firstWorkdayFrom(addDaysYmd(today, daysToMonday)))}`);
  const { year } = parts(today);
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  lines.push(`Next month: ${fmt(firstWorkdayFrom(nextMonth))}`);
  return lines;
}

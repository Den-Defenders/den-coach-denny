/**
 * lib/sms/ownership.ts
 *
 * Session 7: CSR ownership rules (Steven, 2026-11-11). PR 1 = auto-release.
 *
 * When a CSR owns a chat and the customer is waiting for a person, someone always
 * answers, even if the owner is off that day: after 60 minutes of TEAM TIME with no
 * reply from a person, the chat goes back to the shared queue (assigned_to = null),
 * Slack gets "⏰ Released … @here" naming the owner, and the inbox shows
 * "Released from <owner> (no reply in 1 hr)". Needs CSR stays on and the AI stays paused.
 *
 * Team clock: Mon–Sat, 8:00 AM–4:00 PM Pacific. Only minutes inside that window count,
 * and the company holidays in lib/sms/rules.ts don't count either.
 *   text at 10:00 AM            → released 11:00 AM
 *   text at 3:30 PM             → 30 min today + 30 min next work day → 8:30 AM
 *   text at 6 PM / Sat 5 PM / Sun → 9:00 AM the next work day
 *
 * The clock starts at the customer's first unanswered text (more texts don't restart it),
 * or when the current owner got the chat, whichever is later (a CSR who just took a
 * chat that already waited 3 hours still gets their hour). Any text from a person stops
 * it, and so does "Mark handled". Hold texts, "checking our calendar" texts, drip and
 * the AI's handoff goodbye don't count as a reply. AI texts DO answer the customer while
 * the AI is in charge (AI on, or sent before the AI handed off).
 *
 * Runs in /api/sms/timer (every 5 minutes), so releases land within ~5 minutes of the hour.
 */
import { postAutoReleaseAlert } from "@/lib/sms/alerts";
import { classifyKeyword, holidayName, localTime } from "@/lib/sms/rules";
import {
  CHECKING_SENDER,
  HOLD_SENDER,
  audit,
  autoReleaseConversation,
  messagesSince,
  ownedConversationsWithNewTexts,
  type OwnedConversation,
  type WaitMessage,
} from "@/lib/sms/store";
import { findTeamMember, teamDatabaseConfigured } from "@/lib/teamStore";

// ---------------------------------------------------------------------------
// Team clock
// ---------------------------------------------------------------------------

export const TEAM_CLOCK_ZONE = "America/Los_Angeles";
/** Mon (1) to Sat (6). */
export const TEAM_CLOCK_DAYS = new Set([1, 2, 3, 4, 5, 6]);
export const TEAM_CLOCK_START_HOUR = 8;
export const TEAM_CLOCK_END_HOUR = 16;
export const TEAM_CLOCK_TEXT = "Mon–Sat 8 AM–4 PM";
export const AUTO_RELEASE_MINUTES = 60;

/** Wall-clock time in a zone → the real instant (DST-safe). */
function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, zone: string): Date {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const l = localTime(new Date(guess), zone);
    const shown = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute);
    const diff = wanted - shown;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

type Day = { year: number; month: number; day: number; weekday: number };

function nextDay(d: Day): Day {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + 1));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate(), weekday: t.getUTCDay() };
}

/** The team's working window on one Pacific calendar day, or null (Sunday or a holiday). */
function teamWindow(d: Day): [number, number] | null {
  if (!TEAM_CLOCK_DAYS.has(d.weekday) || holidayName(d)) return null;
  return [
    zonedToUtc(d.year, d.month, d.day, TEAM_CLOCK_START_HOUR, 0, TEAM_CLOCK_ZONE).getTime(),
    zonedToUtc(d.year, d.month, d.day, TEAM_CLOCK_END_HOUR, 0, TEAM_CLOCK_ZONE).getTime(),
  ];
}

function dayOf(at: Date): Day {
  const l = localTime(at, TEAM_CLOCK_ZONE);
  return { year: l.year, month: l.month, day: l.day, weekday: l.weekday };
}

/** The instant when `minutes` of team time have passed after `start`. */
export function addTeamMinutes(start: Date, minutes: number): Date {
  let remaining = minutes * 60_000;
  let day = dayOf(start);
  for (let i = 0; i < 60; i++) {
    const window = teamWindow(day);
    if (window) {
      const from = Math.max(start.getTime(), window[0]);
      if (from < window[1]) {
        const available = window[1] - from;
        if (available >= remaining) return new Date(from + remaining);
        remaining -= available;
      }
    }
    day = nextDay(day);
  }
  return new Date(start.getTime() + 60 * 24 * 3600_000); // never reached in practice
}

/** Minutes of team time between two instants (0 if end is before start). */
export function teamMinutesBetween(start: Date, end: Date): number {
  if (end.getTime() <= start.getTime()) return 0;
  let total = 0;
  let day = dayOf(start);
  const last = dayOf(end);
  for (let i = 0; i < 400; i++) {
    const window = teamWindow(day);
    if (window) {
      const from = Math.max(start.getTime(), window[0]);
      const to = Math.min(end.getTime(), window[1]);
      if (to > from) total += to - from;
    }
    if (day.year === last.year && day.month === last.month && day.day === last.day) break;
    day = nextDay(day);
  }
  return Math.round(total / 60_000);
}

// ---------------------------------------------------------------------------
// Is the customer waiting for a person, and since when?
// ---------------------------------------------------------------------------

/** A text from a person (a team member's login), not the AI, drip or an automatic text. */
export function isPersonSender(sentBy: string | null): boolean {
  if (!sentBy) return false;
  return !sentBy.startsWith("denny-") && sentBy !== "system" && sentBy !== "drip";
}

const AI_SENDERS = new Set(["denny-ai", "denny-followup"]);

/**
 * When the customer started waiting for a person (their first unanswered text), or null
 * if nobody is waiting. `messages` = texts after the last person text / "Mark handled",
 * oldest first.
 */
export function waitingSince(
  messages: WaitMessage[],
  state: { botStatus: "on" | "paused"; handoffAt: string | null },
): Date | null {
  const handoffAt = state.handoffAt ? Date.parse(state.handoffAt) : null;
  let since: number | null = null;
  for (const m of messages) {
    const at = Date.parse(m.createdAt);
    if (m.direction === "inbound") {
      if (classifyKeyword(m.body, { optedOut: false }).keyword !== null) continue; // STOP/START/HELP: Twilio answers
      if (since === null) since = at;
      continue;
    }
    if (m.status === "send_failed") continue;
    if (isPersonSender(m.sentBy)) {
      since = null;
      continue;
    }
    if (m.sentBy === HOLD_SENDER || m.sentBy === CHECKING_SENDER) continue;
    // The AI answered while it was in charge (AI on, or before it handed off).
    // After a handoff its goodbye isn't an answer: the customer still waits for a person.
    if (m.sentBy && AI_SENDERS.has(m.sentBy) && (state.botStatus === "on" || handoffAt === null || at < handoffAt)) {
      since = null;
    }
  }
  return since === null ? null : new Date(since);
}

/** When the owner's hour runs out: 60 team minutes after max(first unanswered text, when they got the chat). */
export function releaseDeadline(waitStart: Date, assignedAt: string | null): Date {
  const owned = assignedAt ? Date.parse(assignedAt) : 0;
  const start = new Date(Math.max(waitStart.getTime(), owned || 0));
  return addTeamMinutes(start, AUTO_RELEASE_MINUTES);
}

/** For the inbox: when this owned chat goes back to the queue if nobody replies (null = not waiting / not owned). */
export function releasePlan(
  conv: { assignedTo: string | null; assignedAt: string | null; botStatus: "on" | "paused"; handoffAt: string | null; handoffResolvedAt: string | null; optedOut: boolean },
  messages: WaitMessage[],
): { waitingSince: Date; releaseAt: Date } | null {
  if (!conv.assignedTo || conv.optedOut) return null;
  const resolved = conv.handoffResolvedAt ? Date.parse(conv.handoffResolvedAt) : 0;
  const lastPerson = Math.max(0, ...messages.filter((m) => m.direction === "outbound" && m.status !== "send_failed" && isPersonSender(m.sentBy)).map((m) => Date.parse(m.createdAt)));
  const anchor = Math.max(resolved, lastPerson);
  const since = waitingSince(messages.filter((m) => Date.parse(m.createdAt) > anchor), conv);
  if (!since) return null;
  return { waitingSince: since, releaseAt: releaseDeadline(since, conv.assignedAt) };
}

/** "Thu 8:30 AM" in Pacific time, for Slack and the inbox. */
export function pacificWhen(at: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: TEAM_CLOCK_ZONE, weekday: "short", hour: "numeric", minute: "2-digit" }).format(at);
}

// ---------------------------------------------------------------------------
// Timer step
// ---------------------------------------------------------------------------

export type ReleaseCheck = { conversation: OwnedConversation; waitStart: Date; deadline: Date };

/** Owned chats where the customer is waiting for a person, with each owner's deadline. */
export async function ownedWaitingChats(owner?: string): Promise<ReleaseCheck[]> {
  const out: ReleaseCheck[] = [];
  for (const conversation of await ownedConversationsWithNewTexts(owner)) {
    const messages = await messagesSince(conversation.phone, conversation.anchorAt);
    const waitStart = waitingSince(messages, conversation);
    if (!waitStart) continue;
    out.push({ conversation, waitStart, deadline: releaseDeadline(waitStart, conversation.assignedAt) });
  }
  return out;
}

async function ownerName(email: string): Promise<string> {
  try {
    if (teamDatabaseConfigured()) {
      const member = await findTeamMember(email);
      if (member?.displayName) return member.displayName;
    }
  } catch (error) {
    console.error("SMS auto-release owner lookup failed:", error instanceof Error ? error.message : error);
  }
  return email.split("@")[0];
}

export type AutoReleaseResult = { checked: number; released: number; phones: string[] };

/** Release every owned chat whose owner's team hour has run out. Safe to run often. */
export async function runAutoReleases(now: Date, options: { budgetMs?: number } = {}): Promise<AutoReleaseResult> {
  const started = Date.now();
  const budget = options.budgetMs ?? 8_000;
  const result: AutoReleaseResult = { checked: 0, released: 0, phones: [] };
  for (const check of await ownedWaitingChats()) {
    if (Date.now() - started > budget) break;
    result.checked++;
    if (now.getTime() < check.deadline.getTime()) continue;
    const { conversation: c } = check;
    // Only if nothing changed since we looked (same owner, no person text in the meantime).
    const released = await autoReleaseConversation(c.phone, c.assignedTo, c.assignedAt, check.waitStart, now);
    if (!released) continue;
    result.released++;
    result.phones.push(c.phone);
    const name = await ownerName(c.assignedTo);
    await audit({
      phone: c.phone,
      action: "auto_released",
      reason: "no_reply_1_hour",
      detail: { from: c.assignedTo, waitingSince: check.waitStart.toISOString(), deadline: check.deadline.toISOString() },
      actor: "system",
    });
    await postAutoReleaseAlert(c.phone, name, [c.firstName, c.lastName].filter(Boolean).join(" ") || null, check.waitStart);
  }
  return result;
}

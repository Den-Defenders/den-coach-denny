/**
 * lib/sms/scoreboard.ts
 *
 * Session 7 PR 4 (Steven, 2026-11-11/13): manager scoreboard on the Texting page
 * (owners + managers only). One row per person:
 *   - Owns now        inbox chats they own (filed chats don't count)
 *   - Waiting now     owned chats where a customer is waiting for a person (same rule as auto-release)
 *   - Follow-ups due  their "My follow-ups" list right now
 *   - Replies / avg reply time   for the period: each time a customer waited for a person
 *                     and this person answered, measured in TEAM time (Mon–Sat 8 AM–4 PM Pacific),
 *                     so a 7 PM text answered at 8:05 the next morning counts as 5 minutes
 *   - Texts sent      texts they sent in the period
 *   - Auto-released   chats taken from them by the 1-hour rule in the period
 *   - Booked          "Booked in ServiceTitan" clicks in the period
 *
 * When does a wait start? At the customer's first text after the last person text. If the
 * AI answered and the customer texted again, the wait restarts at that newer text (the AI
 * was handling it). An AI handoff goodbye right before a person's reply doesn't restart it.
 */
import { followUpList } from "@/lib/sms/folders";
import { isPersonSender, ownedWaitingChats, teamMinutesBetween } from "@/lib/sms/ownership";
import { classifyKeyword } from "@/lib/sms/rules";
import { CHECKING_SENDER, HOLD_SENDER, smsDb } from "@/lib/sms/store";

export type ScoreRow = {
  email: string;
  ownsNow: number;
  waitingNow: number;
  followUpsDue: number;
  replies: number;
  avgReplyMinutes: number | null;
  /** Replies that took more than an hour of team time. */
  slowReplies: number;
  textsSent: number;
  autoReleased: number;
  booked: number;
};

export type Scoreboard = { since: string; rows: ScoreRow[] };

type Msg = { phone: string; direction: string; body: string; sentBy: string | null; status: string; at: number };

/** Reply episodes in the window: who answered and how many team minutes the customer waited. */
export function replyEpisodes(messages: Msg[], since: number): { by: string; minutes: number }[] {
  const out: { by: string; minutes: number }[] = [];
  let phone = "";
  let waitStart: number | null = null;
  let aiSince = false;
  for (const m of messages) {
    if (m.phone !== phone) {
      phone = m.phone;
      waitStart = null;
      aiSince = false;
    }
    if (m.direction === "inbound") {
      if (classifyKeyword(m.body, { optedOut: false }).keyword !== null) continue;
      if (waitStart === null || aiSince) waitStart = m.at;
      aiSince = false;
      continue;
    }
    if (m.status === "send_failed" || m.sentBy === HOLD_SENDER || m.sentBy === CHECKING_SENDER) continue;
    if (isPersonSender(m.sentBy)) {
      if (waitStart !== null && m.at >= since) out.push({ by: m.sentBy as string, minutes: teamMinutesBetween(new Date(waitStart), new Date(m.at)) });
      waitStart = null;
      aiSince = false;
      continue;
    }
    if (m.sentBy === "denny-ai" || m.sentBy === "denny-followup") aiSince = true;
  }
  return out;
}

function bump(map: Map<string, ScoreRow>, email: string): ScoreRow {
  const key = email.toLowerCase();
  let row = map.get(key);
  if (!row) {
    row = { email: key, ownsNow: 0, waitingNow: 0, followUpsDue: 0, replies: 0, avgReplyMinutes: null, slowReplies: 0, textsSent: 0, autoReleased: 0, booked: 0 };
    map.set(key, row);
  }
  return row;
}

/** The scoreboard since `since` (start of the period). `people` = everyone with inbox access, so zero rows show too. */
export async function buildScoreboard(since: Date, now: Date, people: string[]): Promise<Scoreboard> {
  const sql = await smsDb();
  const rows = new Map<string, ScoreRow>();
  for (const p of people) bump(rows, p);

  const owned = await sql`SELECT assigned_to, count(*)::int AS n FROM sms_conversations
    WHERE assigned_to IS NOT NULL AND folder IS NULL GROUP BY assigned_to`;
  for (const r of owned) bump(rows, String(r.assigned_to)).ownsNow = Number(r.n) || 0;

  for (const w of await ownedWaitingChats()) bump(rows, w.conversation.assignedTo).waitingNow++;
  for (const f of await followUpList(null, now)) if (f.owner && f.reason !== "scheduled") bump(rows, f.owner).followUpsDue++;

  // Texts from 3 days before the period too, so a wait that started earlier is measured fully.
  const lookback = new Date(since.getTime() - 3 * 24 * 3600_000).toISOString();
  const msgs = await sql`SELECT phone, direction, body, sent_by, status, created_at FROM sms_messages
    WHERE created_at > ${lookback}::timestamptz ORDER BY phone, created_at, id`;
  const list: Msg[] = msgs.map((m) => ({
    phone: String(m.phone),
    direction: String(m.direction),
    body: String(m.body || ""),
    sentBy: (m.sent_by as string) ?? null,
    status: String(m.status || ""),
    at: new Date(m.created_at as string).getTime(),
  }));
  const sinceMs = since.getTime();
  for (const m of list) {
    if (m.direction === "outbound" && m.at >= sinceMs && m.status !== "send_failed" && isPersonSender(m.sentBy)) bump(rows, m.sentBy as string).textsSent++;
  }
  const totals = new Map<string, number>();
  for (const e of replyEpisodes(list, sinceMs)) {
    const row = bump(rows, e.by);
    row.replies++;
    if (e.minutes > 60) row.slowReplies++;
    totals.set(row.email, (totals.get(row.email) || 0) + e.minutes);
  }
  for (const row of rows.values()) row.avgReplyMinutes = row.replies ? Math.round((totals.get(row.email) || 0) / row.replies) : null;

  const audits = await sql`SELECT action, actor, detail->>'from' AS released_from FROM sms_audit
    WHERE created_at >= ${since.toISOString()}::timestamptz AND action IN ('auto_released', 'booking_marked_booked')`;
  for (const a of audits) {
    if (a.action === "auto_released" && a.released_from) bump(rows, String(a.released_from)).autoReleased++;
    if (a.action === "booking_marked_booked" && a.actor && a.actor !== "staff") bump(rows, String(a.actor)).booked++;
  }

  // Busiest first: waiting now, then follow-ups due, then replies.
  const sorted = [...rows.values()].sort((a, b) => b.waitingNow - a.waitingNow || b.followUpsDue - a.followUpsDue || b.replies - a.replies || a.email.localeCompare(b.email));
  return { since: since.toISOString(), rows: sorted };
}

/** Start of the period: "today" = midnight Pacific; otherwise the last N days. */
export function periodStart(period: string, now: Date): Date {
  if (period === "today") {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now);
    for (const offset of ["-08:00", "-07:00"]) {
      const at = new Date(`${day}T00:00:00${offset}`);
      const back = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", hour: "2-digit", hourCycle: "h23" }).format(at);
      if (back === "00" && at.getTime() <= now.getTime()) return at;
    }
    return new Date(now.getTime() - 24 * 3600_000);
  }
  const days = period === "30" ? 30 : 7;
  return new Date(now.getTime() - days * 24 * 3600_000);
}

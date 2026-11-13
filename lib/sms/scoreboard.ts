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
 * When does a wait start? (made stricter 2026-11-13 after Steven saw long averages)
 *   - A wait starts at the customer's first text that nobody has answered yet.
 *   - While the AI is in charge, its answer ends the wait (the customer wasn't waiting on a person).
 *     The AI stops being in charge when it hands off (bot_handoff), someone pauses it or a person
 *     texts; it's in charge again after "Turn AI back on". So a CSR's follow-up text days after
 *     the AI answered is NOT a slow reply.
 *   - "Mark handled" ends the wait without a reply (nothing counted).
 *   - Texts that don't need an answer ("ok", "thanks", "👍", STOP/HELP…) don't start a wait.
 *   - Chats filed in 🗑️ Spam or 🧪 Test don't count anywhere on the scoreboard.
 * Average and typical (median) are both shown: one very slow reply pulls the average up,
 * the typical number shows what most customers experienced.
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
  /** Median: what most customers experienced. */
  typicalReplyMinutes: number | null;
  /** Replies that took more than an hour of team time. */
  slowReplies: number;
  textsSent: number;
  autoReleased: number;
  booked: number;
};

export type Scoreboard = { since: string; rows: ScoreRow[] };

type Msg = { phone: string; direction: string; body: string; sentBy: string | null; status: string; at: number };
/** Audit events that change who's in charge: bot_handoff, bot_paused, bot_resumed, handoff_handled. */
export type ChargeEvent = { phone: string; action: string; at: number };

/** Texts that don't ask for an answer. */
const NO_ANSWER_NEEDED = /^(ok(ay)?|k|kk|thanks?( you)?|thank u|thx|ty|cool|great|perfect|sounds good|got it|will do|awesome|nice|yes thanks|ok thanks?|ok thank you|👍|🙏|❤️|😊|🙂)[\s.!]*$/i;

export function needsAnswer(body: string): boolean {
  const text = body.trim();
  if (!text) return true; // a photo with no words still needs a look
  if (classifyKeyword(text, { optedOut: false }).keyword !== null) return false;
  return !NO_ANSWER_NEEDED.test(text);
}

/** Reply episodes in the window: who answered and how many team minutes the customer waited. */
export function replyEpisodes(messages: Msg[], since: number, events: ChargeEvent[] = []): { by: string; minutes: number }[] {
  // One timeline per phone: texts and charge events, oldest first (an event at the same moment goes first).
  type Item = { kind: "msg"; m: Msg } | { kind: "event"; e: ChargeEvent };
  const byPhone = new Map<string, Item[]>();
  for (const m of messages) (byPhone.get(m.phone) ?? byPhone.set(m.phone, []).get(m.phone)!).push({ kind: "msg", m });
  for (const e of events) byPhone.get(e.phone)?.push({ kind: "event", e });
  const out: { by: string; minutes: number }[] = [];
  for (const items of byPhone.values()) {
    items.sort((a, b) => (a.kind === "msg" ? a.m.at : a.e.at) - (b.kind === "msg" ? b.m.at : b.e.at) || (a.kind === "event" ? -1 : 1));
    let waitStart: number | null = null;
    let aiInCharge = true;
    let offAt: number | null = null;
    let lastInboundAt: number | null = null;
    for (const item of items) {
      if (item.kind === "event") {
        if (item.e.action === "bot_handoff" || item.e.action === "bot_paused") {
          aiInCharge = false;
          offAt = item.e.at;
        }
        else if (item.e.action === "bot_resumed") aiInCharge = true;
        else if (item.e.action === "handoff_handled") waitStart = null;
        continue;
      }
      const m = item.m;
      if (m.direction === "inbound") {
        lastInboundAt = m.at;
        if (waitStart === null && needsAnswer(m.body)) waitStart = m.at;
        continue;
      }
      if (m.status === "send_failed" || m.sentBy === HOLD_SENDER || m.sentBy === CHECKING_SENDER) continue;
      if (isPersonSender(m.sentBy)) {
        if (waitStart !== null && m.at >= since) out.push({ by: m.sentBy as string, minutes: teamMinutesBetween(new Date(waitStart), new Date(m.at)) });
        waitStart = null;
        aiInCharge = false; // a person's text pauses the AI
        continue;
      }
      // The AI answered while it was in charge: nobody was waiting on a person. An AI answer to a text
      // that came AFTER a handoff also means the AI is still on (a "soft" handoff keeps it answering).
      if ((m.sentBy === "denny-ai" || m.sentBy === "denny-followup") && (aiInCharge || (lastInboundAt !== null && offAt !== null && lastInboundAt > offAt))) {
        waitStart = null;
        aiInCharge = true;
      }
    }
  }
  return out;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function bump(map: Map<string, ScoreRow>, email: string): ScoreRow {
  const key = email.toLowerCase();
  let row = map.get(key);
  if (!row) {
    row = { email: key, ownsNow: 0, waitingNow: 0, followUpsDue: 0, replies: 0, avgReplyMinutes: null, typicalReplyMinutes: null, slowReplies: 0, textsSent: 0, autoReleased: 0, booked: 0 };
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

  // 🗑️ Spam and 🧪 Test chats never count.
  const hiddenRows = await sql`SELECT phone FROM sms_conversations WHERE folder IN ('spam', 'test')`;
  const hidden = new Set(hiddenRows.map((r) => String(r.phone)));

  for (const w of await ownedWaitingChats()) if (!hidden.has(w.conversation.phone)) bump(rows, w.conversation.assignedTo).waitingNow++;
  for (const f of await followUpList(null, now)) if (f.owner && f.reason !== "scheduled") bump(rows, f.owner).followUpsDue++;

  // Texts from 3 days before the period too, so a wait that started earlier is measured fully.
  const lookback = new Date(since.getTime() - 3 * 24 * 3600_000).toISOString();
  const msgs = await sql`SELECT phone, direction, body, sent_by, status, created_at FROM sms_messages
    WHERE created_at > ${lookback}::timestamptz ORDER BY phone, created_at, id`;
  const list: Msg[] = msgs.filter((m) => !hidden.has(String(m.phone))).map((m) => ({
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
  const eventRows = await sql`SELECT phone, action, created_at FROM sms_audit
    WHERE created_at > ${lookback}::timestamptz AND action IN ('bot_handoff', 'bot_paused', 'bot_resumed', 'handoff_handled')`;
  const events: ChargeEvent[] = eventRows
    .filter((e) => e.phone && !hidden.has(String(e.phone)))
    .map((e) => ({ phone: String(e.phone), action: String(e.action), at: new Date(e.created_at as string).getTime() }));
  const waits = new Map<string, number[]>();
  for (const e of replyEpisodes(list, sinceMs, events)) {
    const row = bump(rows, e.by);
    row.replies++;
    if (e.minutes > 60) row.slowReplies++;
    (waits.get(row.email) ?? waits.set(row.email, []).get(row.email)!).push(e.minutes);
  }
  for (const row of rows.values()) {
    const list = waits.get(row.email) || [];
    row.avgReplyMinutes = list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null;
    row.typicalReplyMinutes = median(list);
  }

  const audits = await sql`SELECT phone, action, actor, detail->>'from' AS released_from FROM sms_audit
    WHERE created_at >= ${since.toISOString()}::timestamptz AND action IN ('auto_released', 'booking_marked_booked')`;
  for (const a of audits) {
    if (a.phone && hidden.has(String(a.phone))) continue;
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

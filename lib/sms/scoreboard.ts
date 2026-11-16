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
import { isPersonSender, needsAnswer, ownedWaitingChats, teamMinutesBetween } from "@/lib/sms/ownership";
import { CHECKING_SENDER, HOLD_SENDER, callNotesSince, smsDb } from "@/lib/sms/store";
import { noteText } from "@/lib/sms/notes";

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
  /** Team notes (2026-11-16): calls logged with the 📞 buttons (talked / voicemail / no answer). */
  callsLogged: number;
  autoReleased: number;
  booked: number;
};

/** The numbers you can tap for a list (Steven, 2026-11-15). Typical/Avg reply open the Replies list. */
export const SCORE_METRICS = ["owns", "waiting", "followups", "replies", "slow", "texts", "calls", "released", "booked"] as const;
export type ScoreMetric = (typeof SCORE_METRICS)[number];

/** One line of a tapped number's list: which customer, when, and a short note. */
export type ScoreDetail = { phone: string; at: string; note: string };

export type Scoreboard = { since: string; rows: ScoreRow[]; details: ScoreDetail[] };

type Msg = { phone: string; direction: string; body: string; sentBy: string | null; status: string; at: number };
/** Audit events that change who's in charge: bot_handoff, bot_paused, bot_resumed, handoff_handled. */
export type ChargeEvent = { phone: string; action: string; at: number };

/** Reply episodes in the window: who answered and how many team minutes the customer waited. */
export type ReplyEpisode = { by: string; minutes: number; phone: string; at: number; waitStart: number };

export function replyEpisodes(messages: Msg[], since: number, events: ChargeEvent[] = []): ReplyEpisode[] {
  // One timeline per phone: texts and charge events, oldest first (an event at the same moment goes first).
  type Item = { kind: "msg"; m: Msg } | { kind: "event"; e: ChargeEvent };
  const byPhone = new Map<string, Item[]>();
  for (const m of messages) (byPhone.get(m.phone) ?? byPhone.set(m.phone, []).get(m.phone)!).push({ kind: "msg", m });
  for (const e of events) byPhone.get(e.phone)?.push({ kind: "event", e });
  const out: ReplyEpisode[] = [];
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
        if (waitStart !== null && m.at >= since) out.push({ by: m.sentBy as string, minutes: teamMinutesBetween(new Date(waitStart), new Date(m.at)), phone: m.phone, at: m.at, waitStart });
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
    row = { email: key, ownsNow: 0, waitingNow: 0, followUpsDue: 0, replies: 0, avgReplyMinutes: null, typicalReplyMinutes: null, slowReplies: 0, textsSent: 0, callsLogged: 0, autoReleased: 0, booked: 0 };
    map.set(key, row);
  }
  return row;
}

function minutesNote(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} hr ${m % 60} min` : `${h} hr`;
}

/**
 * The scoreboard since `since` (start of the period). `people` = everyone with inbox access,
 * so zero rows show too. `detail` = one person + one number: its list comes back in `details`.
 */
export async function buildScoreboard(since: Date, now: Date, people: string[], detail?: { person: string; metric: ScoreMetric }): Promise<Scoreboard> {
  const sql = await smsDb();
  const rows = new Map<string, ScoreRow>();
  for (const p of people) bump(rows, p);
  const who = detail?.person.toLowerCase() || null;
  const details: ScoreDetail[] = [];
  const add = (metric: ScoreMetric, email: string | null | undefined, item: () => ScoreDetail) => {
    if (detail && who && detail.metric === metric && (email || "").toLowerCase() === who) details.push(item());
  };
  const when = (ms: number) => new Date(ms).toISOString();

  const owned = await sql`SELECT phone, assigned_to, assigned_at FROM sms_conversations
    WHERE assigned_to IS NOT NULL AND folder IS NULL`;
  for (const r of owned) {
    bump(rows, String(r.assigned_to)).ownsNow++;
    const at = r.assigned_at ? new Date(r.assigned_at as string).getTime() : now.getTime();
    add("owns", String(r.assigned_to), () => ({ phone: String(r.phone), at: when(at), note: "Owned since" }));
  }

  // 🗑️ Spam and 🧪 Test chats never count.
  const hiddenRows = await sql`SELECT phone FROM sms_conversations WHERE folder IN ('spam', 'test')`;
  const hidden = new Set(hiddenRows.map((r) => String(r.phone)));

  for (const w of await ownedWaitingChats()) {
    if (hidden.has(w.conversation.phone)) continue;
    bump(rows, w.conversation.assignedTo).waitingNow++;
    add("waiting", w.conversation.assignedTo, () => ({ phone: w.conversation.phone, at: w.waitStart.toISOString(), note: `Waiting since; goes back to the queue ${w.deadline.getTime() <= now.getTime() ? "within 5 min" : "at " + new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit" }).format(w.deadline)}` }));
  }
  for (const f of await followUpList(null, now)) {
    if (!f.owner || f.reason === "scheduled") continue;
    bump(rows, f.owner).followUpsDue++;
    add("followups", f.owner, () => ({ phone: f.phone, at: f.since, note: f.label }));
  }

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
  const textsByPhone = new Map<string, { n: number; last: number }>();
  for (const m of list) {
    if (m.direction === "outbound" && m.at >= sinceMs && m.status !== "send_failed" && isPersonSender(m.sentBy)) {
      bump(rows, m.sentBy as string).textsSent++;
      if (who && (m.sentBy as string).toLowerCase() === who) {
        const t = textsByPhone.get(m.phone) || { n: 0, last: 0 };
        textsByPhone.set(m.phone, { n: t.n + 1, last: Math.max(t.last, m.at) });
      }
    }
  }
  for (const [phone, t] of textsByPhone) add("texts", who, () => ({ phone, at: when(t.last), note: `${t.n} text${t.n === 1 ? "" : "s"} (last one at this time)` }));
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
    add("replies", e.by, () => ({ phone: e.phone, at: when(e.at), note: `Waited ${minutesNote(e.minutes)} of team time` }));
    if (e.minutes > 60) add("slow", e.by, () => ({ phone: e.phone, at: when(e.at), note: `Waited ${minutesNote(e.minutes)} of team time` }));
  }
  for (const row of rows.values()) {
    const list = waits.get(row.email) || [];
    row.avgReplyMinutes = list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null;
    row.typicalReplyMinutes = median(list);
  }

  for (const n of await callNotesSince(since)) {
    if (hidden.has(n.phone)) continue;
    bump(rows, n.createdBy).callsLogged++;
    add("calls", n.createdBy, () => ({ phone: n.phone, at: n.createdAt, note: noteText(n) }));
  }

  // Booked = "Booked in ServiceTitan" on a Ready-to-book card OR "Move to → 📅 Booked" by a person
  // (Steven, 2026-11-15: Chris booked a "wants a call" customer and filed it, which has no card).
  // One per customer per person, so clicking the button (which also files it) counts once.
  const audits = await sql`SELECT phone, action, actor, reason, created_at, detail->>'from' AS released_from FROM sms_audit
    WHERE created_at >= ${since.toISOString()}::timestamptz
      AND (action IN ('auto_released', 'booking_marked_booked') OR (action = 'folder_moved' AND reason = 'booked'))
    ORDER BY created_at`;
  const bookedSeen = new Set<string>();
  for (const a of audits) {
    if (a.phone && hidden.has(String(a.phone))) continue;
    const at = new Date(a.created_at as string).getTime();
    if (a.action === "auto_released" && a.released_from) {
      bump(rows, String(a.released_from)).autoReleased++;
      add("released", String(a.released_from), () => ({ phone: String(a.phone), at: when(at), note: "Released: no reply within 1 hour of team time" }));
      continue;
    }
    const actor = a.actor ? String(a.actor) : "";
    if (!actor || !isPersonSender(actor) || actor === "staff" || actor === "customer") continue;
    const key = `${actor.toLowerCase()}|${a.phone}`;
    if (bookedSeen.has(key)) continue;
    bookedSeen.add(key);
    bump(rows, actor).booked++;
    const note = a.action === "booking_marked_booked" ? "Booked in ServiceTitan (Ready-to-book card)" : "Moved to 📅 Booked";
    add("booked", actor, () => ({ phone: String(a.phone), at: when(at), note }));
  }

  // Busiest first: waiting now, then follow-ups due, then replies.
  const sorted = [...rows.values()].sort((a, b) => b.waitingNow - a.waitingNow || b.followUpsDue - a.followUpsDue || b.replies - a.replies || a.email.localeCompare(b.email));
  // Lists: newest first, except Waiting and Follow-ups (oldest first: who waited longest).
  const oldestFirst = detail?.metric === "waiting" || detail?.metric === "followups";
  details.sort((a, b) => (oldestFirst ? 1 : -1) * (Date.parse(a.at) - Date.parse(b.at)));
  return { since: since.toISOString(), rows: sorted, details };
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

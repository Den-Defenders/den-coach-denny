/**
 * lib/sms/followup.ts
 *
 * AI follow-ups (build step 5, PR 3). Melanie / Mike (2026-10-25): once a lead
 * has replied, everything is AI; if the AI is left on read it writes unique
 * follow-ups on the docs' cadence until they say not interested or STOP.
 * Steven (2026-11-02): the sheet drip runs first; leads who never replied get an
 * AI follow-up every 60 days after the sheet's Day 60 text.
 *
 * Who gets them (all must be true):
 *   - a form lead (lead_at set) with form consent (the send helper checks)
 *   - the drip is done, or it stopped because they replied
 *   - the AI is on, no open "Needs CSR" flag, no open booking, not "not interested",
 *     not opted out, nobody clicked "Stop auto texts"
 *   - our text is the last one (they left us on read)
 * Cadence (days after our last text): 2, 3, 5, 14, 21, 4, 6, 14, 30, 45, 60, then every 60.
 * Every text: ServiceTitan check, 9 AM - 5 PM their time, no holidays, caps,
 * through the ONE send helper (kind "automated", sent_by "denny-followup").
 * On/off: SMS_DRIP_ENABLED (same switch as the drip).
 */
import { composeFollowUp } from "@/lib/sms/bot";
import { bookingBlocksDrip, dripEnabled, intoWindow } from "@/lib/sms/drip";
import { safeTimeZone } from "@/lib/sms/rules";
import { sendSms, smsNow } from "@/lib/sms/send";
import { stCheckFor, stCheckSummary } from "@/lib/sms/stCheck";
import { CHECKING_SENDER, HOLD_SENDER, audit, conversationState, setHandoff, smsDb, threadForBot } from "@/lib/sms/store";

export const FOLLOWUP_SENDER = "denny-followup";
/** Days after our last text (Melanie's Master Bot Logic). After the list: every 60 days. */
export const FOLLOWUP_DAYS = [2, 3, 5, 14, 21, 4, 6, 14, 30, 45, 60];
export const NEVER_REPLIED_DAYS = 60;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export type FollowUpPlan =
  | { due: Date; number: number; neverReplied: boolean; lastOutAt: Date }
  | { none: string };

type Row = Record<string, unknown>;
const d = (v: unknown) => (v == null ? null : new Date(v as string));

/** Why a conversation gets no follow-ups right now, or when the next one is due. */
async function planFor(row: Row): Promise<FollowUpPlan> {
  if (row.followups_off === true) return { none: "Auto texts stopped for this customer" };
  if (!row.lead_at) return { none: "Not a form lead" };
  if (row.opted_out === true) return { none: "Opted out" };
  if (row.bot_status === "paused") return { none: "A person is answering" };
  if (row.lead_status === "not_interested") return { none: "Not interested" };
  if (row.handoff_reason && !row.handoff_resolved_at) return { none: "Waiting on the team (Needs CSR)" };
  const leadAt = d(row.lead_at) as Date;
  if (bookingBlocksDrip(row.booking_request, row.booking_done_at, leadAt)) return { none: "Booking in progress" };
  const lastIn = d(row.last_in);
  const lastOut = d(row.last_out);
  const neverReplied = !lastIn || lastIn < leadAt;
  const dripDone = row.drip_status === "done";
  const replied = row.drip_status === "stopped" && String(row.drip_stop_reason || "").startsWith("they replied");
  if (!dripDone && !replied) return { none: row.drip_status === "active" ? "Drip still running" : "No drip" };
  if (!lastOut) return { none: "Nothing sent yet" };
  if (!neverReplied && lastIn && lastIn >= lastOut) return { none: "Their text is waiting for an answer" };
  const since = neverReplied ? leadAt : (lastIn as Date);
  const sql = await smsDb();
  const sent = await sql`SELECT count(*)::int AS n FROM sms_messages WHERE conversation_id = ${row.id} AND direction = 'outbound'
    AND sent_by = ${FOLLOWUP_SENDER} AND status <> 'send_failed' AND created_at > ${since.toISOString()}::timestamptz`;
  const count = Number(sent[0]?.n || 0);
  const days = neverReplied ? NEVER_REPLIED_DAYS : FOLLOWUP_DAYS[Math.min(count, FOLLOWUP_DAYS.length - 1)];
  const timeZone = safeTimeZone(String(row.time_zone || ""));
  return { due: intoWindow(new Date(lastOut.getTime() + days * DAY), "automated", timeZone), number: count + 1, neverReplied, lastOutAt: lastOut };
}

async function loadRows(where: { phone?: string; now?: Date; limit?: number }): Promise<Row[]> {
  const sql = await smsDb();
  if (where.phone) {
    return sql`SELECT v.id, v.phone, v.lead_at, v.drip_status, v.drip_stop_reason, v.booking_request, v.booking_done_at,
        v.handoff_reason, v.handoff_resolved_at, v.lead_status, v.bot_status, v.followups_off, v.followup_lock_until, c.time_zone,
        EXISTS (SELECT 1 FROM sms_opt_outs o WHERE o.phone = v.phone) AS opted_out,
        (SELECT max(m.created_at) FROM sms_messages m WHERE m.conversation_id = v.id AND m.direction = 'inbound') AS last_in,
        (SELECT max(m.created_at) FROM sms_messages m WHERE m.conversation_id = v.id AND m.direction = 'outbound'
          AND m.status <> 'send_failed' AND coalesce(m.sent_by, '') NOT IN (${HOLD_SENDER}, ${CHECKING_SENDER})) AS last_out
      FROM sms_conversations v JOIN sms_contacts c ON c.phone = v.phone WHERE v.phone = ${where.phone}`;
  }
  return sql`SELECT v.id, v.phone, v.lead_at, v.drip_status, v.drip_stop_reason, v.booking_request, v.booking_done_at,
      v.handoff_reason, v.handoff_resolved_at, v.lead_status, v.bot_status, v.followups_off, v.followup_lock_until, c.time_zone,
      EXISTS (SELECT 1 FROM sms_opt_outs o WHERE o.phone = v.phone) AS opted_out,
      (SELECT max(m.created_at) FROM sms_messages m WHERE m.conversation_id = v.id AND m.direction = 'inbound') AS last_in,
      (SELECT max(m.created_at) FROM sms_messages m WHERE m.conversation_id = v.id AND m.direction = 'outbound'
        AND m.status <> 'send_failed' AND coalesce(m.sent_by, '') NOT IN (${HOLD_SENDER}, ${CHECKING_SENDER})) AS last_out
    FROM sms_conversations v JOIN sms_contacts c ON c.phone = v.phone
    WHERE v.lead_at IS NOT NULL AND v.followups_off = false AND v.bot_status = 'on'
      AND coalesce(v.lead_status, '') <> 'not_interested'
      AND (v.drip_status = 'done' OR (v.drip_status = 'stopped' AND v.drip_stop_reason LIKE 'they replied%'))
      AND (v.followup_lock_until IS NULL OR v.followup_lock_until <= ${(where.now || smsNow()).toISOString()}::timestamptz)
    ORDER BY v.updated_at LIMIT ${Math.min(where.limit ?? 200, 500)}`;
}

/** For the inbox: the next follow-up for one phone, or why there isn't one. */
export async function followUpPlanFor(phone: string): Promise<FollowUpPlan> {
  const rows = await loadRows({ phone });
  return rows[0] ? planFor(rows[0]) : { none: "No conversation" };
}

async function lock(id: unknown, until: Date | null) {
  const sql = await smsDb();
  await sql`UPDATE sms_conversations SET followup_lock_until = ${until ? until.toISOString() : null}::timestamptz WHERE id = ${id}`;
}

/** "Stop auto texts": no drip, no follow-ups for this customer, for good. */
export async function stopFollowUps(phone: string, by: string): Promise<boolean> {
  const sql = await smsDb();
  const rows = await sql`UPDATE sms_conversations SET followups_off = true, updated_at = now() WHERE phone = ${phone} AND followups_off = false RETURNING id`;
  if (rows.length) await audit({ phone, action: "followups_stopped", reason: `by ${by}`, actor: by });
  return rows.length > 0;
}

export type FollowUpOutcome = "sent" | "not_due" | "none" | "busy" | "retry_later" | "excluded" | "no_text" | "blocked";

const RETRY_LATER = new Set([
  "outside_hours", "holiday", "contact_hourly_cap", "contact_daily_cap", "automated_daily_cap", "system_daily_cap",
  "sending_disabled", "twilio_not_configured", "database_not_configured",
]);

export async function processFollowUp(row: Row, now: Date): Promise<FollowUpOutcome> {
  const phone = String(row.phone);
  const plan = await planFor(row);
  if ("none" in plan) return "none";
  if (plan.due > now) return "not_due";

  // Lease: only one run works on this customer.
  const sql = await smsDb();
  const leased = await sql`UPDATE sms_conversations SET followup_lock_until = ${new Date(now.getTime() + 10 * 60 * 1000).toISOString()}::timestamptz
    WHERE id = ${row.id} AND (followup_lock_until IS NULL OR followup_lock_until <= ${now.toISOString()}::timestamptz) RETURNING id`;
  if (!leased.length) return "busy";

  const { check, bypass } = await stCheckFor(phone, now);
  if (!bypass) {
    if (!check.ok) {
      await audit({ phone, action: "followup_st_check_failed", reason: check.error || "error", actor: FOLLOWUP_SENDER });
      await lock(row.id, new Date(now.getTime() + HOUR));
      return "retry_later";
    }
    if (check.blocked) {
      await sql`UPDATE sms_conversations SET followups_off = true, updated_at = now() WHERE id = ${row.id}`;
      await setHandoff(phone, "st_excluded", `${stCheckSummary(check)}. No automated texts. A person decides whether to reach out.`, now, { keepAi: true });
      await audit({ phone, action: "followups_stopped", reason: "servicetitan", actor: FOLLOWUP_SENDER });
      return "excluded";
    }
  }

  const state = await conversationState(phone);
  const thread = await threadForBot(phone, 40);
  const daysSinceLast = Math.max(1, Math.round((now.getTime() - plan.lastOutAt.getTime()) / DAY));
  let written: { text: string; model: string } | null = null;
  for (let attempt = 0; attempt < 2 && !written; attempt++) {
    written = await composeFollowUp({ thread, notes: state.customerNotes, now, number: plan.number, daysSinceLast, neverReplied: plan.neverReplied });
  }
  if (!written) {
    await audit({ phone, action: "followup_skipped", reason: "no safe text from the AI", detail: { number: plan.number }, actor: FOLLOWUP_SENDER });
    await lock(row.id, new Date(now.getTime() + DAY));
    return "no_text";
  }

  // Last look: they may have texted, or a person taken over, while the AI was writing.
  const fresh = (await loadRows({ phone }))[0];
  const again = fresh ? await planFor(fresh) : { none: "gone" };
  if ("none" in again) {
    await lock(row.id, null);
    return "none";
  }

  const result = await sendSms({ to: phone, body: written.text, kind: "automated", purpose: "care", sentBy: FOLLOWUP_SENDER });
  if (result.ok) {
    await audit({ phone, action: "followup_sent", reason: `follow-up ${plan.number}`, detail: { messageId: result.messageId, model: written.model, neverReplied: plan.neverReplied }, actor: FOLLOWUP_SENDER });
    await lock(row.id, null);
    return "sent";
  }
  if (RETRY_LATER.has(result.reason)) {
    const later = result.reason === "outside_hours" || result.reason === "holiday"
      ? intoWindow(new Date(now.getTime() + 60_000), "automated", safeTimeZone(String(row.time_zone || "")))
      : new Date(now.getTime() + HOUR);
    await lock(row.id, later);
    return "retry_later";
  }
  // opted out, no consent, not on the pilot list…: no more follow-ups for this customer.
  await sql`UPDATE sms_conversations SET followups_off = true, updated_at = now() WHERE id = ${row.id}`;
  await audit({ phone, action: "followups_stopped", reason: `send blocked: ${result.reason}`, actor: FOLLOWUP_SENDER });
  return "blocked";
}

/** The timer: every customer whose next AI follow-up is due. */
export async function runDueFollowUps(options: { now?: Date; budgetMs?: number } = {}) {
  const started = Date.now();
  const summary: Record<string, number> = {};
  if (!dripEnabled()) return { ran: 0, summary: { off: 1 } };
  const rows = await loadRows({ now: options.now || smsNow() });
  let ran = 0;
  for (const row of rows) {
    if (Date.now() - started > (options.budgetMs ?? 30_000)) break;
    try {
      const outcome = await processFollowUp(row, options.now || smsNow());
      summary[outcome] = (summary[outcome] || 0) + 1;
      if (outcome !== "none" && outcome !== "not_due") ran++;
    } catch (error) {
      summary.error = (summary.error || 0) + 1;
      console.error("Follow-up failed:", error instanceof Error ? error.message : error);
    }
  }
  return { ran, checked: rows.length, summary };
}

/** Plain words for the inbox lead card. */
export function followUpLabel(plan: FollowUpPlan, timeZone: string): string {
  if ("none" in plan) return "";
  const when = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(plan.due);
  return `AI follow-up ${plan.number} due ${when} their time${plan.neverReplied ? " (they never replied: every 60 days)" : ""}`;
}

/**
 * lib/sms/inbox.ts
 *
 * Rules for the Texting inbox (step 3): which conversations "Need CSR", why,
 * and what would stop a person's reply from going out right now.
 *
 * Needs CSR (top of the inbox):
 *   0. (pinned above everything) "📅 Ready to book": the customer picked a real open
 *      time by text (step 4a) and nobody has clicked "Booked in ServiceTitan" yet,
 *   1. the AI handed the conversation off (bailout, phone request, complaint,
 *      ready to book...) and nobody has marked it handled yet, or
 *   2. the customer texted a number the AI is paused for (a person took over), or
 *   3. the customer's newest text got no answer for 5+ minutes (after hours,
 *      AI off, a limit, or not on the pilot test list).
 * Keyword-only texts (STOP, START, HELP) never count: Twilio answers those.
 * Opted-out numbers never count: we can't text them anyway.
 */
import { TEAM_HOURS_TEXT, classifyKeyword, describeHours, localTime, teamIsTexting, withinSendingHours } from "@/lib/sms/rules";
import { allowList, sendSms, sendingEnabled } from "@/lib/sms/send";
import { HOLD_SENDER, audit, lastOutbound, type InboxRow, type InboxThread } from "@/lib/sms/store";

export const NO_REPLY_MINUTES = 5;

const HANDOFF_LABELS: Record<string, string> = {
  wants_call: "Wants a call",
  ready_to_book: "Wants to book (no time picked)",
  complaint: "Complaint",
  existing_customer: "Existing customer",
  appointment_change: "Appointment change",
  price_objection: "Price concern",
  unsupported_work: "Work we may not do",
  service_area_check: "Check service area",
  abusive_or_spam: "Abusive or spam",
  question_for_team: "Question for the team",
  csr_took_over: "A person took over",
};

export function handoffLabel(reason: string | null): string {
  if (!reason) return "Needs a person";
  return HANDOFF_LABELS[reason] || reason.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export const READY_TO_BOOK_LABEL = "📅 Ready to book";

export type InboxFlag = {
  needsCsr: boolean;
  /** "📅 Ready to book": pinned to the very top of Needs CSR. */
  pinned: boolean;
  /** Short reason shown in red on the list and the thread. */
  reason: string | null;
  /** The customer's newest text has no answer and nobody marked it handled. */
  waiting: boolean;
};

type FlagInput = Pick<InboxRow,
  "botStatus" | "handoffReason" | "handoffResolvedAt" | "optedOut" | "lastDirection" | "lastBody" | "lastAt">
  & { bookingRequest?: unknown; bookingDoneAt?: string | null };

/** The customer picked a time and nobody has booked it in ServiceTitan yet. */
export function bookingPending(row: { bookingRequest?: unknown; bookingDoneAt?: string | null }): boolean {
  return Boolean(row.bookingRequest) && !row.bookingDoneAt;
}

export function inboxFlag(row: FlagInput, now: Date): InboxFlag {
  if (row.optedOut) return { needsCsr: false, pinned: false, reason: null, waiting: false };
  const resolvedAt = row.handoffResolvedAt ? Date.parse(row.handoffResolvedAt) : 0;
  const lastAt = row.lastAt ? Date.parse(row.lastAt) : 0;
  const keywordOnly = row.lastDirection === "inbound" && classifyKeyword(row.lastBody, { optedOut: false }).keyword !== null;
  const waiting = row.lastDirection === "inbound" && !keywordOnly && (!resolvedAt || lastAt > resolvedAt);

  // Open handoff. Usually the AI is paused; a "wants to book, no time picked" flag keeps it on.
  if (row.handoffReason && !resolvedAt) {
    const pinned = row.handoffReason === "ready_to_book" && bookingPending(row);
    return { needsCsr: true, pinned, reason: pinned ? READY_TO_BOOK_LABEL : handoffLabel(row.handoffReason), waiting };
  }
  if (waiting && row.botStatus === "paused") {
    return { needsCsr: true, pinned: false, reason: "Customer is waiting (AI paused)", waiting };
  }
  if (waiting && now.getTime() - lastAt >= NO_REPLY_MINUTES * 60_000) {
    return { needsCsr: true, pinned: false, reason: "No reply yet", waiting };
  }
  return { needsCsr: false, pinned: false, reason: null, waiting };
}

/** "📅 Ready to book" first, then the rest of Needs CSR (oldest wait first, so nobody sits longest), then newest activity. */
export function sortInbox<T extends { flag: InboxFlag; lastAt: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.flag.pinned !== b.flag.pinned) return a.flag.pinned ? -1 : 1;
    if (a.flag.needsCsr !== b.flag.needsCsr) return a.flag.needsCsr ? -1 : 1;
    const ta = Date.parse(a.lastAt) || 0;
    const tb = Date.parse(b.lastAt) || 0;
    return a.flag.needsCsr ? ta - tb : tb - ta;
  });
}

/** Things that will block a person's text to this number right now (shown above the reply box). */
export function replyBlockers(thread: Pick<InboxThread, "phone" | "timeZone" | "optOut" | "consent">, now: Date): {
  blockers: string[];
  canSend: boolean;
  localTimeLabel: string;
} {
  const blockers: string[] = [];
  let canSend = true;
  if (thread.optOut) {
    blockers.push("This customer opted out (STOP). Texts are blocked until they text START.");
    canSend = false;
  }
  if (!sendingEnabled()) blockers.push("Texting is switched off (SMS_SENDING_ENABLED).");
  const allowed = allowList();
  if (!allowed.everyone && !allowed.numbers.includes(thread.phone)) {
    blockers.push("Pilot mode: this number isn't on the test list (SMS_ALLOWED_TO), so texts to it are blocked.");
  }
  if (!thread.optOut && !thread.consent.length) blockers.push("No texting consent on file for this number.");
  const local = localTime(now, thread.timeZone);
  const localTimeLabel = new Intl.DateTimeFormat("en-US", { timeZone: thread.timeZone, hour: "numeric", minute: "2-digit" }).format(now);
  if (!withinSendingHours("manual", local)) {
    blockers.push(`Outside texting hours (${describeHours("manual")} their time; it's ${localTimeLabel} there).`);
  }
  return { blockers, canSend, localTimeLabel };
}

// ---------------------------------------------------------------------------
// Hold text: "a team member will get back to you" (Steven, 2026-11-01)
// ---------------------------------------------------------------------------

/** No hold text if anyone (a person or the AI) texted this customer in the last 30 minutes. */
export const HOLD_QUIET_MINUTES = 30;

export const HOLD_TEXT_TEAM_WORKING =
  "Thanks for your text! A member of our team will reply as soon as they can, so it may take a little longer than usual.";
export const HOLD_TEXT_AFTER_HOURS =
  `Thanks for your text! Our team texts between ${TEAM_HOURS_TEXT.replace(" to ", " and ")}, so a team member will get back to you after 8 AM.`;

export function holdText(now: Date, timeZone: string): string {
  return teamIsTexting(now, timeZone) ? HOLD_TEXT_TEAM_WORKING : HOLD_TEXT_AFTER_HOURS;
}

/**
 * The customer texted a number the AI is paused for (a person has it). Send ONE
 * hold text per wait so they know a person will answer, unless someone texted
 * them in the last 30 minutes (a live back-and-forth is never interrupted).
 * Goes through the one send helper like every other text (opt-outs, pilot list, caps).
 */
export async function maybeSendHoldText(phone: string, timeZone: string, now: Date): Promise<string> {
  const last = await lastOutbound(phone);
  if (last?.sentBy === HOLD_SENDER) return "already_sent";
  if (last && now.getTime() - Date.parse(last.createdAt) < HOLD_QUIET_MINUTES * 60_000) return "texted_recently";
  const afterHours = !teamIsTexting(now, timeZone);
  const result = await sendSms({ to: phone, body: holdText(now, timeZone), kind: "reply", purpose: "care", sentBy: HOLD_SENDER });
  if (!result.ok) return `blocked:${result.reason}`;
  await audit({ phone, action: "hold_text", reason: afterHours ? "after_hours" : "team_hours", detail: { messageId: result.messageId }, actor: "system" });
  return "sent";
}

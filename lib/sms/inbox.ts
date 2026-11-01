/**
 * lib/sms/inbox.ts
 *
 * Rules for the Texting inbox (step 3): which conversations "Need CSR", why,
 * and what would stop a person's reply from going out right now.
 *
 * Needs CSR (top of the inbox):
 *   1. the AI handed the conversation off (bailout, phone request, complaint,
 *      ready to book...) and nobody has marked it handled yet, or
 *   2. the customer texted a number the AI is paused for (a person took over), or
 *   3. the customer's newest text got no answer for 5+ minutes (after hours,
 *      AI off, a limit, or not on the pilot test list).
 * Keyword-only texts (STOP, START, HELP) never count: Twilio answers those.
 * Opted-out numbers never count: we can't text them anyway.
 */
import { classifyKeyword, describeHours, localTime, withinSendingHours } from "@/lib/sms/rules";
import { allowList, sendingEnabled } from "@/lib/sms/send";
import type { InboxRow, InboxThread } from "@/lib/sms/store";

export const NO_REPLY_MINUTES = 5;

const HANDOFF_LABELS: Record<string, string> = {
  wants_call: "Wants a call",
  ready_to_book: "Ready to book",
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

export type InboxFlag = {
  needsCsr: boolean;
  /** Short reason shown in red on the list and the thread. */
  reason: string | null;
  /** The customer's newest text has no answer and nobody marked it handled. */
  waiting: boolean;
};

type FlagInput = Pick<InboxRow,
  "botStatus" | "handoffReason" | "handoffResolvedAt" | "optedOut" | "lastDirection" | "lastBody" | "lastAt">;

export function inboxFlag(row: FlagInput, now: Date): InboxFlag {
  if (row.optedOut) return { needsCsr: false, reason: null, waiting: false };
  const resolvedAt = row.handoffResolvedAt ? Date.parse(row.handoffResolvedAt) : 0;
  const lastAt = row.lastAt ? Date.parse(row.lastAt) : 0;
  const keywordOnly = row.lastDirection === "inbound" && classifyKeyword(row.lastBody, { optedOut: false }).keyword !== null;
  const waiting = row.lastDirection === "inbound" && !keywordOnly && (!resolvedAt || lastAt > resolvedAt);

  if (row.botStatus === "paused" && row.handoffReason && !resolvedAt) {
    return { needsCsr: true, reason: handoffLabel(row.handoffReason), waiting };
  }
  if (waiting && row.botStatus === "paused") {
    return { needsCsr: true, reason: "Customer is waiting (AI paused)", waiting };
  }
  if (waiting && now.getTime() - lastAt >= NO_REPLY_MINUTES * 60_000) {
    return { needsCsr: true, reason: "No reply yet", waiting };
  }
  return { needsCsr: false, reason: null, waiting };
}

/** Needs CSR first (oldest wait first, so nobody sits longest), then newest activity. */
export function sortInbox<T extends { flag: InboxFlag; lastAt: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
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

/**
 * lib/sms/numbers.ts
 *
 * Session 8 (Nor-Cal numbers): which of our Twilio numbers a customer's texts come from.
 *
 * Rule: a customer always gets texts from the SAME number (sticky).
 *   - The conversation remembers its number (sms_conversations.our_number).
 *   - When the customer texts one of our numbers, the conversation follows the
 *     number they texted, so our reply comes from where they wrote.
 *   - A conversation with no number yet uses the default number below and keeps it.
 *
 * Every send passes that number to Twilio as From (together with the Messaging
 * Service), so Twilio's own "sticky sender / area code" picking is never used.
 * That matters once the market numbers join the "Den Defenders" Messaging Service:
 * without From, Twilio could move an existing 916 customer to another number.
 *
 * Session 8 PR 2 adds the market numbers (ad set / ZIP / area code -> number) for new leads.
 */
import { normalizePhone } from "@/lib/sms/rules";

/** The Sacramento pilot number, live since 2026-10-25. */
export const PILOT_NUMBER = "+19168911680";

/** Number for a conversation that has none yet. SMS_DEFAULT_FROM can override it (rarely needed). */
export function defaultSendingNumber(): string {
  return normalizePhone(process.env.SMS_DEFAULT_FROM || "") || PILOT_NUMBER;
}

/** The number this conversation's texts go out from. */
export function sendingNumberFor(conversationNumber: string | null | undefined): string {
  return normalizePhone(conversationNumber || "") || defaultSendingNumber();
}

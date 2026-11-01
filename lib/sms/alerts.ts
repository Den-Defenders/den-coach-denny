/**
 * lib/sms/alerts.ts
 *
 * Optional Slack alerts for the Texting inbox (SMS_SLACK_WEBHOOK_URL).
 * Every alert carries a link that opens the conversation in Den Coach Denny.
 * Alerts never block a webhook or a reply: failures are only logged.
 */
import { bookingLines, type BookingRequest } from "@/lib/sms/booking";
import { formatPhone } from "@/lib/sms/rules";
import { allowList } from "@/lib/sms/send";
import { conversationAssignee } from "@/lib/sms/store";
import { findTeamMember, teamDatabaseConfigured } from "@/lib/teamStore";

/** Where people log in to Denny (Auth0 only works on this address, not the vercel.app one). */
export function dennyAppUrl(): string {
  const raw = (process.env.DENNY_APP_URL || "https://dencoachdenny.com").trim().replace(/\/+$/, "");
  return /^https:\/\/[^/\s]+$/i.test(raw) ? raw : "https://dencoachdenny.com";
}

/** Link straight to one conversation in the Texting inbox. */
export function inboxLink(phone?: string): string {
  const base = `${dennyAppUrl()}/texting`;
  return phone ? `${base}?phone=${encodeURIComponent(phone)}` : base;
}

export function slackAlertsEnabled(): boolean {
  return Boolean((process.env.SMS_SLACK_WEBHOOK_URL || "").trim());
}

/** "[PILOT] " while the allow-list is on, so test alerts aren't mistaken for real leads. */
export function pilotTag(): string {
  return allowList().everyone ? "" : "[PILOT] ";
}

/**
 * "<@U01ABC23DEF> " when a team member owns this customer and has a Slack member ID
 * on the Team page, so the alert pings them in the channel. "" otherwise (whole channel).
 */
export async function ownerMention(phone: string): Promise<string> {
  try {
    const owner = await conversationAssignee(phone);
    if (!owner || !teamDatabaseConfigured()) return "";
    const member = await findTeamMember(owner);
    return member?.active && member.slackMemberId ? `<@${member.slackMemberId}> ` : "";
  } catch (error) {
    console.error("SMS owner mention lookup failed:", error instanceof Error ? error.message : error);
    return "";
  }
}

export async function postSmsSlack(text: string): Promise<void> {
  const url = (process.env.SMS_SLACK_WEBHOOK_URL || "").trim();
  if (!url) return;
  try {
    // 5-second cap: the inbound webhook waits for this and Twilio gives up after 15 seconds.
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) console.error("SMS Slack alert failed: HTTP", response.status);
  } catch (error) {
    console.error("SMS Slack alert failed:", error instanceof Error ? error.message : error);
  }
}

/**
 * The customer texted a number the AI isn't answering (a person took over).
 * Sent once per unanswered stretch: only for the first text after our last one.
 */
export async function postCustomerWaitingAlert(phone: string, body: string, photos: number): Promise<void> {
  const preview = body.replace(/\s+/g, " ").trim().slice(0, 200);
  const mention = await ownerMention(phone);
  const text = [
    `${pilotTag()}${mention}:speech_balloon: *Texting: customer is waiting for a person* - ${formatPhone(phone)}`,
    preview ? `"${preview}"${photos ? ` (+${photos} photo${photos === 1 ? "" : "s"})` : ""}` : photos ? `(${photos} photo${photos === 1 ? "" : "s"})` : "",
    "The AI is paused for this number, so nobody answers until someone replies.",
    `<${inboxLink(phone)}|Open in the Texting inbox>`,
  ].filter(Boolean).join("\n");
  return postSmsSlack(text);
}

/**
 * Step 4a: the customer picked a real open time by text. Goes right away (the time can
 * fill up if it sits) with everything a CSR needs to book it in ServiceTitan without
 * re-asking. Tags the owner if someone owns this customer, otherwise @here
 * (Steven, 2026-11-01: @here only on Ready to book; other unowned alerts stay untagged).
 */
export async function postReadyToBookAlert(phone: string, booking: BookingRequest, notes: Record<string, string> = {}): Promise<void> {
  if (!slackAlertsEnabled()) return;
  const mention = (await ownerMention(phone)) || "<!here> ";
  const lines = bookingLines(booking, formatPhone(phone), notes).map((line) => {
    const at = line.indexOf(": ");
    return at > 0 && at < 20 ? `*${line.slice(0, at)}:* ${line.slice(at + 2)}` : line;
  });
  const text = [
    `${pilotTag()}${mention}:calendar: *Texting: Ready to book* - ${formatPhone(phone)}`,
    ...lines,
    "Book it in ServiceTitan, then click *Booked in ServiceTitan* in the inbox.",
    `<${inboxLink(phone)}|Open in the Texting inbox>`,
  ].join("\n");
  return postSmsSlack(text);
}

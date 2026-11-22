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
import { conversationAssignee, ensureContact } from "@/lib/sms/store";
import { numberName } from "@/lib/sms/markets";
import { defaultSendingNumber } from "@/lib/sms/numbers";
import { latestNoteLine } from "@/lib/sms/notes";
import { findTeamMember, teamDatabaseConfigured } from "@/lib/teamStore";

/** "Liz C" for a team login (falls back to the part before @). */
async function teamName(email: string): Promise<string> {
  try {
    if (teamDatabaseConfigured()) {
      const member = await findTeamMember(email);
      if (member?.displayName) return member.displayName;
    }
  } catch {
    // name lookup is best effort
  }
  return email.split("@")[0];
}

/** Team notes (Steven, 2026-11-16): every alert shows the chat's latest team note, if any. */
export function noteLineFor(phone: string): Promise<string> {
  return latestNoteLine(phone, teamName);
}

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
 * Session 8: "[Chico] " = the market (our number) this customer texts with, so every alert names it.
 * Uses the default number's name for chats without a number yet. Best effort: "" on any problem.
 */
export async function marketTag(phone: string): Promise<string> {
  try {
    const contact = await ensureContact(phone);
    const name = await numberName(contact.ourNumber || defaultSendingNumber());
    return name ? `[${name}] ` : "";
  } catch (error) {
    console.error("SMS market tag failed:", error instanceof Error ? error.message : error);
    return "";
  }
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
 * Sent once per unanswered stretch (app/api/sms/inbound decides).
 * `noReplyNeeded` (2026-11-16): "Thank you" / "ok" / 👍. Same ping and team note, but it says
 * what they said instead of "customer is waiting", and it doesn't start the 1-hour release.
 */
export async function postCustomerWaitingAlert(phone: string, body: string, photos: number, opts: { noReplyNeeded?: boolean } = {}): Promise<void> {
  const preview = body.replace(/\s+/g, " ").trim().slice(0, 200);
  const mention = await ownerMention(phone);
  const text = opts.noReplyNeeded
    ? [
        `${pilotTag()}${await marketTag(phone)}${mention}:speech_balloon: *Texting: customer said "${preview}"* - ${formatPhone(phone)}`,
        "No reply needed, so this doesn't start the 1-hour release. Reply if you want to.",
        await noteLineFor(phone),
        `<${inboxLink(phone)}|Open in the Texting inbox>`,
      ]
    : [
        `${pilotTag()}${await marketTag(phone)}${mention}:speech_balloon: *Texting: customer is waiting for a person* - ${formatPhone(phone)}`,
        preview ? `"${preview}"${photos ? ` (+${photos} photo${photos === 1 ? "" : "s"})` : ""}` : photos ? `(${photos} photo${photos === 1 ? "" : "s"})` : "",
        "The AI is paused for this number, so nobody answers until someone replies.",
        await noteLineFor(phone),
        `<${inboxLink(phone)}|Open in the Texting inbox>`,
      ];
  return postSmsSlack(text.filter(Boolean).join("\n"));
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
    `${pilotTag()}${await marketTag(phone)}${mention}:calendar: *Texting: Ready to book* - ${formatPhone(phone)}`,
    ...lines,
    "Book it in ServiceTitan, then click *Booked in ServiceTitan* in the inbox.",
    await noteLineFor(phone),
    `<${inboxLink(phone)}|Open in the Texting inbox>`,
  ].filter(Boolean).join("\n");
  return postSmsSlack(text);
}

/**
 * Session 7 (Steven, 2026-11-15): a customer in 📅 Booked texted while the AI is on.
 * The AI answers, the owner is tagged so they know, and the chat stays in Booked
 * (never auto-released). With the AI paused, the usual "customer is waiting" alert goes instead.
 */
export async function postBookedCustomerTextedAlert(phone: string, body: string, photos: number): Promise<void> {
  const preview = body.replace(/\s+/g, " ").trim().slice(0, 200);
  const mention = await ownerMention(phone);
  const text = [
    `${pilotTag()}${await marketTag(phone)}${mention}:calendar: *Texting: a booked customer texted* - ${formatPhone(phone)}`,
    preview ? `"${preview}"${photos ? ` (+${photos} photo${photos === 1 ? "" : "s"})` : ""}` : photos ? `(${photos} photo${photos === 1 ? "" : "s"})` : "",
    "The AI is answering. The chat stays in Booked, so take a look if they need a person.",
    await noteLineFor(phone),
    `<${inboxLink(phone)}|Open in the Texting inbox>`,
  ].filter(Boolean).join("\n");
  return postSmsSlack(text);
}

/**
 * Session 7: the owner didn't reply within 1 team hour, so the chat went back to the
 * shared queue. @here so whoever is free picks it up (Steven, 2026-11-11: @here + name the owner).
 */
export async function postAutoReleaseAlert(phone: string, ownerName: string, customerName: string | null, waitingSince: Date): Promise<void> {
  if (!slackAlertsEnabled()) return;
  const who = customerName ? `${customerName} (${formatPhone(phone)})` : formatPhone(phone);
  const since = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit" }).format(waitingSince);
  const text = [
    `${pilotTag()}${await marketTag(phone)}<!here> :alarm_clock: *Released:* ${ownerName} didn't reply within 1 hour. ${who} is still waiting (since ${since}). Open for anyone.`,
    await noteLineFor(phone),
    `<${inboxLink(phone)}|Open in the Texting inbox>`,
  ].filter(Boolean).join("\n");
  return postSmsSlack(text);
}

/** "<@U…> " for this team member's Slack member ID (Team page), or "". */
async function mentionFor(email: string): Promise<string> {
  try {
    if (!teamDatabaseConfigured()) return "";
    const member = await findTeamMember(email);
    return member?.active && member.slackMemberId ? `<@${member.slackMemberId}> ` : "";
  } catch (error) {
    console.error("SMS mention lookup failed:", error instanceof Error ? error.message : error);
    return "";
  }
}

/**
 * 2026-11-22: a teammate took a customer the old owner had. Tags the old owner so it's no surprise.
 */
export async function postTakenOverAlert(phone: string, oldOwner: string, takerName: string, customerName: string | null): Promise<void> {
  if (!slackAlertsEnabled()) return;
  const who = customerName ? `${customerName} (${formatPhone(phone)})` : formatPhone(phone);
  const text = [
    `${pilotTag()}${await marketTag(phone)}${await mentionFor(oldOwner)}:repeat: *Texting: ${takerName} took ${who} from you.* They own this customer now.`,
    `<${inboxLink(phone)}|Open in the Texting inbox>`,
  ].join("\n");
  return postSmsSlack(text);
}

/** Session 8 PR 2b: who stops "was in Hatch" leads in Hatch (Steven, 2026-11-17: Melanie). */
export function hatchContactEmail(): string {
  return (process.env.SMS_HATCH_ALERT_EMAIL || "mfreeman@dendefenders.com").trim().toLowerCase();
}

/**
 * Session 8 PR 2b (Hatch guard): a new lead was already in Hatch, so Denny sent the "we switched"
 * text and is holding its drip. Tags Melanie (Slack member ID on the Team page) to stop them in Hatch.
 */
export async function postInHatchAlert(phone: string, lastAt: string | null, workspace: string | null): Promise<void> {
  if (!slackAlertsEnabled()) return;
  let mention = "";
  try {
    if (teamDatabaseConfigured()) {
      const member = await findTeamMember(hatchContactEmail());
      if (member?.active && member.slackMemberId) mention = `<@${member.slackMemberId}> `;
    }
  } catch {
    // tag is best effort
  }
  let fromLine = "";
  try {
    const contact = await ensureContact(phone);
    const name = await numberName(contact.ourNumber);
    if (contact.ourNumber) fromLine = ` from ${name && name !== formatPhone(contact.ourNumber) ? `${name} ` : ""}${formatPhone(contact.ourNumber)}`;
  } catch {
    // number name is best effort
  }
  const when = lastAt ? new Date(lastAt).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" }) : "recently";
  const text = [
    `${pilotTag()}${await marketTag(phone)}${mention}:warning: *Texting: new lead was already in Hatch* - ${formatPhone(phone)}`,
    `Hatch had them in the last 60 days (last activity ${when}${workspace ? `, ${workspace}` : ""}). Denny sent the "we switched" text${fromLine} and is holding its drip.`,
    "Stop them in Hatch, then click *Stopped in Hatch* in the inbox to start Denny's drip.",
    `<${inboxLink(phone)}|Open in the Texting inbox>`,
  ].join("\n");
  return postSmsSlack(text);
}

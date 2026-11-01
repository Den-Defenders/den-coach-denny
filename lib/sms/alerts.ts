/**
 * lib/sms/alerts.ts
 *
 * Optional Slack alerts for the Texting inbox (SMS_SLACK_WEBHOOK_URL).
 * Every alert carries a link that opens the conversation in Den Coach Denny.
 * Alerts never block a webhook or a reply: failures are only logged.
 */
import { formatPhone } from "@/lib/sms/rules";
import { allowList } from "@/lib/sms/send";

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
export function postCustomerWaitingAlert(phone: string, body: string, photos: number): Promise<void> {
  const preview = body.replace(/\s+/g, " ").trim().slice(0, 200);
  const text = [
    `${pilotTag()}:speech_balloon: *Texting: customer is waiting for a person* - ${formatPhone(phone)}`,
    preview ? `"${preview}"${photos ? ` (+${photos} photo${photos === 1 ? "" : "s"})` : ""}` : photos ? `(${photos} photo${photos === 1 ? "" : "s"})` : "",
    "The AI is paused for this number, so nobody answers until someone replies.",
    `<${inboxLink(phone)}|Open in the Texting inbox>`,
  ].filter(Boolean).join("\n");
  return postSmsSlack(text);
}

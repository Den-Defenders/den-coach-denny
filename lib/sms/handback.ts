/**
 * lib/sms/handback.ts
 *
 * "🤖 Hand back to AI" (Steven, 2026-11-18, after Melanie flagged that a CSR stepping in
 * stopped all automation, like Hatch). After a CSR calls, leaves a voicemail or texts,
 * one click puts the AI back in charge:
 *   - the AI answers the customer's next text (Needs CSR flags are cleared, except an open
 *     "Was in Hatch" one, which waits for "Stopped in Hatch");
 *   - a lead who never replied gets Melanie's drip back at the next text still ahead;
 *   - everyone else gets AI follow-ups on their cadence, counted from the hand-back
 *     (the AI reads the team's notes, so it knows about the call);
 *   - nothing automatic in 📅 Booked, 🚫 Not interested or 🗑️ Spam, after STOP,
 *     "Stop auto texts", a ServiceTitan block or a blocked send: the AI only answers.
 * The owner keeps the customer (tagged in Slack if the AI flags the chat again). With the
 * AI answering, nobody is "waiting", so the 1-hour release and the 10-waiting cap don't
 * apply, and the chat leaves the CSR's quiet follow-up list (a "Follow up later" date stays
 * on it as a call reminder).
 * "⏰ Follow up later" hands back too (lib/sms/folders.ts).
 */
import { resumeStoppedDrip } from "@/lib/sms/drip";
import { NO_AUTO_TEXT_FOLDERS, followUpPlanFor } from "@/lib/sms/followup";
import { audit, findOptOut, followUpsOn, handBackBot, lastFollowUpsStop, smsDb } from "@/lib/sms/store";

export type HandBackResult = {
  ok: boolean;
  /** What runs automatically now. */
  autoTexts: "drip" | "followups" | "replies_only" | "none";
  /** When the next automatic text is due (drip or follow-up), if any. */
  nextAt: string | null;
  /** Why there are no automatic texts (replies_only). */
  why: string | null;
  message: string;
};

function when(at: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
}

const FOLDER_WHY: Record<string, string> = {
  booked: "it's in 📅 Booked",
  not_interested: "it's in 🚫 Not interested",
  spam: "it's in 🗑️ Spam",
};

function stopWhy(reason: string): string {
  if (reason.startsWith("by ")) return "someone clicked \"Stop auto texts\" earlier";
  if (reason === "servicetitan") return "ServiceTitan blocks automatic texts for this customer";
  if (reason.startsWith("send blocked")) return "an automatic text was blocked earlier";
  return "automatic texts were stopped earlier";
}

/** Put the AI back in charge of this customer. Safe to click twice. */
export async function handBackToAi(phone: string, by: string, now: Date, via: "button" | "follow_up_later" = "button"): Promise<HandBackResult> {
  if (await findOptOut(phone)) {
    return { ok: false, autoTexts: "none", nextAt: null, why: "opted out", message: "This customer opted out (STOP). The AI stays off." };
  }
  await handBackBot(phone, by, now);

  const sql = await smsDb();
  const rows = await sql`SELECT folder, lead_at, lead_status, followups_off, drip_status, drip_next_at FROM sms_conversations WHERE phone = ${phone}`;
  const row = rows[0] || {};
  let autoTexts: HandBackResult["autoTexts"] = "replies_only";
  let nextAt: Date | null = null;
  let why: string | null = null;

  const folder = String(row.folder || "");
  if (!row.lead_at) why = "they didn't come from a lead form (follow-ups are for form leads)";
  else if (NO_AUTO_TEXT_FOLDERS.includes(folder)) why = FOLDER_WHY[folder];
  else if (row.lead_status === "not_interested") why = "they said they're not interested";
  else {
    if (row.followups_off === true) {
      // "Follow up later" / an old Booked filing turned them off without a reason: turn them back on.
      // "Stop auto texts", ServiceTitan and blocked sends stay off.
      const stop = await lastFollowUpsStop(phone);
      if (stop) why = stopWhy(stop.reason);
      else await followUpsOn(phone);
    }
    if (!why) {
      const drip = await resumeStoppedDrip(phone, by, now);
      const fresh = (await sql`SELECT drip_status, drip_next_at FROM sms_conversations WHERE phone = ${phone}`)[0] || {};
      if (fresh.drip_status === "hatch_hold") {
        why = "the drip waits until Melanie clicks \"Stopped in Hatch\"";
      } else if (drip === "started" || fresh.drip_status === "active") {
        autoTexts = "drip";
        nextAt = fresh.drip_next_at ? new Date(fresh.drip_next_at as string) : null;
      } else {
        const plan = await followUpPlanFor(phone);
        if ("due" in plan) {
          autoTexts = "followups";
          nextAt = plan.due;
        } else {
          why = plan.none.charAt(0).toLowerCase() + plan.none.slice(1);
        }
      }
    }
  }

  await audit({ phone, action: "ai_handed_back", reason: via, detail: { autoTexts, nextAt: nextAt?.toISOString() ?? null, why }, actor: by });
  const message = autoTexts === "drip"
    ? `🤖 Handed back to the AI. It answers their next text, and Melanie's drip picks up again${nextAt ? ` ${when(nextAt)}` : ""}.`
    : autoTexts === "followups"
      ? `🤖 Handed back to the AI. It answers their next text, and its next follow-up goes out ${nextAt ? `about ${when(nextAt)}` : "on its usual schedule"} if they don't text first.`
      : `🤖 Handed back to the AI. It answers their next text. No automatic follow-ups: ${why}.`;
  return { ok: true, autoTexts, nextAt: nextAt ? nextAt.toISOString() : null, why, message };
}

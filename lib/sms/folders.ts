/**
 * lib/sms/folders.ts
 *
 * Session 7 PR 3 (Steven, 2026-11-11/13): chat folders + "My follow-ups".
 *
 * Folders (sms_conversations.folder, null = the inbox):
 *   💬 Inbox          — every chat starts here; the usual filters (Needs CSR, Mine…) work here.
 *   📅 Booked         — "Booked in ServiceTitan" files it here automatically. No drip, no AI follow-ups.
 *   🚫 Not interested — said no but didn't text STOP. Lead status not_interested (AI follow-ups stop), no drip.
 *   🔁 Revisit        — a CSR picks a date; on that date it shows up in their follow-ups. No drip, no AI follow-ups.
 *   🗑️ Spam           — hidden. AI off, no Slack alerts, no hold texts, no Needs CSR, nothing automatic.
 *                        Stays in Spam even if the number texts again.
 *   🧪 Test           — hidden from the inbox, but everything still works (AI, Slack, drip) for testing.
 * A new text from the customer brings Booked / Not interested / Revisit chats back to the inbox.
 * STOP/START/HELP always work in every folder.
 *
 * "My follow-ups": a CSR's own customers they need to chase themselves, oldest first:
 *   - inbox chats they own where we texted last and the customer has been quiet for at
 *     least 1 work day (8 hours of team time, Mon–Sat 8 AM–4 PM Pacific), and the AI's own
 *     follow-ups won't handle it (AI paused, "Stop auto texts", or not a form lead);
 *   - their Revisit chats once the date arrives.
 * Never opted out or with an open booking. Managers and owners see everyone's.
 */
import { stopDrip } from "@/lib/sms/drip";
import { teamMinutesBetween } from "@/lib/sms/ownership";
import {
  audit,
  followUpCandidates,
  followUpsOff,
  quietForSpam,
  setFolder,
  setLeadStatus,
  type ChatFolder,
} from "@/lib/sms/store";

export const FOLDER_LABELS: Record<ChatFolder, string> = {
  active: "💬 Inbox",
  booked: "📅 Booked",
  not_interested: "🚫 Not interested",
  revisit: "🔁 Revisit",
  spam: "🗑️ Spam",
  test: "🧪 Test",
};

/** 1 work day of team time before a quiet customer shows up on the follow-up list. */
export const FOLLOW_UP_QUIET_MINUTES = 8 * 60;

/** Move a chat to a folder, with what that folder means for automatic texts. */
export async function moveChat(phone: string, folder: ChatFolder, by: string, at: Date, options: { revisitAt?: Date | null; from?: ChatFolder } = {}): Promise<void> {
  const revisitAt = folder === "revisit" ? options.revisitAt ?? null : null;
  await setFolder(phone, folder, by, at, revisitAt);
  if (folder === "booked" || folder === "revisit") {
    await stopDrip(phone, folder === "booked" ? "booked" : "filed to revisit later", by, at);
    await followUpsOff(phone);
  } else if (folder === "not_interested") {
    await setLeadStatus(phone, "not_interested", at);
    await stopDrip(phone, "not interested", by, at);
  } else if (folder === "spam") {
    await stopDrip(phone, "spam", by, at);
    await quietForSpam(phone, by, at);
  }
  await audit({
    phone,
    action: "folder_moved",
    reason: folder,
    detail: { from: options.from ?? null, to: folder, revisitAt: revisitAt ? revisitAt.toISOString() : null },
    actor: by,
  });
}

/** Revisit presets in the "Move to…" menu. */
export function revisitDate(preset: string, now: Date): Date | null {
  const days = preset === "2w" ? 14 : preset === "1m" ? 30 : preset === "3m" ? 91 : null;
  if (days) return new Date(now.getTime() + days * 24 * 3600_000);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(preset);
  if (!m) return null;
  // A picked date = 8 AM Pacific that day (the start of the team's day), roughly; DST-safe enough for a list.
  const at = new Date(`${m[1]}-${m[2]}-${m[3]}T16:00:00Z`);
  if (Number.isNaN(at.getTime()) || at.getTime() < now.getTime() - 24 * 3600_000) return null;
  return at;
}

export type FollowUpItem = {
  phone: string;
  owner: string | null;
  reason: "quiet" | "revisit_due";
  /** For quiet chats: our last text; for revisit: the revisit date. Oldest first. */
  since: string;
  quietDays: number;
  label: string;
};

function days(from: number, to: number): number {
  return Math.max(0, Math.floor((to - from) / (24 * 3600_000)));
}

/** The follow-up list for one person (or everyone, for managers). */
export async function followUpList(owner: string | null, now: Date): Promise<FollowUpItem[]> {
  const items: FollowUpItem[] = [];
  for (const c of await followUpCandidates(owner ?? undefined)) {
    if (c.folder === "revisit") {
      if (!c.revisitAt || Date.parse(c.revisitAt) > now.getTime()) continue;
      const late = days(Date.parse(c.revisitAt), now.getTime());
      items.push({ phone: c.phone, owner: c.owner, reason: "revisit_due", since: c.revisitAt, quietDays: c.lastOutAt ? days(Date.parse(c.lastOutAt), now.getTime()) : 0, label: late ? `🔁 Revisit was due ${late} day${late === 1 ? "" : "s"} ago` : "🔁 Revisit due today" });
      continue;
    }
    if (!c.lastOutAt) continue;
    const lastOut = new Date(c.lastOutAt);
    if (teamMinutesBetween(lastOut, now) < FOLLOW_UP_QUIET_MINUTES) continue;
    const quiet = days(lastOut.getTime(), now.getTime());
    items.push({ phone: c.phone, owner: c.owner, reason: "quiet", since: c.lastOutAt, quietDays: quiet, label: `💤 Quiet ${quiet < 1 ? "1 work day" : `${quiet} day${quiet === 1 ? "" : "s"}`}` });
  }
  return items.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
}

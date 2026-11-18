/**
 * lib/sms/hatchGuard.ts
 *
 * Session 8 PR 2b, the "Hatch guard" (Steven, 2026-11-17): while ad sets move from Hatch to
 * Denny, a lead who filled out a Hatch form recently may still be in Hatch's drip. If they
 * fill out the form again, Denny must not start a second drip on top of Hatch's.
 *
 * When a new lead's welcome is due (lib/sms/drip.ts, step 1), Denny looks the phone up in the
 * stored Hatch history (read-only MCP tool hatch_stored_search_contacts, same machine login as
 * the Hatch STOP import). If Hatch had activity with them in the last 60 days:
 *   1. Denny sends ONE "we switched" text from the new local number instead of the welcome
 *      (Steven's wording, same 8 AM - 8 PM window as the welcome, still asks about a call).
 *   2. The drip waits (drip_status 'hatch_hold'); the chat shows Needs CSR "Was in Hatch: stop
 *      them in Hatch" and Slack tags Melanie (she removes them from Hatch's campaign).
 *   3. "Stopped in Hatch" in the inbox starts Denny's drip at the next text for that day.
 *   If they reply in the meantime, the AI answers as usual (the hold ends like any drip).
 *
 * The Hatch copy syncs about once a day, so a lead Hatch texted in the last ~24 hours can slip
 * through. If the lookup fails, the normal welcome goes out (a lead is never left waiting).
 * Off switch: SMS_HATCH_GUARD=off (+ Redeploy), once Hatch is cancelled.
 */
import { callTextingReadTool } from "@/lib/websiteBotMcp";

export const HATCH_GUARD_DAYS = 60;

/** Steven, 2026-11-17 (first sentence approved as written; the STOP line matches the normal welcome). */
export const HATCH_SWITCH_NOW =
  "Hi {first}, it's Den Defenders! Thanks for reaching out again. We now text from this local number, so you can reach us right here. Is now a good time for a quick call?\n\nReply STOP to opt out.";
/** From 5 PM their time, like the welcome: ask about tomorrow. */
export const HATCH_SWITCH_TOMORROW =
  "Hi {first}, it's Den Defenders! Thanks for reaching out again. We now text from this local number, so you can reach us right here. When's a good time for a quick call tomorrow?\n\nReply STOP to opt out.";

export function hatchGuardEnabled(): boolean {
  const v = (process.env.SMS_HATCH_GUARD || "").trim().toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

export type HatchActivity =
  | { ok: true; inHatch: boolean; lastAt: string | null; workspace: string | null; contacts: number }
  | { ok: false; error: string };

type Lookup = (phoneDigits: string) => Promise<{ hatch_updated_at?: string | null; workspace_name?: string | null }[]>;

const realLookup: Lookup = async (phoneDigits) => {
  const result = (await callTextingReadTool("hatch_stored_search_contacts", { phone: phoneDigits, maxResults: 50 }, 20_000)) as
    { contacts?: { hatch_updated_at?: string | null; workspace_name?: string | null }[] } | string;
  if (!result || typeof result !== "object" || !Array.isArray(result.contacts)) {
    throw new Error(`Unexpected Hatch contact result: ${String(typeof result === "string" ? result : JSON.stringify(result)).slice(0, 200)}`);
  }
  return result.contacts;
};
let lookup: Lookup = realLookup;
export function setHatchLookupForTests(fn: Lookup | null) {
  lookup = fn ?? realLookup;
}

/** Did Hatch have this phone in the last 60 days? Phone = E.164 (+1XXXXXXXXXX). */
export async function hatchActivity(phone: string, now: Date): Promise<HatchActivity> {
  const digits = phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (digits.length !== 10) return { ok: false, error: "not a US number" };
  try {
    const contacts = await lookup(digits);
    let last = 0;
    let workspace: string | null = null;
    for (const c of contacts) {
      const t = Date.parse(String(c.hatch_updated_at || ""));
      if (Number.isFinite(t) && t > last) {
        last = t;
        workspace = c.workspace_name ? String(c.workspace_name) : null;
      }
    }
    const inHatch = last > 0 && now.getTime() - last <= HATCH_GUARD_DAYS * 86_400_000;
    return { ok: true, inHatch, lastAt: last ? new Date(last).toISOString() : null, workspace, contacts: contacts.length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 200) : "Hatch lookup failed" };
  }
}

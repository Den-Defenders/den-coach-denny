/**
 * lib/sms/hatchOptOuts.ts
 *
 * Session 6 PR 2: bring every Hatch STOP into Denny's opt-out list before any
 * real lead gets a text (a person who said STOP to Den Defenders on a Hatch
 * number must not start getting texts from the new Twilio number).
 *
 * Source: the Den Defenders copy of Hatch history in the ServiceTitan MCP's Neon
 * database, read with the read-only MCP tool hatch_stored_search_messages through
 * the website bot's machine login (same path as the ServiceTitan exclusion check).
 * Hatch's own "opted_out" field is empty in the export, so we read the customers'
 * own texts and classify each one with Denny's STOP/START rules (lib/sms/rules.ts).
 *
 * Two steps on the owner page (/sms-test):
 *   1. Scan: one date window per request (the page loops week by week). Every STOP
 *      or START text found is saved in sms_hatch_optout_events (one row per Hatch
 *      message, so re-scanning is safe). A number's newest event decides: a START
 *      after a STOP means they resubscribed in Hatch and are left alone.
 *   2. Add: every number whose newest event is STOP and that isn't on the pilot
 *      allow-list goes into sms_opt_outs with source "hatch_import" (Denny-only, so
 *      a later START to our number is confirmed by Denny), consent is revoked and
 *      any running drip stops. Numbers already opted out in Denny are left as they are.
 *
 * Phone numbers never leave the server: the page only sees counts and masked samples.
 */
import { callTextingReadTool } from "@/lib/websiteBotMcp";
import { classifyKeyword, normalizePhone } from "@/lib/sms/rules";
import { allowList } from "@/lib/sms/send";
import { audit, smsDb } from "@/lib/sms/store";

export const HATCH_IMPORT_SOURCE = "hatch_import";
/** First day of stored Hatch messages (hatch_database_status, 2026-11-04). */
export const HATCH_HISTORY_START = "2026-05-25";

/**
 * Substring searches that cover every STOP/START wording Denny honors
 * (TWILIO_STOP_WORDS, EXTRA_STOP_PHRASES, START_WORDS). They also return plenty
 * of normal texts ("send", "cancel my appointment"); classifyKeyword sorts them out.
 */
export const HATCH_QUERIES = [
  "stop", "end", "quit", "cancel", "unsubscribe", "revoke", "opt", "remove me",
  "take me off", "t text", "no more", "leave me alone", "start",
];
const MAX_RESULTS = 500;

export type HatchMatch = {
  hatch_message_id?: string | null;
  contact_id?: string | null;
  direction?: string | null;
  actor_type?: string | null;
  body?: string | null;
  send_at?: string | null;
  hatch_updated_at?: string | null;
  workspace_name?: string | null;
  phone?: string | null;
};
type SearchArgs = { query: string; direction: "inbound"; startDate: string; endDate: string; maxResults: number };
type Search = (args: SearchArgs) => Promise<HatchMatch[]>;

const realSearch: Search = async (args) => {
  const result = (await callTextingReadTool("hatch_stored_search_messages", args, 45_000)) as { matches?: HatchMatch[] } | string;
  if (!result || typeof result !== "object" || !Array.isArray(result.matches)) {
    throw new Error(`Unexpected Hatch search result: ${String(typeof result === "string" ? result : JSON.stringify(result)).slice(0, 200)}`);
  }
  return result.matches;
};
let search: Search = realSearch;
export function setHatchSearchForTests(fn: Search | null) {
  search = fn ?? realSearch;
}

async function ensureTables() {
  const sql = await smsDb();
  await sql`CREATE TABLE IF NOT EXISTS sms_hatch_optout_events (
    hatch_message_id TEXT PRIMARY KEY,
    phone TEXT,
    contact_id TEXT,
    keyword TEXT NOT NULL CHECK (keyword IN ('stop', 'start')),
    matched TEXT,
    at TIMESTAMPTZ NOT NULL,
    workspace TEXT,
    scanned_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  return sql;
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

/** One query over a date window; halves the window while it hits the 500-result cap. */
async function searchWindow(query: string, start: string, end: string, notes: string[]): Promise<HatchMatch[]> {
  const rows = await search({ query, direction: "inbound", startDate: start, endDate: end, maxResults: MAX_RESULTS });
  if (rows.length < MAX_RESULTS) return rows;
  if (start === end) {
    notes.push(`"${query}" on ${start} hit ${MAX_RESULTS} results; some texts that day may be missed`);
    return rows;
  }
  const mid = addDays(start, Math.floor(daysBetween(start, end) / 2));
  return [...await searchWindow(query, start, mid, notes), ...await searchWindow(query, addDays(mid, 1), end, notes)];
}

export type ScanWindowResult = { start: string; end: string; textsChecked: number; stops: number; starts: number; noPhone: number; notes: string[] };

/** Scan one date window (inclusive, YYYY-MM-DD) and save every STOP/START text found. */
export async function scanHatchWindow(start: string, end: string): Promise<ScanWindowResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start || daysBetween(start, end) > 31) {
    throw new Error("Pick a window of at most 31 days (YYYY-MM-DD).");
  }
  const sql = await ensureTables();
  const notes: string[] = [];
  const seen = new Map<string, HatchMatch>();
  for (const query of HATCH_QUERIES) {
    for (const row of await searchWindow(query, start, end, notes)) {
      const id = row.hatch_message_id || "";
      if (id && !seen.has(id)) seen.set(id, row);
    }
  }
  let stops = 0, starts = 0, noPhone = 0;
  for (const [id, row] of seen) {
    if ((row.direction || "").toLowerCase() !== "inbound") continue;
    if (row.actor_type && row.actor_type !== "contact") continue;
    const kw = classifyKeyword(row.body || "", { optedOut: false }).keyword;
    if (kw !== "stop" && kw !== "start") continue;
    const phone = row.phone ? normalizePhone(row.phone) : null;
    if (!phone) noPhone++;
    if (kw === "stop") stops++; else starts++;
    const at = row.send_at || row.hatch_updated_at || `${end}T23:59:59Z`;
    await sql`INSERT INTO sms_hatch_optout_events (hatch_message_id, phone, contact_id, keyword, matched, at, workspace)
      VALUES (${id}, ${phone}, ${row.contact_id || null}, ${kw}, ${(row.body || "").trim().slice(0, 60)}, ${at}::timestamptz, ${row.workspace_name || null})
      ON CONFLICT (hatch_message_id) DO UPDATE SET phone = COALESCE(EXCLUDED.phone, sms_hatch_optout_events.phone), scanned_at = now()`;
  }
  return { start, end, textsChecked: seen.size, stops, starts, noPhone, notes };
}

/** "+19165551234" -> "(916) ***-1234" (the page never shows full numbers). */
function mask(phone: string): string {
  const d = phone.replace(/^\+1/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ***-${d.slice(6)}` : "***";
}

type Latest = { key: string; phone: string | null; keyword: "stop" | "start"; at: string; workspace: string | null; matched: string | null; alreadyOptedOut: boolean };

async function latestByNumber(): Promise<Latest[]> {
  const sql = await ensureTables();
  const rows = await sql`SELECT DISTINCT ON (k) k, phone, keyword, at, workspace, matched, already
    FROM (SELECT COALESCE(e.phone, 'hatch:' || COALESCE(e.contact_id, e.hatch_message_id)) AS k, e.phone, e.keyword, e.at, e.workspace, e.matched,
            (o.phone IS NOT NULL) AS already
          FROM sms_hatch_optout_events e LEFT JOIN sms_opt_outs o ON o.phone = e.phone) x
    ORDER BY k, at DESC`;
  return rows.map((r) => ({
    key: String(r.k), phone: (r.phone as string) || null, keyword: r.keyword === "start" ? "start" : "stop",
    at: new Date(r.at as string).toISOString(), workspace: (r.workspace as string) || null, matched: (r.matched as string) || null,
    alreadyOptedOut: Boolean(r.already),
  }));
}

export type HatchOptOutSummary = {
  stopTexts: number;
  numbersToAdd: number;
  alreadyOptedOut: number;
  resubscribed: number;
  onAllowList: number;
  noPhone: number;
  imported: number;
  oldest: string | null;
  newest: string | null;
  byWorkspace: { workspace: string; count: number }[];
  samples: { phone: string; date: string; workspace: string | null; text: string | null }[];
};

export async function hatchOptOutSummary(): Promise<HatchOptOutSummary> {
  const sql = await ensureTables();
  const latest = await latestByNumber();
  const allowed = new Set(allowList().numbers);
  const toAdd = latest.filter((l) => l.keyword === "stop" && l.phone && !l.alreadyOptedOut && !allowed.has(l.phone));
  const counts = await sql`SELECT
      (SELECT count(*) FROM sms_hatch_optout_events WHERE keyword = 'stop') AS stop_texts,
      (SELECT min(at) FROM sms_hatch_optout_events) AS oldest,
      (SELECT max(at) FROM sms_hatch_optout_events) AS newest,
      (SELECT count(*) FROM sms_opt_outs WHERE source = ${HATCH_IMPORT_SOURCE}) AS imported`;
  const byWorkspace = new Map<string, number>();
  for (const l of toAdd) byWorkspace.set(l.workspace || "unknown", (byWorkspace.get(l.workspace || "unknown") || 0) + 1);
  return {
    stopTexts: Number(counts[0].stop_texts) || 0,
    numbersToAdd: toAdd.length,
    alreadyOptedOut: latest.filter((l) => l.keyword === "stop" && l.alreadyOptedOut).length,
    resubscribed: latest.filter((l) => l.keyword === "start").length,
    onAllowList: latest.filter((l) => l.keyword === "stop" && l.phone && allowed.has(l.phone) && !l.alreadyOptedOut).length,
    noPhone: latest.filter((l) => l.keyword === "stop" && !l.phone).length,
    imported: Number(counts[0].imported) || 0,
    oldest: counts[0].oldest ? new Date(counts[0].oldest as string).toISOString() : null,
    newest: counts[0].newest ? new Date(counts[0].newest as string).toISOString() : null,
    byWorkspace: [...byWorkspace].map(([workspace, count]) => ({ workspace, count })).sort((a, b) => b.count - a.count),
    samples: toAdd.slice(0, 8).map((l) => ({ phone: mask(l.phone || ""), date: l.at.slice(0, 10), workspace: l.workspace, text: l.matched })),
  };
}

/** Add every number whose newest Hatch text is a STOP to Denny's opt-out list. */
export async function importHatchOptOuts(by: string, now: Date): Promise<{ added: number }> {
  const sql = await ensureTables();
  const allowed = new Set(allowList().numbers);
  const toAdd = (await latestByNumber()).filter((l) => l.keyword === "stop" && l.phone && !l.alreadyOptedOut && !allowed.has(l.phone));
  let added = 0;
  for (const l of toAdd) {
    const phone = l.phone as string;
    const inserted = await sql`INSERT INTO sms_opt_outs (phone, opted_out_at, source, keyword)
      VALUES (${phone}, ${l.at}::timestamptz, ${HATCH_IMPORT_SOURCE}, ${(l.matched || "STOP").toUpperCase().slice(0, 40)})
      ON CONFLICT (phone) DO NOTHING RETURNING phone`;
    if (!inserted.length) continue;
    added++;
    await sql`UPDATE sms_consent SET revoked_at = ${now.toISOString()}::timestamptz WHERE phone = ${phone} AND revoked_at IS NULL`;
    await sql`UPDATE sms_conversations SET drip_status = 'stopped', drip_stop_reason = 'opted out in Hatch',
        drip_stopped_at = ${now.toISOString()}::timestamptz, drip_stopped_by = ${by.slice(0, 120)}, drip_next_at = NULL, updated_at = now()
      WHERE phone = ${phone} AND drip_status = 'active'`;
    await audit({ phone, action: "opt_out", reason: HATCH_IMPORT_SOURCE, detail: { hatchStopAt: l.at, workspace: l.workspace }, actor: by });
  }
  await audit({ phone: null, action: "hatch_optout_import", reason: `${added} added`, detail: { candidates: toAdd.length }, actor: by });
  return { added };
}

/** Clear the scan results (not the opt-out list) to scan again from scratch. */
export async function clearHatchScan() {
  const sql = await ensureTables();
  await sql`DELETE FROM sms_hatch_optout_events`;
}

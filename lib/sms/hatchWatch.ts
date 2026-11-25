/**
 * lib/sms/hatchWatch.ts
 *
 * The "Hatch watch" (Steven + Mike, 2026-11-25): a safety net so a paid lead can never
 * vanish in Hatch again.
 *
 * Why: Hatch only texts a Facebook/TikTok lead when one board's audience matches the lead's
 * source + ZIP. When nothing matches, the lead sits in Hatch's contact list with no campaign,
 * no text and no alert. About 150 leads were lost that way between late August and November
 * before anyone noticed.
 *
 * How:
 *   1. Every Zap that sends leads to Hatch ALSO posts the lead to
 *      POST /api/leads?watch=hatch (same X-Denny-Secret). Denny saves it in hatch_watch_leads.
 *      Denny never texts these leads (they belong to Hatch).
 *   2. Hatch's data reaches Denny through the ServiceTitan MCP's stored Hatch copy, which syncs
 *      once a day (whole UTC days, through yesterday). /api/hatch-watch (GitHub Actions, every
 *      30 minutes in the morning) checks each saved lead that the copy now covers: did Hatch put
 *      that phone (or email) in any campaign after the lead came in?
 *   3. When everything the copy covers has been checked, Denny posts ONE Slack message listing
 *      every lead Hatch never picked up, so a CSR can call them. If all leads made it, it posts a
 *      one-line "all good" so a quiet channel never hides a broken check.
 *
 * Safe by design: read-only toward Hatch and ServiceTitan. If the Hatch copy can't be read or
 * hasn't been updated, nothing is called missed; Slack gets a warning instead (once a day, after noon).
 *
 * Slack: HATCH_WATCH_SLACK_WEBHOOK_URL (falls back to SMS_SLACK_WEBHOOK_URL).
 * Off switch: HATCH_WATCH=off (+ Redeploy).
 */
import type { ParsedLead } from "@/lib/sms/leads";
import { callTextingReadTool } from "@/lib/websiteBotMcp";
import { smsDb } from "@/lib/sms/store";

/** Leads older than this are dropped from the check (the copy should have covered them long ago). */
export const WATCH_MAX_AGE_DAYS = 7;
/** A Hatch campaign row this long BEFORE the lead still counts (clock differences, Zap delays). */
const MATCH_TOLERANCE_MS = 2 * 60 * 60 * 1000;
/** Stay this far inside the last day the Hatch copy covers. */
const COVERAGE_MARGIN_MS = 30 * 60 * 1000;
const TZ = "America/Los_Angeles";

export function hatchWatchEnabled(): boolean {
  const v = (process.env.HATCH_WATCH || "").trim().toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

let tablesReady: Promise<void> | null = null;

async function watchDb() {
  const sql = await smsDb();
  if (!tablesReady) {
    tablesReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS hatch_watch_leads (
        id BIGSERIAL PRIMARY KEY,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        phone TEXT,
        first_name TEXT,
        last_name TEXT,
        email TEXT,
        zip TEXT,
        zip_as_sent TEXT,
        ad_set TEXT,
        campaign_name TEXT,
        ad_name TEXT,
        form_name TEXT,
        lead_source TEXT,
        platform TEXT,
        raw JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        hatch_last_at TIMESTAMPTZ,
        hatch_workspace TEXT,
        hatch_campaign TEXT,
        checked_at TIMESTAMPTZ,
        alerted_at TIMESTAMPTZ,
        error TEXT
      )`;
      await sql`CREATE INDEX IF NOT EXISTS hatch_watch_status ON hatch_watch_leads (status, received_at)`;
      await sql`CREATE TABLE IF NOT EXISTS hatch_watch_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    })().catch((error) => { tablesReady = null; throw error; });
  }
  await tablesReady;
  return sql;
}

/** Tests only. */
export function resetHatchWatchTablesForTests() { tablesReady = null; }

const ZIP_KEYS = new Set(["zip", "zipcode", "postalcode", "postcode", "zippostalcode"]);
const keyOf = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The ZIP exactly as the form sent it (ZIP+4, full address...), so the alert shows what went wrong. */
export function zipAsSent(raw: Record<string, string>): string | null {
  for (const [k, v] of Object.entries(raw)) {
    if (ZIP_KEYS.has(keyOf(k.split(".").pop() || k))) {
      const s = String(v ?? "").trim();
      return s ? s.slice(0, 60) : null;
    }
  }
  return null;
}

/** Save one Hatch-bound lead for the daily check. Never texts anyone. */
export async function saveWatchLead(lead: ParsedLead, at: Date): Promise<number> {
  const sql = await watchDb();
  const f = lead.fields;
  const rows = await sql`INSERT INTO hatch_watch_leads
      (received_at, phone, first_name, last_name, email, zip, zip_as_sent, ad_set, campaign_name, ad_name, form_name, lead_source, platform, raw)
    VALUES (${at.toISOString()}::timestamptz, ${f.phone}, ${f.firstName}, ${f.lastName}, ${f.email}, ${f.zip}, ${zipAsSent(lead.raw)},
      ${f.adSet}, ${f.campaignName}, ${f.adName}, ${f.formName}, ${f.leadSource}, ${f.platform}, ${JSON.stringify(lead.raw)}::jsonb)
    RETURNING id`;
  return Number(rows[0].id);
}

async function getState(key: string): Promise<string | null> {
  const sql = await watchDb();
  const rows = await sql`SELECT value FROM hatch_watch_state WHERE key = ${key}`;
  return rows.length ? String(rows[0].value) : null;
}

async function setState(key: string, value: string) {
  const sql = await watchDb();
  await sql`INSERT INTO hatch_watch_state (key, value, updated_at) VALUES (${key}, ${value}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export type HatchRow = { hatch_updated_at?: string | null; workspace_name?: string | null; campaign_name?: string | null };
type Lookup = (by: { phone?: string; email?: string }) => Promise<HatchRow[]>;
type CoverageReader = () => Promise<string | null>;

const realLookup: Lookup = async (by) => {
  const args: Record<string, unknown> = { maxResults: 50 };
  if (by.phone) args.phone = by.phone;
  else if (by.email) args.email = by.email;
  const result = (await callTextingReadTool("hatch_stored_search_contacts", args, 15_000)) as { contacts?: HatchRow[] } | string;
  if (!result || typeof result !== "object" || !Array.isArray(result.contacts)) {
    throw new Error(`Unexpected Hatch contact result: ${String(typeof result === "string" ? result : JSON.stringify(result)).slice(0, 200)}`);
  }
  return result.contacts;
};

/** Last whole day (YYYY-MM-DD, UTC) the stored Hatch contact copy covers, or null if unknown. */
const realCoverage: CoverageReader = async () => {
  const result = (await callTextingReadTool("hatch_database_status", {}, 15_000)) as
    { syncStates?: { data_source?: string; newest_imported_date?: string | null; last_error?: string | null }[] } | string;
  if (!result || typeof result !== "object" || !Array.isArray(result.syncStates)) return null;
  const state = result.syncStates.find((s) => s.data_source === "contact_history");
  const newest = state?.newest_imported_date ? String(state.newest_imported_date).slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(newest) ? newest : null;
};

let lookup: Lookup = realLookup;
let coverage: CoverageReader = realCoverage;
let poster: (text: string) => Promise<boolean> = postWatchSlack;
export function setHatchWatchDepsForTests(deps: { lookup?: Lookup | null; coverage?: CoverageReader | null; post?: ((text: string) => Promise<boolean>) | null }) {
  lookup = deps.lookup ?? realLookup;
  coverage = deps.coverage ?? realCoverage;
  poster = deps.post ?? postWatchSlack;
}

/** End of the covered UTC day, minus a margin: leads received before this can be judged. */
export function coveredUntil(coveredDay: string): Date {
  return new Date(Date.parse(`${coveredDay}T00:00:00.000Z`) + 86_400_000 - COVERAGE_MARGIN_MS);
}

/** Did Hatch put this lead in a campaign? Newest matching row at/after the lead (minus tolerance). */
export function judge(rows: HatchRow[], receivedAt: Date): { inHatch: boolean; lastAt: string | null; workspace: string | null; campaign: string | null } {
  let best = 0;
  let workspace: string | null = null;
  let campaign: string | null = null;
  for (const r of rows) {
    const t = Date.parse(String(r.hatch_updated_at || ""));
    if (Number.isFinite(t) && t > best) {
      best = t;
      workspace = r.workspace_name ? String(r.workspace_name) : null;
      campaign = r.campaign_name ? String(r.campaign_name) : null;
    }
  }
  const inHatch = best > 0 && best >= receivedAt.getTime() - MATCH_TOLERANCE_MS;
  return { inHatch, lastAt: best ? new Date(best).toISOString() : null, workspace, campaign };
}

export function ptDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function ptHour(d: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(d));
}

function prettyPhone(e164: string | null): string {
  const d = (e164 || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164 || "no phone";
}

function when(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
}

type WatchRow = {
  id: number;
  receivedAt: Date;
  phone: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  zip: string | null;
  zipAsSent: string | null;
  adSet: string | null;
  campaignName: string | null;
  platform: string | null;
};

function toWatchRow(r: Record<string, unknown>): WatchRow {
  const s = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
  return {
    id: Number(r.id),
    receivedAt: new Date(String(r.received_at)),
    phone: s(r.phone),
    email: s(r.email),
    firstName: s(r.first_name),
    lastName: s(r.last_name),
    zip: s(r.zip),
    zipAsSent: s(r.zip_as_sent),
    adSet: s(r.ad_set),
    campaignName: s(r.campaign_name),
    platform: s(r.platform),
  };
}

export function missedLine(r: WatchRow): string {
  const name = [r.firstName, r.lastName].filter(Boolean).join(" ") || "No name";
  const zip = r.zip ? `ZIP ${r.zip}${r.zipAsSent && r.zipAsSent !== r.zip ? ` (typed "${r.zipAsSent}")` : ""}` : r.zipAsSent ? `ZIP typed "${r.zipAsSent}"` : "no ZIP";
  const from = r.adSet || r.campaignName || r.platform || "";
  return `• *${name}* · ${prettyPhone(r.phone)} · ${zip}${from ? ` · ${from}` : ""} · ${when(r.receivedAt)}`;
}

export type WatchResult = {
  ok: boolean;
  skipped?: string;
  coveredDay?: string | null;
  checked: number;
  inHatch: number;
  missed: number;
  failed: number;
  pendingCoveredLeft: number;
  alerted: number;
  dropped: number;
};

const MAX_LINES = 40;

/**
 * One pass. Safe to call often: checks what the Hatch copy covers, within a time budget,
 * and posts the Slack summary only once everything covered has been checked.
 */
export async function runHatchWatch(now: Date, opts: { budgetMs?: number } = {}): Promise<WatchResult> {
  const result: WatchResult = { ok: true, checked: 0, inHatch: 0, missed: 0, failed: 0, pendingCoveredLeft: 0, alerted: 0, dropped: 0 };
  if (!hatchWatchEnabled()) return { ...result, skipped: "HATCH_WATCH is off" };
  const started = Date.now();
  const budget = opts.budgetMs ?? 40_000;
  const sql = await watchDb();

  // Too old to judge fairly: drop quietly (counted in the result).
  const cutoff = new Date(now.getTime() - WATCH_MAX_AGE_DAYS * 86_400_000).toISOString();
  const dropped = await sql`UPDATE hatch_watch_leads SET status = 'expired', checked_at = now()
    WHERE status = 'pending' AND received_at < ${cutoff}::timestamptz RETURNING id`;
  result.dropped = dropped.length;

  let coveredDay: string | null = null;
  try {
    coveredDay = await coverage();
  } catch (error) {
    console.error("Hatch watch: coverage check failed:", error instanceof Error ? error.message : error);
  }
  result.coveredDay = coveredDay;
  if (!coveredDay) {
    await warnOnce(now, "copy_unreadable", "⚠️ *Hatch check skipped:* Denny couldn't read the stored Hatch copy, so it can't tell which leads Hatch missed. Nothing was marked missed. Check the ServiceTitan MCP's Hatch sync.");
    return { ...result, ok: false, skipped: "Hatch copy status unavailable" };
  }
  const until = coveredUntil(coveredDay);

  // Pending leads the copy now covers.
  const pending = (await sql`SELECT * FROM hatch_watch_leads
    WHERE status = 'pending' AND received_at < ${until.toISOString()}::timestamptz
    ORDER BY received_at ASC LIMIT 400`).map(toWatchRow);

  // If yesterday (PT) had leads but the copy doesn't reach it yet, say so after noon.
  const yesterdayPt = ptDay(new Date(now.getTime() - 86_400_000));
  const stale = await sql`SELECT count(*)::int AS n FROM hatch_watch_leads
    WHERE status = 'pending' AND received_at >= ${until.toISOString()}::timestamptz AND received_at < ${now.toISOString()}::timestamptz`;
  if (Number(stale[0]?.n || 0) > 0 && coveredDay < yesterdayPt && ptHour(now) >= 12) {
    await warnOnce(now, "copy_stale", `⚠️ *Hatch check is behind:* the stored Hatch copy only reaches ${coveredDay} (UTC), so newer leads can't be checked yet. Check the ServiceTitan MCP's daily Hatch sync.`);
  }

  // Check, a few at a time, inside the budget.
  const queue = [...pending];
  const worker = async () => {
    while (queue.length && Date.now() - started < budget) {
      const row = queue.shift()!;
      try {
        const digits = (row.phone || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
        let rows: HatchRow[] = [];
        if (digits.length === 10) rows = await lookup({ phone: digits });
        if (!rows.length && row.email) rows = await lookup({ email: row.email });
        const verdict = judge(rows, row.receivedAt);
        const status = verdict.inHatch ? "in_hatch" : "missed";
        await sql`UPDATE hatch_watch_leads SET status = ${status}, checked_at = now(), error = NULL,
            hatch_last_at = ${verdict.lastAt}::timestamptz, hatch_workspace = ${verdict.workspace}, hatch_campaign = ${verdict.campaign}
          WHERE id = ${row.id}`;
        result.checked += 1;
        if (verdict.inHatch) result.inHatch += 1;
        else result.missed += 1;
      } catch (error) {
        // Leave it pending; the next run retries.
        result.failed += 1;
        const message = error instanceof Error ? error.message.slice(0, 300) : "lookup failed";
        await sql`UPDATE hatch_watch_leads SET error = ${message} WHERE id = ${row.id}`.catch(() => undefined);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  const left = await sql`SELECT count(*)::int AS n FROM hatch_watch_leads
    WHERE status = 'pending' AND received_at < ${until.toISOString()}::timestamptz`;
  result.pendingCoveredLeft = Number(left[0]?.n || 0);
  if (result.pendingCoveredLeft > 0) return result;

  // Everything covered is checked: one summary for what hasn't been reported yet.
  const unreported = await sql`SELECT * FROM hatch_watch_leads
    WHERE status IN ('in_hatch', 'missed') AND alerted_at IS NULL ORDER BY received_at ASC`;
  if (!unreported.length) return result;
  const missed = unreported.filter((r) => r.status === "missed").map(toWatchRow);
  const total = unreported.length;
  const days = [...new Set(unreported.map((r) => ptDay(new Date(String(r.received_at)))))].sort();
  const md = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  const span = days.length === 1 ? md(days[0]) : `${md(days[0])} to ${md(days[days.length - 1])}`;

  let text: string;
  if (!missed.length) {
    text = `✅ *Hatch check:* all ${total} Facebook/TikTok lead${total === 1 ? "" : "s"} from ${span} reached a Hatch campaign.`;
  } else {
    const lines = missed.slice(0, MAX_LINES).map(missedLine);
    const more = missed.length > MAX_LINES ? `\n…and ${missed.length - MAX_LINES} more.` : "";
    const mostMissed = total >= 5 && missed.length / total > 0.8
      ? "\n⚠️ Most leads look missed. The Hatch copy may be incomplete, or a Zap/board broke. Spot-check a couple in Hatch before calling all of them."
      : "";
    text = `🚨 *Hatch missed ${missed.length} of ${total} lead${total === 1 ? "" : "s"}* from ${span}. They got no text and no campaign. Please call them:\n${lines.join("\n")}${more}${mostMissed}`;
  }
  const posted = await poster(text);
  if (posted) {
    const ids = unreported.map((r) => String(Number(r.id))).join(",");
    await sql`UPDATE hatch_watch_leads SET alerted_at = now() WHERE id::text = ANY(string_to_array(${ids}::text, ','))`;
    result.alerted = missed.length;
  }
  return result;
}

/** One warning per kind per PT day. */
async function warnOnce(now: Date, kind: string, text: string) {
  if (ptHour(now) < 12) return;
  const key = `warned:${kind}`;
  const today = ptDay(now);
  if ((await getState(key)) === today) return;
  if (await poster(text)) await setState(key, today);
}

export async function postWatchSlack(text: string): Promise<boolean> {
  const url = (process.env.HATCH_WATCH_SLACK_WEBHOOK_URL || process.env.SMS_SLACK_WEBHOOK_URL || "").trim();
  if (!url) {
    console.error("Hatch watch: no Slack webhook (HATCH_WATCH_SLACK_WEBHOOK_URL / SMS_SLACK_WEBHOOK_URL).");
    return false;
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) console.error("Hatch watch Slack post failed: HTTP", response.status);
    return response.ok;
  } catch (error) {
    console.error("Hatch watch Slack post failed:", error instanceof Error ? error.message : error);
    return false;
  }
}

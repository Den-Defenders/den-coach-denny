/**
 * lib/sms/stCheck.ts
 *
 * ServiceTitan exclusions (build step 5), checked before ANY automated text
 * (drip welcome, drip steps, AI follow-ups). Read-only MCP calls through the
 * website bot's machine login (lib/websiteBotMcp.ts callTextingReadTool).
 *
 * A number is excluded from automated texts when any ServiceTitan customer
 * with that phone (internal records like the showroom are ignored) has:
 *   - a tag on Melanie's list (customer, location or job tag), or
 *   - an open job: Scheduled, Dispatched, In progress/Working or Hold, or
 *   - a job canceled in the last CANCELED_DAYS days.
 *
 * Some tags also mean "a person answers, not the AI" (CSR_ONLY_TAGS, Steven
 * 2026-11-02). The inbound side uses that in a later PR; it's saved now.
 *
 * If the check fails (MCP down, permission), the result is ok:false and NO
 * automated text goes out (the drip tries again later).
 */
import { smsDb } from "@/lib/sms/store";
import { callTextingReadTool } from "@/lib/websiteBotMcp";

/** Melanie's list (2026-11-02). "Warranty" isn't a ServiceTitan tag; the closest is "Warranty Call". */
export const BLOCK_TAGS = [
  "1 Star Review",
  "CB: Warranty Request",
  "Do not auto-send invoice",
  "Do Not Service",
  "Fixed Bad Review",
  "No Drip!",
  "No Email Promotions",
  "Warranty",
  "Warranty Call",
];

/** These customers go straight to a person even when THEY text us first (Steven, 2026-11-02). */
export const CSR_ONLY_TAGS = ["Do Not Service", "1 Star Review", "Fixed Bad Review", "Warranty", "Warranty Call", "CB: Warranty Request"];

const OPEN_JOB_STATUSES = ["scheduled", "dispatched", "inprogress", "working", "hold", "onhold"];
export const CANCELED_DAYS = 90;
/** How long a check result is reused before asking ServiceTitan again. */
export const ST_CHECK_TTL_MS = 12 * 60 * 60 * 1000;

const INTERNAL_RECORD = /showroom|office|\btest\b|warehouse|den defenders|sample/i;

export type StCheck = {
  ok: boolean;
  /** True = no automated texts. */
  blocked: boolean;
  /** True = a person answers this customer, not the AI. */
  csrOnly: boolean;
  reasons: string[];
  customers: { id: number; name: string }[];
  error?: string;
  checkedAt: string;
};

const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
const BLOCK_SET = new Set(BLOCK_TAGS.map(norm));
const CSR_SET = new Set(CSR_ONLY_TAGS.map(norm));

type Customer = { customerId?: number; customerName?: string; active?: boolean };
type Job = { jobId?: number; status?: string; createdOn?: string; completedOn?: string | null; modifiedOn?: string };
type TagsResult = { customers?: { customerId?: number; tags?: string[]; locations?: { tags?: string[]; address?: string }[] }[] };
type JobTagsResult = { jobs?: { jobId?: number; tags?: string[] }[] };

// Tests swap the MCP call.
let reader: (name: string, args: Record<string, unknown>) => Promise<unknown> = (name, args) => callTextingReadTool(name, args);
export function setStReaderForTests(fn: typeof reader | null) {
  reader = fn ?? ((name, args) => callTextingReadTool(name, args));
}

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "?");

/** Run the full check for one phone (+1XXXXXXXXXX). Never throws. */
export async function checkServiceTitan(phone: string, now: Date): Promise<StCheck> {
  const checkedAt = now.toISOString();
  const reasons: string[] = [];
  let csrOnly = false;
  try {
    const digits = phone.replace(/^\+1/, "");
    const found = (await reader("search_customers", { query: digits, searchType: "phone" })) as { customers?: Customer[] };
    const customers = (found?.customers || [])
      .filter((c) => c.customerId && !INTERNAL_RECORD.test(c.customerName || ""))
      .slice(0, 3);
    if (!customers.length) return { ok: true, blocked: false, csrOnly: false, reasons: [], customers: [], checkedAt };

    const ids = customers.map((c) => c.customerId as number);
    const tags = (await reader("get_customer_tags", { customerIds: ids, includeLocations: true })) as TagsResult;
    for (const c of tags?.customers || []) {
      const all = [...(c.tags || []), ...(c.locations || []).flatMap((l) => l.tags || [])];
      for (const t of all) {
        if (BLOCK_SET.has(norm(t))) reasons.push(`Tag: ${t}`);
        if (CSR_SET.has(norm(t))) csrOnly = true;
      }
    }

    const recentJobIds: number[] = [];
    const canceledDays: string[] = [];
    const cutoffCanceled = now.getTime() - CANCELED_DAYS * 24 * 60 * 60 * 1000;
    const cutoffTags = now.getTime() - 2 * 365 * 24 * 60 * 60 * 1000;
    for (const id of ids) {
      const jobs = ((await reader("get_customer_jobs", { customerId: id, pageSize: 50 })) as { jobs?: Job[] })?.jobs || [];
      for (const job of jobs) {
        const status = norm(job.status || "").replace(/\s/g, "");
        if (OPEN_JOB_STATUSES.includes(status)) reasons.push(`Open job (${job.status}) created ${day(job.createdOn)}`);
        if (status === "canceled" || status === "cancelled") {
          const when = Date.parse(job.modifiedOn || job.completedOn || job.createdOn || "") || 0;
          if (when >= cutoffCanceled) canceledDays.push(day(job.modifiedOn || job.completedOn || job.createdOn));
        }
        const created = Date.parse(job.createdOn || "") || 0;
        if (job.jobId && created >= cutoffTags && recentJobIds.length < 50) recentJobIds.push(job.jobId);
      }
    }
    if (canceledDays.length) {
      // One line, newest first: "Job canceled 2026-11-02 (+5 more in the last 90 days)".
      canceledDays.sort().reverse();
      const more = canceledDays.length - 1;
      reasons.push(`Job canceled ${canceledDays[0]}${more ? ` (+${more} more in the last ${CANCELED_DAYS} days)` : ""}`);
    }
    if (recentJobIds.length) {
      const jobTags = (await reader("get_job_tags", { jobIds: recentJobIds })) as JobTagsResult;
      for (const j of jobTags?.jobs || []) {
        for (const t of j.tags || []) {
          if (BLOCK_SET.has(norm(t))) reasons.push(`Job tag: ${t} (job ${j.jobId})`);
          if (CSR_SET.has(norm(t))) csrOnly = true;
        }
      }
    }
    const unique = [...new Set(reasons)].slice(0, 8);
    return {
      ok: true,
      blocked: unique.length > 0,
      csrOnly,
      reasons: unique,
      customers: customers.map((c) => ({ id: c.customerId as number, name: String(c.customerName || "").slice(0, 80) })),
      checkedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("ServiceTitan exclusion check failed:", message.slice(0, 300));
    return { ok: false, blocked: true, csrOnly: false, reasons: ["ServiceTitan check failed"], customers: [], error: message.slice(0, 200), checkedAt };
  }
}

/** A saved check, if it's still fresh enough to reuse. */
export function freshCheck(saved: unknown, now: Date): StCheck | null {
  if (!saved || typeof saved !== "object") return null;
  const c = saved as StCheck;
  if (!c.ok || !c.checkedAt) return null;
  return now.getTime() - Date.parse(c.checkedAt) < ST_CHECK_TTL_MS ? c : null;
}

/** One line for the inbox / Slack: "Tag: No Drip!; Open job (Scheduled)…" */
export function stCheckSummary(c: StCheck): string {
  if (!c.ok) return "ServiceTitan check failed, will retry";
  if (!c.blocked) return c.customers.length ? "ServiceTitan: OK to auto-text" : "Not in ServiceTitan yet (new lead)";
  return `ServiceTitan: ${c.reasons.join("; ")}`;
}

// ---------------------------------------------------------------------------
// Saved result per conversation (sms_conversations.st_check, reused 12 hours)
// ---------------------------------------------------------------------------

export type SavedStCheck = { check: StCheck; bypass: boolean };

/**
 * The ServiceTitan result for this phone: the saved one while it's fresh, else a
 * new check (saved). bypass = an owner's test number skips the exclusions.
 */
export async function stCheckFor(phone: string, now: Date): Promise<SavedStCheck> {
  const sql = await smsDb();
  const rows = await sql`SELECT id, st_check, st_test_bypass FROM sms_conversations WHERE phone = ${phone}`;
  const row = rows[0];
  const bypass = row?.st_test_bypass === true;
  const fresh = freshCheck(row?.st_check, now);
  if (fresh) return { check: fresh, bypass };
  const check = await checkServiceTitan(phone, now);
  if (row) {
    await sql`UPDATE sms_conversations SET st_check = ${JSON.stringify(check)}::jsonb, st_checked_at = ${check.checkedAt}::timestamptz,
        updated_at = now() WHERE id = ${row.id}`;
  }
  return { check, bypass };
}

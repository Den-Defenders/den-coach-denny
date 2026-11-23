import { neon } from "@neondatabase/serverless";
import { parseOwnerReport, type OwnerReport } from "@/lib/ownerReport";
import initialReport from "@/data/owner-dashboard-report.json";
import { DEFAULT_REDLINE, DEFAULT_TARGET_DATE, addDays, parseRedlineSnapshot, type RedlineSnapshot } from "@/lib/ownerRedline";
import { assembleRedline, findDepartures, pacificDay, type JobInfo, type NightlyCutoff, type SnapshotJob } from "@/lib/ownerRedlineLive";

function sqlClient() {
  const url = process.env.OWNER_DATABASE_URL || process.env.OWNER_DATABASE_DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

async function ensureTable(sql: NonNullable<ReturnType<typeof sqlClient>>) {
  await sql`CREATE TABLE IF NOT EXISTS owner_dashboard_reports (
    id BIGSERIAL PRIMARY KEY,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    imported_by TEXT NOT NULL,
    source TEXT NOT NULL,
    report JSONB NOT NULL
  )`;
}

async function generatedReport(sql: NonNullable<ReturnType<typeof sqlClient>>): Promise<OwnerReport | null> {
  // The collector creates this table during its one-time bootstrap. Keep the
  // bundled report usable until that setup has completed.
  const exists = await sql`SELECT to_regclass('public.owner_generated_report') AS table_name`;
  if (!exists[0]?.table_name) return null;
  const rows = await sql`SELECT payload FROM owner_generated_report ORDER BY generated_at DESC LIMIT 1`;
  if (!rows.length) return null;
  return parseOwnerReport(JSON.parse(String(rows[0].payload)));
}

export async function latestOwnerReport(): Promise<OwnerReport | null> {
  const sql = sqlClient();
  if (!sql) return parseOwnerReport(initialReport);
  await ensureTable(sql);
  const rows = await sql`SELECT report FROM owner_dashboard_reports ORDER BY id DESC LIMIT 1`;
  const imported = rows.length ? parseOwnerReport(rows[0].report) : null;
  const generated = await generatedReport(sql);
  if (generated && (!imported || Date.parse(generated.generatedAt) > Date.parse(imported.generatedAt))) {
    return generated;
  }
  return imported || parseOwnerReport(initialReport);
}

export async function saveOwnerReport(report: OwnerReport, importedBy: string) {
  const sql = sqlClient();
  if (!sql) throw new Error("Owner reporting database is not configured.");
  await ensureTable(sql);
  await sql`INSERT INTO owner_dashboard_reports (imported_by, source, report)
    VALUES (${importedBy}, ${report.source}, ${JSON.stringify(report)}::jsonb)`;
}

// Feb 1 redline tracker: one row per imported Monday snapshot. Nothing is ever
// overwritten; a re-import for the same Monday becomes the displayed version.
async function ensureRedlineTable(sql: NonNullable<ReturnType<typeof sqlClient>>) {
  await sql`CREATE TABLE IF NOT EXISTS owner_redline_snapshots (
    id BIGSERIAL PRIMARY KEY,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    imported_by TEXT NOT NULL,
    snapshot_date DATE NOT NULL,
    snapshot JSONB NOT NULL
  )`;
}

export async function latestRedlineSnapshot(): Promise<RedlineSnapshot | null> {
  const sql = sqlClient();
  if (!sql) return null;
  await ensureRedlineTable(sql);
  const rows = await sql`SELECT snapshot FROM owner_redline_snapshots ORDER BY snapshot_date DESC, id DESC LIMIT 1`;
  return rows.length ? parseRedlineSnapshot(rows[0].snapshot) : null;
}

export async function saveRedlineSnapshot(snapshot: RedlineSnapshot, importedBy: string) {
  const sql = sqlClient();
  if (!sql) throw new Error("Owner reporting database is not configured.");
  await ensureRedlineTable(sql);
  await sql`INSERT INTO owner_redline_snapshots (imported_by, snapshot_date, snapshot)
    VALUES (${importedBy}, ${snapshot.snapshotDate}, ${JSON.stringify(snapshot)}::jsonb)`;
}

// ---------------------------------------------------------------------------
// Live redline: built every time from the collector's nightly snapshots, so it
// updates on its own after the 12:10 AM PT run. Cached per newest snapshot.
let liveCache: { key: string; snapshot: RedlineSnapshot } | null = null;

export async function liveRedlineSnapshot(): Promise<RedlineSnapshot | null> {
  const sql = sqlClient();
  if (!sql) return null;
  const exists = await sql`SELECT to_regclass('public.owner_snapshot_manifest') AS table_name`;
  if (!exists[0]?.table_name) return null;

  const newest = await sql`SELECT cutoff_utc FROM owner_snapshot_manifest ORDER BY cutoff_utc DESC LIMIT 1`;
  if (!newest.length) return null;
  const latestDay = pacificDay(String(newest[0].cutoff_utc).replace(/(\.\d{3})\d+/, "$1"));
  const since = new Date(Date.parse(`${addDays(latestDay, -70)}T00:00:00Z`)).toISOString();

  const manifest = await sql`SELECT cutoff_utc, revision, on_time, summary FROM owner_snapshot_manifest
    WHERE cutoff_utc >= ${since} ORDER BY cutoff_utc, revision`;
  // Same rule as the collector's best_snapshots(): newest revision, but a late
  // revision never displaces an on-time capture.
  const best = new Map<string, { revision: number; onTime: boolean; summary: Record<string, unknown> }>();
  for (const m of manifest) {
    const cur = best.get(String(m.cutoff_utc));
    const onTime = Boolean(Number(m.on_time));
    if (!cur || !cur.onTime || onTime) {
      best.set(String(m.cutoff_utc), { revision: Number(m.revision), onTime,
        summary: typeof m.summary === "string" ? JSON.parse(m.summary || "{}") : (m.summary || {}) });
    }
  }
  const key = [...best.entries()].map(([c, b]) => `${c}:${b.revision}`).join("|") + `|${DEFAULT_REDLINE}|${DEFAULT_TARGET_DATE}`;
  if (liveCache?.key === key) return liveCache.snapshot;

  const rows = await sql`SELECT cutoff_utc, revision, job_id,
      payload::jsonb->>'bucket' AS bucket,
      payload::jsonb->>'job_value' AS job_value,
      payload::jsonb->>'next_install_utc' AS next_install
    FROM owner_snapshot_job WHERE cutoff_utc >= ${since}`;
  const cutoffs = new Map<string, NightlyCutoff>();
  for (const [cutoff, b] of best) {
    const daily = (b.summary.daily || {}) as Record<string, unknown>;
    if (typeof daily.all_open !== "number") continue;
    cutoffs.set(cutoff, {
      day: pacificDay(cutoff.replace(/(\.\d{3})\d+/, "$1")),
      allOpen: daily.all_open,
      hold: typeof daily.hold_r === "number" ? daily.hold_r : null,
      onTime: b.onTime,
      jobs: new Map<string, SnapshotJob>(),
    });
  }
  for (const r of rows) {
    const c = cutoffs.get(String(r.cutoff_utc));
    if (!c || best.get(String(r.cutoff_utc))?.revision !== Number(r.revision)) continue;
    const value = r.job_value === null || r.job_value === undefined ? null : Number(r.job_value);
    c.jobs.set(String(r.job_id), { bucket: String(r.bucket || ""), value: Number.isFinite(value) ? value : null,
      next: r.next_install ? String(r.next_install) : null });
  }
  const ordered = [...cutoffs.values()].sort((a, b) => a.day.localeCompare(b.day));
  if (!ordered.length) return null;

  const latest = ordered.at(-1)!;
  const ids = new Set<string>(findDepartures(ordered).map((d) => d.jobId));
  for (const c of ordered.filter((x) => x.day >= addDays(latest.day, -31))) {
    for (const [id, job] of c.jobs) if (job.bucket === "Active") ids.add(id);
  }
  const jobInfo = new Map<string, JobInfo>();
  if (ids.size) {
    const info = await sql`SELECT id, payload::jsonb->>'status' AS status, payload::jsonb->>'bu_name' AS bu_name
      FROM owner_st_record WHERE entity = 'job' AND id = ANY(${[...ids]})`;
    for (const r of info) jobInfo.set(String(r.id), { status: r.status ? String(r.status) : null, buName: r.bu_name ? String(r.bu_name) : null });
  }

  const report = await latestOwnerReport();
  const dailySales = new Map<string, number | null>();
  for (const row of [...(report?.daily || []), ...(report?.dailyRolling || [])]) {
    if (row.quality !== "forecast" && !dailySales.has(row.date)) dailySales.set(row.date, row.sales);
  }

  const snapshot = assembleRedline({
    cutoffs: ordered, jobInfo, dailySales, generatedAt: new Date().toISOString(),
    redline: DEFAULT_REDLINE, targetDate: DEFAULT_TARGET_DATE,
  });
  liveCache = { key, snapshot };
  return snapshot;
}

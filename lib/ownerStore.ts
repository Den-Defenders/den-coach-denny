import { neon } from "@neondatabase/serverless";
import { parseOwnerReport, type OwnerReport } from "@/lib/ownerReport";
import initialReport from "@/data/owner-dashboard-report.json";

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

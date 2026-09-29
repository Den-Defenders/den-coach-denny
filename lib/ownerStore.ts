import { neon } from "@neondatabase/serverless";
import { parseOwnerReport, type OwnerReport } from "@/lib/ownerReport";
import initialReport from "@/data/owner-dashboard-report.json";

function sqlClient() {
  const url = process.env.OWNER_DATABASE_URL;
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

export async function latestOwnerReport(): Promise<OwnerReport | null> {
  const sql = sqlClient();
  if (!sql) return parseOwnerReport(initialReport);
  await ensureTable(sql);
  const rows = await sql`SELECT report FROM owner_dashboard_reports ORDER BY id DESC LIMIT 1`;
  return rows.length ? parseOwnerReport(rows[0].report) : parseOwnerReport(initialReport);
}

export async function saveOwnerReport(report: OwnerReport, importedBy: string) {
  const sql = sqlClient();
  if (!sql) throw new Error("OWNER_DATABASE_URL is not configured.");
  await ensureTable(sql);
  await sql`INSERT INTO owner_dashboard_reports (imported_by, source, report)
    VALUES (${importedBy}, ${report.source}, ${JSON.stringify(report)}::jsonb)`;
}

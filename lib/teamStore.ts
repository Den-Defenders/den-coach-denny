/**
 * lib/teamStore.ts
 *
 * Neon storage for Den Coach Denny team members: who is a CSR, sales rep,
 * installer or owner, and which ServiceTitan technician each login belongs to.
 *
 * Login itself stays in Auth0. This table only answers "what is this signed-in
 * email allowed to do, and who are they in ServiceTitan?".
 */
import { neon } from "@neondatabase/serverless";

export const TEAM_ROLES = ["owner", "csr", "sales_rep", "installer"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const TEAM_TIME_ZONES = [
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Denver",
  "America/Chicago",
] as const;
export type TeamTimeZone = (typeof TEAM_TIME_ZONES)[number];

export type TeamMember = {
  email: string;
  displayName: string;
  role: TeamRole;
  stTechnicianId: number | null;
  stTechnicianName: string | null;
  timeZone: TeamTimeZone;
  active: boolean;
  updatedAt: string;
  updatedBy: string;
};

export type TeamMemberInput = {
  email: string;
  displayName: string;
  role: TeamRole;
  stTechnicianId: number | null;
  stTechnicianName: string | null;
  timeZone: TeamTimeZone;
  active: boolean;
};

type SqlClient = ReturnType<typeof neon>;

function databaseUrl(): string | null {
  return (
    process.env.TEAM_DATABASE_URL ||
    process.env.OWNER_DATABASE_URL ||
    process.env.OWNER_DATABASE_DATABASE_URL ||
    null
  );
}

export function teamDatabaseConfigured(): boolean {
  return Boolean(databaseUrl());
}

function sqlClient(): SqlClient {
  const url = databaseUrl();
  if (!url) throw new Error("Team database is not configured.");
  return neon(url);
}

let tableReady: Promise<void> | null = null;

async function ensureTable(sql: SqlClient) {
  if (!tableReady) {
    tableReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS den_team_members (
        email TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'csr', 'sales_rep', 'installer')),
        st_technician_id BIGINT,
        st_technician_name TEXT,
        time_zone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by TEXT NOT NULL
      )`;
    })().catch((error) => {
      tableReady = null;
      throw error;
    });
  }
  await tableReady;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === "string" && (TEAM_ROLES as readonly string[]).includes(value);
}

export function isTeamTimeZone(value: unknown): value is TeamTimeZone {
  return typeof value === "string" && (TEAM_TIME_ZONES as readonly string[]).includes(value);
}

function rowToMember(row: Record<string, unknown>): TeamMember {
  const role = isTeamRole(row.role) ? row.role : "csr";
  const timeZone = isTeamTimeZone(row.time_zone) ? row.time_zone : "America/Los_Angeles";
  const techId = row.st_technician_id === null || row.st_technician_id === undefined
    ? null
    : Number(row.st_technician_id);
  return {
    email: String(row.email),
    displayName: String(row.display_name),
    role,
    stTechnicianId: techId !== null && Number.isFinite(techId) ? techId : null,
    stTechnicianName: row.st_technician_name ? String(row.st_technician_name) : null,
    timeZone,
    active: row.active === true,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? ""),
    updatedBy: String(row.updated_by ?? ""),
  };
}

export async function findTeamMember(email: string): Promise<TeamMember | null> {
  const sql = sqlClient();
  await ensureTable(sql);
  const rows = (await sql`SELECT * FROM den_team_members WHERE email = ${normalizeEmail(email)} LIMIT 1`) as Record<string, unknown>[];
  return rows.length ? rowToMember(rows[0]) : null;
}

export async function listTeamMembers(): Promise<TeamMember[]> {
  const sql = sqlClient();
  await ensureTable(sql);
  const rows = (await sql`SELECT * FROM den_team_members ORDER BY active DESC, role, display_name`) as Record<string, unknown>[];
  return rows.map(rowToMember);
}

export async function saveTeamMember(input: TeamMemberInput, updatedBy: string): Promise<TeamMember> {
  const sql = sqlClient();
  await ensureTable(sql);
  const rows = (await sql`INSERT INTO den_team_members
      (email, display_name, role, st_technician_id, st_technician_name, time_zone, active, updated_by)
    VALUES
      (${normalizeEmail(input.email)}, ${input.displayName.trim()}, ${input.role},
       ${input.stTechnicianId}, ${input.stTechnicianName}, ${input.timeZone}, ${input.active}, ${updatedBy})
    ON CONFLICT (email) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      role = EXCLUDED.role,
      st_technician_id = EXCLUDED.st_technician_id,
      st_technician_name = EXCLUDED.st_technician_name,
      time_zone = EXCLUDED.time_zone,
      active = EXCLUDED.active,
      updated_at = now(),
      updated_by = EXCLUDED.updated_by
    RETURNING *`) as Record<string, unknown>[];
  return rowToMember(rows[0]);
}

// ---------------------------------------------------------------------------
// Single-use confirmations for voice job notes
// ---------------------------------------------------------------------------

let confirmTableReady: Promise<void> | null = null;

/**
 * Marks a note confirmation as used. Returns true the first time, false if it
 * was already used (so a repeated "yes" can never write the note twice).
 */
export async function claimNoteConfirmation(nonce: string, email: string, jobId: number): Promise<boolean> {
  const sql = sqlClient();
  if (!confirmTableReady) {
    confirmTableReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS den_voice_note_confirmations (
        nonce TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        job_id BIGINT NOT NULL,
        used_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    })().catch((error) => {
      confirmTableReady = null;
      throw error;
    });
  }
  await confirmTableReady;
  const rows = (await sql`INSERT INTO den_voice_note_confirmations (nonce, email, job_id)
    VALUES (${nonce}, ${normalizeEmail(email)}, ${jobId})
    ON CONFLICT (nonce) DO NOTHING
    RETURNING nonce`) as Record<string, unknown>[];
  // Housekeeping: confirmations only live 5 minutes, so old rows are useless.
  await sql`DELETE FROM den_voice_note_confirmations WHERE used_at < now() - interval '7 days'`;
  return rows.length === 1;
}

/**
 * lib/sms/store.ts
 *
 * Neon storage for texting. Tables are created automatically the first time
 * they're needed (same pattern as lib/teamStore.ts):
 *
 *   sms_contacts       one row per phone number (time zone for sending hours)
 *   sms_conversations  one conversation per phone number (re-submits join it)
 *   sms_messages       every text in and out, with Twilio status
 *   sms_opt_outs       numbers that said STOP (blocks every send)
 *   sms_consent        what consent we have, its source and timestamp
 *   sms_audit          guardrail log: every send, block, opt-out and opt-in
 *
 * Uses SMS_DATABASE_URL if set, otherwise the same Neon database as the Team page.
 */
import { neon } from "@neondatabase/serverless";
import { DEFAULT_TIME_ZONE, safeTimeZone } from "@/lib/sms/rules";

type Row = Record<string, unknown>;
export type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>;

function databaseUrl(): string | null {
  return (
    process.env.SMS_DATABASE_URL ||
    process.env.TEAM_DATABASE_URL ||
    process.env.OWNER_DATABASE_URL ||
    process.env.OWNER_DATABASE_DATABASE_URL ||
    null
  );
}

export function smsDatabaseConfigured(): boolean {
  return Boolean(testSql || databaseUrl());
}

let testSql: Sql | null = null;
let cachedSql: Sql | null = null;

/** Tests only: run the store against another Postgres. */
export function setSqlForTests(sql: Sql | null) {
  testSql = sql;
  schemaReady = null;
}

function sqlClient(): Sql {
  if (testSql) return testSql;
  if (cachedSql) return cachedSql;
  const url = databaseUrl();
  if (!url) throw new Error("Texting database is not configured (set SMS_DATABASE_URL or the Team database URL).");
  const client = neon(url);
  cachedSql = (strings, ...values) => client(strings, ...values) as Promise<Row[]>;
  return cachedSql;
}

let schemaReady: Promise<void> | null = null;

async function db(): Promise<Sql> {
  const sql = sqlClient();
  if (!schemaReady) {
    schemaReady = createTables(sql).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
  return sql;
}

async function createTables(sql: Sql) {
  await sql`CREATE TABLE IF NOT EXISTS sms_contacts (
    phone TEXT PRIMARY KEY,
    first_name TEXT,
    last_name TEXT,
    time_zone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS sms_conversations (
    id BIGSERIAL PRIMARY KEY,
    phone TEXT NOT NULL UNIQUE REFERENCES sms_contacts(phone),
    status TEXT NOT NULL DEFAULT 'open',
    last_inbound_at TIMESTAMPTZ,
    last_outbound_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS sms_messages (
    id BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES sms_conversations(id),
    phone TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    kind TEXT,
    purpose TEXT,
    body TEXT NOT NULL DEFAULT '',
    media JSONB,
    twilio_sid TEXT UNIQUE,
    our_number TEXT,
    status TEXT NOT NULL,
    error_code TEXT,
    error_message TEXT,
    sent_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS sms_messages_phone_created ON sms_messages (phone, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS sms_messages_out_created ON sms_messages (created_at DESC) WHERE direction = 'outbound'`;
  await sql`CREATE TABLE IF NOT EXISTS sms_opt_outs (
    phone TEXT PRIMARY KEY,
    opted_out_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    source TEXT NOT NULL,
    keyword TEXT
  )`;
  await sql`CREATE TABLE IF NOT EXISTS sms_consent (
    id BIGSERIAL PRIMARY KEY,
    phone TEXT NOT NULL,
    consent_type TEXT NOT NULL CHECK (consent_type IN ('conversational', 'care', 'marketing')),
    source TEXT NOT NULL,
    evidence TEXT,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
  )`;
  await sql`CREATE INDEX IF NOT EXISTS sms_consent_phone ON sms_consent (phone)`;
  await sql`CREATE TABLE IF NOT EXISTS sms_audit (
    id BIGSERIAL PRIMARY KEY,
    phone TEXT,
    action TEXT NOT NULL,
    reason TEXT,
    detail JSONB,
    actor TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS sms_audit_created ON sms_audit (created_at DESC)`;
}

const iso = (d: Date) => d.toISOString();
const toIso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());

// ---------------------------------------------------------------------------
// Contacts and conversations
// ---------------------------------------------------------------------------

export type SmsContact = { phone: string; timeZone: string; conversationId: number; lastInboundAt: string | null };

/** Make sure the phone has a contact + its single conversation. */
export async function ensureContact(phone: string): Promise<SmsContact> {
  const sql = await db();
  await sql`INSERT INTO sms_contacts (phone) VALUES (${phone}) ON CONFLICT (phone) DO NOTHING`;
  await sql`INSERT INTO sms_conversations (phone) VALUES (${phone}) ON CONFLICT (phone) DO NOTHING`;
  const rows = await sql`SELECT c.phone, c.time_zone, v.id AS conversation_id, v.last_inbound_at
    FROM sms_contacts c JOIN sms_conversations v ON v.phone = c.phone WHERE c.phone = ${phone}`;
  const row = rows[0];
  return {
    phone,
    timeZone: safeTimeZone(String(row?.time_zone || DEFAULT_TIME_ZONE)),
    conversationId: Number(row?.conversation_id),
    lastInboundAt: toIso(row?.last_inbound_at),
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type InboundInput = {
  phone: string;
  ourNumber: string | null;
  body: string;
  twilioSid: string;
  media: string[];
  at: Date;
};

/** Save a text they sent us. Returns false when Twilio retried a text we already have. */
export async function saveInbound(input: InboundInput): Promise<{ saved: boolean; contact: SmsContact }> {
  const contact = await ensureContact(input.phone);
  const sql = await db();
  const media = input.media.length ? JSON.stringify(input.media) : null;
  const rows = await sql`INSERT INTO sms_messages
      (conversation_id, phone, direction, body, media, twilio_sid, our_number, status, created_at, updated_at)
    VALUES (${contact.conversationId}, ${input.phone}, 'inbound', ${input.body}, ${media}::jsonb,
      ${input.twilioSid}, ${input.ourNumber}, 'received', ${iso(input.at)}::timestamptz, ${iso(input.at)}::timestamptz)
    ON CONFLICT (twilio_sid) DO NOTHING
    RETURNING id`;
  if (!rows.length) return { saved: false, contact };
  await sql`UPDATE sms_conversations SET last_inbound_at = ${iso(input.at)}::timestamptz, updated_at = now()
    WHERE id = ${contact.conversationId}`;
  return { saved: true, contact: { ...contact, lastInboundAt: iso(input.at) } };
}

export type OutboundInput = {
  conversationId: number;
  phone: string;
  body: string;
  kind: string;
  purpose: string;
  sentBy: string;
  at: Date;
};

/** Record the text before calling Twilio, so a crash can't hide a send. */
export async function createOutbound(input: OutboundInput): Promise<number> {
  const sql = await db();
  const rows = await sql`INSERT INTO sms_messages
      (conversation_id, phone, direction, kind, purpose, body, status, sent_by, created_at, updated_at)
    VALUES (${input.conversationId}, ${input.phone}, 'outbound', ${input.kind}, ${input.purpose}, ${input.body},
      'pending', ${input.sentBy}, ${iso(input.at)}::timestamptz, ${iso(input.at)}::timestamptz)
    RETURNING id`;
  await sql`UPDATE sms_conversations SET last_outbound_at = ${iso(input.at)}::timestamptz, updated_at = now()
    WHERE id = ${input.conversationId}`;
  return Number(rows[0].id);
}

export async function markOutboundAccepted(id: number, twilioSid: string, status: string, ourNumber: string | null) {
  const sql = await db();
  await sql`UPDATE sms_messages SET twilio_sid = ${twilioSid}, status = ${status}, our_number = ${ourNumber}, updated_at = now()
    WHERE id = ${id}`;
}

export async function markOutboundFailed(id: number, errorCode: string | null, errorMessage: string) {
  const sql = await db();
  await sql`UPDATE sms_messages SET status = 'send_failed', error_code = ${errorCode}, error_message = ${errorMessage.slice(0, 500)}, updated_at = now()
    WHERE id = ${id}`;
}

/** Twilio status callbacks can arrive out of order; only move a status forward. */
const STATUS_RANK: Record<string, number> = {
  pending: 0, accepted: 1, scheduled: 1, queued: 2, sending: 3, sent: 4,
  delivered: 5, undelivered: 5, failed: 5, canceled: 5, read: 6, send_failed: 9,
};

export async function applyStatusCallback(input: { twilioSid: string; status: string; errorCode: string | null; errorMessage: string | null }):
  Promise<{ updated: boolean; phone: string | null }> {
  const sql = await db();
  const rows = await sql`SELECT id, phone, status FROM sms_messages WHERE twilio_sid = ${input.twilioSid} AND direction = 'outbound'`;
  if (!rows.length) return { updated: false, phone: null };
  const current = String(rows[0].status);
  const next = input.status.toLowerCase();
  const phone = String(rows[0].phone);
  if ((STATUS_RANK[next] ?? 0) <= (STATUS_RANK[current] ?? 0)) return { updated: false, phone };
  const updated = await sql`UPDATE sms_messages SET status = ${next},
      error_code = COALESCE(${input.errorCode}, error_code),
      error_message = COALESCE(${input.errorMessage}, error_message),
      updated_at = now()
    WHERE id = ${rows[0].id} AND status = ${current}
    RETURNING id`;
  return { updated: updated.length > 0, phone };
}

/** Texts we sent (or tried to) to one number since a time. */
export async function countOutboundTo(phone: string, since: Date, kind?: string): Promise<number> {
  const sql = await db();
  const rows = kind
    ? await sql`SELECT count(*)::int AS n FROM sms_messages WHERE direction = 'outbound' AND phone = ${phone}
        AND kind = ${kind} AND status <> 'send_failed' AND created_at >= ${iso(since)}::timestamptz`
    : await sql`SELECT count(*)::int AS n FROM sms_messages WHERE direction = 'outbound' AND phone = ${phone}
        AND status <> 'send_failed' AND created_at >= ${iso(since)}::timestamptz`;
  return Number(rows[0]?.n || 0);
}

/** Texts we sent to everyone since a time (system-wide daily cap). */
export async function countOutboundAll(since: Date): Promise<number> {
  const sql = await db();
  const rows = await sql`SELECT count(*)::int AS n FROM sms_messages WHERE direction = 'outbound'
    AND status <> 'send_failed' AND created_at >= ${iso(since)}::timestamptz`;
  return Number(rows[0]?.n || 0);
}

// ---------------------------------------------------------------------------
// Opt-outs and consent
// ---------------------------------------------------------------------------

export type OptOut = { phone: string; optedOutAt: string; source: string; keyword: string | null };

export async function findOptOut(phone: string): Promise<OptOut | null> {
  const sql = await db();
  const rows = await sql`SELECT phone, opted_out_at, source, keyword FROM sms_opt_outs WHERE phone = ${phone}`;
  if (!rows.length) return null;
  return { phone, optedOutAt: toIso(rows[0].opted_out_at) || "", source: String(rows[0].source), keyword: (rows[0].keyword as string) ?? null };
}

/** STOP: block the number and revoke all consent. Safe to call twice. */
export async function recordOptOut(phone: string, source: string, keyword: string | null, at: Date) {
  const sql = await db();
  await sql`INSERT INTO sms_opt_outs (phone, opted_out_at, source, keyword)
    VALUES (${phone}, ${iso(at)}::timestamptz, ${source}, ${keyword})
    ON CONFLICT (phone) DO NOTHING`;
  await sql`UPDATE sms_consent SET revoked_at = ${iso(at)}::timestamptz WHERE phone = ${phone} AND revoked_at IS NULL`;
}

/** START: unblock the number (old consent stays revoked). */
export async function clearOptOut(phone: string) {
  const sql = await db();
  await sql`DELETE FROM sms_opt_outs WHERE phone = ${phone}`;
}

export type ConsentType = "conversational" | "care" | "marketing";

/** Add consent unless the same kind is already active. */
export async function addConsent(phone: string, type: ConsentType, source: string, evidence: string | null, at: Date): Promise<boolean> {
  const sql = await db();
  const existing = await sql`SELECT id FROM sms_consent WHERE phone = ${phone} AND consent_type = ${type} AND revoked_at IS NULL LIMIT 1`;
  if (existing.length) return false;
  await sql`INSERT INTO sms_consent (phone, consent_type, source, evidence, captured_at)
    VALUES (${phone}, ${type}, ${source}, ${evidence ? evidence.slice(0, 1000) : null}, ${iso(at)}::timestamptz)`;
  return true;
}

export async function activeConsentTypes(phone: string): Promise<ConsentType[]> {
  const sql = await db();
  const rows = await sql`SELECT DISTINCT consent_type FROM sms_consent WHERE phone = ${phone} AND revoked_at IS NULL`;
  return rows.map((r) => String(r.consent_type) as ConsentType);
}

/** Did we already send the opt-out confirmation for this opt-out? */
export async function optOutConfirmationSent(phone: string, since: Date): Promise<boolean> {
  const sql = await db();
  const rows = await sql`SELECT 1 FROM sms_messages WHERE direction = 'outbound' AND phone = ${phone}
    AND kind = 'opt_out_confirmation' AND created_at >= ${iso(since)}::timestamptz LIMIT 1`;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export async function audit(entry: { phone: string | null; action: string; reason?: string | null; detail?: Record<string, unknown> | null; actor?: string | null }) {
  try {
    const sql = await db();
    await sql`INSERT INTO sms_audit (phone, action, reason, detail, actor)
      VALUES (${entry.phone}, ${entry.action}, ${entry.reason ?? null},
        ${entry.detail ? JSON.stringify(entry.detail) : null}::jsonb, ${entry.actor ?? null})`;
  } catch (error) {
    // The audit log must never be the reason a STOP isn't saved or a webhook fails.
    console.error("SMS audit write failed:", error instanceof Error ? error.message : error);
  }
}

// ---------------------------------------------------------------------------
// Owner test page
// ---------------------------------------------------------------------------

export async function recentActivity(limit = 50) {
  const sql = await db();
  const messages = await sql`SELECT id, phone, direction, kind, purpose, body, media, status, error_code, error_message, sent_by, created_at
    FROM sms_messages ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
  const optOuts = await sql`SELECT phone, opted_out_at, source, keyword FROM sms_opt_outs ORDER BY opted_out_at DESC LIMIT ${limit}`;
  const auditRows = await sql`SELECT id, phone, action, reason, detail, actor, created_at FROM sms_audit ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
  return {
    messages: messages.map((m) => ({ ...m, created_at: toIso(m.created_at) })),
    optOuts: optOuts.map((o) => ({ ...o, opted_out_at: toIso(o.opted_out_at) })),
    audit: auditRows.map((a) => ({ ...a, created_at: toIso(a.created_at) })),
  };
}

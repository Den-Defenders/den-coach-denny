/**
 * lib/sms/store.ts
 *
 * Neon storage for texting. Tables are created automatically the first time
 * they're needed (same pattern as lib/teamStore.ts):
 *
 *   sms_contacts       one row per phone number (time zone for sending hours)
 *   sms_conversations  one conversation per phone number (re-submits join it),
 *                      plus the bot switch for that number ("on" or "paused" after a handoff)
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

/** The texting database (tables created on first use). Also used by the Simulator's tables. */
export function smsDb(): Promise<Sql> {
  return db();
}

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
  // Step 2 (bot replies): bot on/paused per conversation, handoff reason, lead outcome.
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS bot_status TEXT NOT NULL DEFAULT 'on'`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS handoff_reason TEXT`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS handoff_summary TEXT`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS handoff_at TIMESTAMPTZ`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS lead_status TEXT`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS lead_status_at TIMESTAMPTZ`;
  // Step 2b (shared brain): what this customer already told us, so the bot never re-asks.
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS customer_notes JSONB`;
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

/** Save a text they sent us. saved=false when Twilio retried a text we already have. */
export async function saveInbound(input: InboundInput): Promise<{ saved: boolean; messageId: number | null; contact: SmsContact }> {
  const contact = await ensureContact(input.phone);
  const sql = await db();
  const media = input.media.length ? JSON.stringify(input.media) : null;
  const rows = await sql`INSERT INTO sms_messages
      (conversation_id, phone, direction, body, media, twilio_sid, our_number, status, created_at, updated_at)
    VALUES (${contact.conversationId}, ${input.phone}, 'inbound', ${input.body}, ${media}::jsonb,
      ${input.twilioSid}, ${input.ourNumber}, 'received', ${iso(input.at)}::timestamptz, ${iso(input.at)}::timestamptz)
    ON CONFLICT (twilio_sid) DO NOTHING
    RETURNING id`;
  if (!rows.length) return { saved: false, messageId: null, contact };
  await sql`UPDATE sms_conversations SET last_inbound_at = ${iso(input.at)}::timestamptz, updated_at = now()
    WHERE id = ${contact.conversationId}`;
  return { saved: true, messageId: Number(rows[0].id), contact: { ...contact, lastInboundAt: iso(input.at) } };
}

export type OutboundInput = {
  conversationId: number;
  phone: string;
  body: string;
  kind: string;
  purpose: string;
  sentBy: string;
  at: Date;
  /** Picture links sent with the text (MMS). */
  media?: string[];
};

/** Record the text before calling Twilio, so a crash can't hide a send. */
export async function createOutbound(input: OutboundInput): Promise<number> {
  const sql = await db();
  const rows = await sql`INSERT INTO sms_messages
      (conversation_id, phone, direction, kind, purpose, body, media, status, sent_by, created_at, updated_at)
    VALUES (${input.conversationId}, ${input.phone}, 'outbound', ${input.kind}, ${input.purpose}, ${input.body},
      ${input.media?.length ? JSON.stringify(input.media) : null}::jsonb,
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

/** Did we already send this kind of confirmation (opt-out / opt-in) since a time? */
export async function confirmationSent(phone: string, kind: "opt_out_confirmation" | "opt_in_confirmation", since: Date): Promise<boolean> {
  const sql = await db();
  const rows = await sql`SELECT 1 FROM sms_messages WHERE direction = 'outbound' AND phone = ${phone}
    AND kind = ${kind} AND status <> 'send_failed' AND created_at >= ${iso(since)}::timestamptz LIMIT 1`;
  return rows.length > 0;
}

/** Did we already send the opt-out confirmation for this opt-out? */
export function optOutConfirmationSent(phone: string, since: Date): Promise<boolean> {
  return confirmationSent(phone, "opt_out_confirmation", since);
}

/**
 * Twilio just blocked a number that was already opted out in Denny only
 * ("please stop texting me"). Mark the opt-out as Twilio-known, so a later
 * START (which Twilio then confirms itself) doesn't get a second confirmation.
 */
export async function markOptOutKnownToTwilio(phone: string) {
  const sql = await db();
  await sql`UPDATE sms_opt_outs SET source = 'keyword' WHERE phone = ${phone} AND source IN ('keyword_extra', 'ai_detected')`;
}

// ---------------------------------------------------------------------------
// Bot state (step 2)
// ---------------------------------------------------------------------------

export type BotStatus = "on" | "paused";
export type LeadStatus = "price_accepted" | "not_interested";

export type ConversationState = {
  conversationId: number;
  botStatus: BotStatus;
  handoffReason: string | null;
  leadStatus: LeadStatus | null;
  customerNotes: Record<string, string>;
};

function notesFrom(value: unknown): Record<string, string> {
  let obj: unknown = value;
  if (typeof obj === "string") {
    try { obj = JSON.parse(obj); } catch { obj = null; }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

export async function conversationState(phone: string): Promise<ConversationState> {
  const contact = await ensureContact(phone);
  const sql = await db();
  const rows = await sql`SELECT bot_status, handoff_reason, lead_status, customer_notes FROM sms_conversations WHERE id = ${contact.conversationId}`;
  const row = rows[0] || {};
  return {
    conversationId: contact.conversationId,
    botStatus: row.bot_status === "paused" ? "paused" : "on",
    handoffReason: (row.handoff_reason as string) ?? null,
    leadStatus: (row.lead_status as LeadStatus) ?? null,
    customerNotes: notesFrom(row.customer_notes),
  };
}

/** Merge new details into the customer's notes (empty values never wipe a saved one). */
export async function saveCustomerNotes(phone: string, notes: Record<string, string>) {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(notes)) {
    const value = String(v ?? "").trim();
    if (value) clean[k.slice(0, 40)] = value.slice(0, 200);
  }
  if (!Object.keys(clean).length) return;
  const contact = await ensureContact(phone);
  const sql = await db();
  await sql`UPDATE sms_conversations SET customer_notes = COALESCE(customer_notes, '{}'::jsonb) || ${JSON.stringify(clean)}::jsonb,
      updated_at = now()
    WHERE id = ${contact.conversationId}`;
}

/** Bot stops answering this number; the team takes over. */
export async function setHandoff(phone: string, reason: string, summary: string, at: Date) {
  const contact = await ensureContact(phone);
  const sql = await db();
  await sql`UPDATE sms_conversations SET bot_status = 'paused', handoff_reason = ${reason.slice(0, 60)},
      handoff_summary = ${summary.slice(0, 1500)}, handoff_at = ${iso(at)}::timestamptz, updated_at = now()
    WHERE id = ${contact.conversationId}`;
}

/** Owner turned the bot back on for this number (test page). */
export async function resumeBot(phone: string): Promise<boolean> {
  const sql = await db();
  const rows = await sql`UPDATE sms_conversations SET bot_status = 'on', handoff_reason = NULL, handoff_summary = NULL,
      handoff_at = NULL, updated_at = now()
    WHERE phone = ${phone} RETURNING id`;
  return rows.length > 0;
}

export async function setLeadStatus(phone: string, status: LeadStatus, at: Date) {
  const contact = await ensureContact(phone);
  const sql = await db();
  await sql`UPDATE sms_conversations SET lead_status = ${status}, lead_status_at = ${iso(at)}::timestamptz, updated_at = now()
    WHERE id = ${contact.conversationId}`;
}

export type ThreadMessage = { id: number; direction: "inbound" | "outbound"; body: string; mediaCount: number; createdAt: string };

/** The latest texts with this number, oldest first (what the bot reads before replying). */
export async function threadForBot(phone: string, limit = 40): Promise<ThreadMessage[]> {
  const sql = await db();
  const rows = await sql`SELECT id, direction, body, media, created_at FROM sms_messages
    WHERE phone = ${phone} AND status <> 'send_failed'
    ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
  return rows.reverse().map((r) => ({
    id: Number(r.id),
    direction: r.direction === "outbound" ? "outbound" : "inbound",
    body: String(r.body || ""),
    mediaCount: Array.isArray(r.media) ? r.media.length : 0,
    createdAt: toIso(r.created_at) || "",
  }));
}

/** Id of the newest text they sent us (the bot only answers the newest one). */
export async function latestInboundId(phone: string): Promise<number | null> {
  const sql = await db();
  const rows = await sql`SELECT id FROM sms_messages WHERE phone = ${phone} AND direction = 'inbound'
    ORDER BY created_at DESC, id DESC LIMIT 1`;
  return rows.length ? Number(rows[0].id) : null;
}

/** Was anything sent to this number after a given text of theirs? */
export async function outboundSinceMessage(phone: string, messageId: number): Promise<boolean> {
  const sql = await db();
  const rows = await sql`SELECT 1 FROM sms_messages WHERE phone = ${phone} AND direction = 'outbound'
    AND status <> 'send_failed' AND id > ${messageId} LIMIT 1`;
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
  const handoffs = await sql`SELECT phone, handoff_reason, handoff_summary, handoff_at, lead_status FROM sms_conversations
    WHERE bot_status = 'paused' ORDER BY handoff_at DESC NULLS LAST LIMIT ${limit}`;
  return {
    messages: messages.map((m) => ({ ...m, created_at: toIso(m.created_at) })),
    optOuts: optOuts.map((o) => ({ ...o, opted_out_at: toIso(o.opted_out_at) })),
    audit: auditRows.map((a) => ({ ...a, created_at: toIso(a.created_at) })),
    handoffs: handoffs.map((h) => ({ ...h, handoff_at: toIso(h.handoff_at) })),
  };
}

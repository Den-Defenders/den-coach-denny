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
  // Step 3 (Texting inbox): when a person last marked this conversation handled (clears "Needs CSR" up to then).
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS handoff_resolved_at TIMESTAMPTZ`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS handoff_resolved_by TEXT`;
  // Who owns this customer in the inbox (a team member's login email), set by "Take it" or their first reply.
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS assigned_to TEXT`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ`;
  // Step 4a: the open time the customer picked by text ("📅 Ready to book") and when a CSR booked it in ServiceTitan.
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS booking_request JSONB`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS booking_done_at TIMESTAMPTZ`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS booking_done_by TEXT`;
  // Step 5 (Zapier leads + drip): the lead form, the drip's progress, and the ServiceTitan exclusion check.
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS lead_at TIMESTAMPTZ`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS lead_info JSONB`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS lead_count INT NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS drip_status TEXT`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS drip_step INT`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS drip_next_at TIMESTAMPTZ`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS drip_day1 TEXT`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS drip_started_at TIMESTAMPTZ`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS drip_last_sent_at TIMESTAMPTZ`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS drip_stop_reason TEXT`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS drip_stopped_at TIMESTAMPTZ`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS drip_stopped_by TEXT`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS drip_restart_ok BOOLEAN NOT NULL DEFAULT false`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS st_check JSONB`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS st_checked_at TIMESTAMPTZ`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS st_test_bypass BOOLEAN NOT NULL DEFAULT false`;
  await sql`CREATE INDEX IF NOT EXISTS sms_conversations_drip_due ON sms_conversations (drip_next_at) WHERE drip_status = 'active'`;
  // Step 5 PR 3: AI follow-ups when the AI is left on read ("Stop auto texts" turns them off for good).
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS followups_off BOOLEAN NOT NULL DEFAULT false`;
  await sql`ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS followup_lock_until TIMESTAMPTZ`;
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
  await sql`UPDATE sms_opt_outs SET source = 'keyword' WHERE phone = ${phone} AND source IN ('keyword_extra', 'ai_detected', 'hatch_import')`;
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
  /** A person already handled the "Needs CSR" flag (or took over from the inbox). */
  handoffResolved: boolean;
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
  const rows = await sql`SELECT bot_status, handoff_reason, handoff_resolved_at, lead_status, customer_notes FROM sms_conversations WHERE id = ${contact.conversationId}`;
  const row = rows[0] || {};
  return {
    conversationId: contact.conversationId,
    botStatus: row.bot_status === "paused" ? "paused" : "on",
    handoffReason: (row.handoff_reason as string) ?? null,
    handoffResolved: row.handoff_resolved_at != null,
    leadStatus: (row.lead_status as LeadStatus) ?? null,
    customerNotes: notesFrom(row.customer_notes),
  };
}

/**
 * Merge new details into the customer's notes (empty values never wipe a saved one).
 * Code-only "_" keys (offered times, the picked time) may be longer than the AI's notes.
 */
export async function saveCustomerNotes(phone: string, notes: Record<string, string>) {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(notes)) {
    const value = String(v ?? "").trim();
    if (value) clean[k.slice(0, 40)] = value.slice(0, k.startsWith("_") ? 1500 : 200);
  }
  if (!Object.keys(clean).length) return;
  const contact = await ensureContact(phone);
  const sql = await db();
  await sql`UPDATE sms_conversations SET customer_notes = COALESCE(customer_notes, '{}'::jsonb) || ${JSON.stringify(clean)}::jsonb,
      updated_at = now()
    WHERE id = ${contact.conversationId}`;
}

/** Bot stops answering this number; the team takes over. */
/**
 * keepAi (step 4a): a "wants to book, no time picked yet" flag. The team sees it in
 * Needs CSR, but the AI keeps answering, so a customer who then says "ok, Tuesday works"
 * still gets times. A person's reply pauses the AI as usual.
 */
export async function setHandoff(phone: string, reason: string, summary: string, at: Date, options: { keepAi?: boolean } = {}) {
  const contact = await ensureContact(phone);
  const sql = await db();
  const botStatus = options.keepAi ? "on" : "paused";
  await sql`UPDATE sms_conversations SET bot_status = ${botStatus}, handoff_reason = ${reason.slice(0, 60)},
      handoff_summary = ${summary.slice(0, 1500)}, handoff_at = ${iso(at)}::timestamptz,
      handoff_resolved_at = NULL, handoff_resolved_by = NULL, updated_at = now()
    WHERE id = ${contact.conversationId}`;
}

/**
 * Step 4a: the customer picked a real open time. Stored as JSON (lib/sms/booking.ts
 * BookingRequest); a new request replaces the old one and clears "booked".
 */
export async function saveBookingRequest(phone: string, booking: object) {
  const contact = await ensureContact(phone);
  const sql = await db();
  await sql`UPDATE sms_conversations SET booking_request = ${JSON.stringify(booking)}::jsonb,
      booking_done_at = NULL, booking_done_by = NULL, updated_at = now()
    WHERE id = ${contact.conversationId}`;
}

/** A CSR clicked "Booked in ServiceTitan". */
export async function markBookingDone(phone: string, by: string, at: Date): Promise<boolean> {
  const sql = await db();
  const rows = await sql`UPDATE sms_conversations SET booking_done_at = ${iso(at)}::timestamptz,
      booking_done_by = ${by.slice(0, 120)}, updated_at = now()
    WHERE phone = ${phone} AND booking_request IS NOT NULL RETURNING id`;
  return rows.length > 0;
}

/** Save the name the customer texted, unless someone already named this contact. */
export async function nameContactIfEmpty(phone: string, fullName: string) {
  const [first, ...rest] = fullName.replace(/\s+/g, " ").trim().split(" ");
  if (!first) return;
  const sql = await db();
  await sql`UPDATE sms_contacts SET first_name = ${first.slice(0, 60)}, last_name = ${rest.join(" ").slice(0, 60) || null},
      updated_at = now()
    WHERE phone = ${phone} AND coalesce(first_name, '') = '' AND coalesce(last_name, '') = ''`;
}

/** A person turned the bot back on for this number (inbox or test page). */
export async function resumeBot(phone: string): Promise<boolean> {
  const sql = await db();
  const rows = await sql`UPDATE sms_conversations SET bot_status = 'on', handoff_reason = NULL, handoff_summary = NULL,
      handoff_at = NULL, handoff_resolved_at = NULL, handoff_resolved_by = NULL, updated_at = now()
    WHERE phone = ${phone} RETURNING id`;
  return rows.length > 0;
}

/** Clear an old outcome (step 4a: a customer who picks a consultation time is interested again). */
export async function clearLeadStatus(phone: string) {
  const sql = await db();
  await sql`UPDATE sms_conversations SET lead_status = NULL, lead_status_at = NULL, updated_at = now()
    WHERE phone = ${phone} AND lead_status IS NOT NULL`;
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

/**
 * Was anything sent to this number after a given text of theirs? The AI's own
 * "checking our calendar" text (step 4a) answers nothing, so it doesn't count.
 */
export async function outboundSinceMessage(phone: string, messageId: number): Promise<boolean> {
  const sql = await db();
  const rows = await sql`SELECT 1 FROM sms_messages WHERE phone = ${phone} AND direction = 'outbound'
    AND status <> 'send_failed' AND coalesce(sent_by, '') <> ${CHECKING_SENDER} AND id > ${messageId} LIMIT 1`;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Texting inbox (step 3): conversation list, one thread, CSR actions
// ---------------------------------------------------------------------------

/**
 * sent_by of the automatic "a team member will get back to you" text. It answers
 * nothing, so it never counts as a reply: the customer still shows as waiting.
 */
export const HOLD_SENDER = "denny-hold";

/** sent_by of the AI's "checking our calendar now" text (step 4a). It answers nothing either. */
export const CHECKING_SENDER = "denny-checking";

export type InboxRow = {
  phone: string;
  firstName: string | null;
  lastName: string | null;
  botStatus: BotStatus;
  handoffReason: string | null;
  handoffSummary: string | null;
  handoffAt: string | null;
  handoffResolvedAt: string | null;
  leadStatus: string | null;
  assignedTo: string | null;
  bookingRequest: unknown;
  bookingDoneAt: string | null;
  /** Step 5: when their lead form came in, and the drip's state (null = no drip). */
  leadAt: string | null;
  dripStatus: string | null;
  optedOut: boolean;
  lastDirection: "inbound" | "outbound";
  lastBody: string;
  lastMediaCount: number;
  lastSentBy: string | null;
  lastStatus: string;
  lastAt: string;
};

const mediaList = (value: unknown): string[] => {
  let v: unknown = value;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { v = null; }
  }
  return Array.isArray(v) ? v.filter((u): u is string => typeof u === "string") : [];
};

/** Turn what a person typed in the search box into LIKE patterns (text and digits). */
function searchPatterns(search: string | undefined): { text: string | null; digits: string | null } {
  const raw = (search || "").trim().slice(0, 60);
  if (!raw) return { text: null, digits: null };
  const escaped = raw.replace(/[\\%_]/g, (c) => `\\${c}`);
  const digits = raw.replace(/\D/g, "");
  return { text: `%${escaped}%`, digits: digits.length >= 3 ? `%${digits.replace(/^1(?=\d{10}$)/, "")}%` : null };
}

/**
 * Conversations for the inbox, newest activity first. Open "Needs CSR" handoffs
 * always come first so they never fall off the list. Conversations with no
 * texts at all are left out. Optional search: name, phone digits or message text.
 */
export async function listInboxConversations(options: { search?: string; limit?: number } = {}): Promise<InboxRow[]> {
  const sql = await db();
  const limit = Math.min(Math.max(options.limit ?? 300, 1), 500);
  const { text, digits } = searchPatterns(options.search);
  const rows = await sql`SELECT v.phone, v.bot_status, v.handoff_reason, v.handoff_summary, v.handoff_at, v.handoff_resolved_at,
      v.lead_status, v.assigned_to, v.booking_request, v.booking_done_at, v.lead_at, v.drip_status,
      c.first_name, c.last_name, (o.phone IS NOT NULL) AS opted_out,
      m.direction AS last_direction, m.body AS last_body, m.media AS last_media, m.sent_by AS last_sent_by,
      m.status AS last_status, m.created_at AS last_at
    FROM sms_conversations v
    JOIN sms_contacts c ON c.phone = v.phone
    LEFT JOIN sms_opt_outs o ON o.phone = v.phone
    LEFT JOIN LATERAL (
      SELECT direction, body, media, sent_by, status, created_at FROM sms_messages
      WHERE conversation_id = v.id AND status <> 'send_failed' AND coalesce(sent_by, '') NOT IN (${HOLD_SENDER}, ${CHECKING_SENDER})
      ORDER BY created_at DESC, id DESC LIMIT 1
    ) m ON true
    WHERE (m.created_at IS NOT NULL OR v.lead_at IS NOT NULL)
      AND (${text}::text IS NULL
        OR v.phone LIKE ${digits}::text
        OR (coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) ILIKE ${text}::text
        OR EXISTS (SELECT 1 FROM sms_messages s WHERE s.conversation_id = v.id AND s.body ILIKE ${text}::text))
    ORDER BY (v.bot_status = 'paused' AND v.handoff_reason = 'ready_to_book' AND v.handoff_resolved_at IS NULL
        AND v.booking_request IS NOT NULL AND v.booking_done_at IS NULL) DESC,
      (v.handoff_reason IS NOT NULL AND v.handoff_resolved_at IS NULL) DESC,
      coalesce(m.created_at, v.lead_at) DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({
    phone: String(r.phone),
    firstName: (r.first_name as string) || null,
    lastName: (r.last_name as string) || null,
    botStatus: r.bot_status === "paused" ? "paused" : "on",
    handoffReason: (r.handoff_reason as string) ?? null,
    handoffSummary: (r.handoff_summary as string) ?? null,
    handoffAt: toIso(r.handoff_at),
    handoffResolvedAt: toIso(r.handoff_resolved_at),
    leadStatus: (r.lead_status as string) ?? null,
    assignedTo: (r.assigned_to as string) ?? null,
    bookingRequest: r.booking_request ?? null,
    bookingDoneAt: toIso(r.booking_done_at),
    leadAt: toIso(r.lead_at),
    dripStatus: (r.drip_status as string) ?? null,
    optedOut: r.opted_out === true,
    // A lead with no texts yet shows as an outbound "New lead" row (nothing to answer).
    lastDirection: r.last_at == null || r.last_direction === "outbound" ? "outbound" : "inbound",
    lastBody: r.last_at == null ? "New lead from a form (no texts yet)" : String(r.last_body || ""),
    lastMediaCount: mediaList(r.last_media).length,
    lastSentBy: r.last_at == null ? "system" : (r.last_sent_by as string) ?? null,
    lastStatus: String(r.last_status || ""),
    lastAt: toIso(r.last_at) || toIso(r.lead_at) || "",
  }));
}

export type InboxMessage = {
  id: number;
  direction: "inbound" | "outbound";
  body: string;
  media: string[];
  kind: string | null;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  sentBy: string | null;
  createdAt: string;
};

export type InboxThread = {
  phone: string;
  firstName: string | null;
  lastName: string | null;
  timeZone: string;
  botStatus: BotStatus;
  handoffReason: string | null;
  handoffSummary: string | null;
  handoffAt: string | null;
  handoffResolvedAt: string | null;
  handoffResolvedBy: string | null;
  leadStatus: string | null;
  assignedTo: string | null;
  assignedAt: string | null;
  bookingRequest: unknown;
  bookingDoneAt: string | null;
  bookingDoneBy: string | null;
  customerNotes: Record<string, string>;
  optOut: OptOut | null;
  consent: ConsentType[];
  /** Step 5: the newest lead form and the drip. */
  lead: {
    at: string | null;
    count: number;
    info: Record<string, unknown> | null;
    drip: {
      status: string | null;
      step: number | null;
      nextAt: string | null;
      startedAt: string | null;
      lastSentAt: string | null;
      stopReason: string | null;
      stoppedAt: string | null;
      stoppedBy: string | null;
    };
    stCheck: unknown;
    stCheckedAt: string | null;
  };
  messages: InboxMessage[];
};

/** One conversation for the inbox (latest texts, oldest first). Null when we've never texted with this number. */
export async function inboxThread(phone: string, limit = 200): Promise<InboxThread | null> {
  const sql = await db();
  const rows = await sql`SELECT v.id, v.bot_status, v.handoff_reason, v.handoff_summary, v.handoff_at, v.handoff_resolved_at,
      v.handoff_resolved_by, v.lead_status, v.assigned_to, v.assigned_at, v.booking_request, v.booking_done_at, v.booking_done_by,
      v.customer_notes, v.lead_at, v.lead_count, v.lead_info, v.drip_status, v.drip_step, v.drip_next_at, v.drip_started_at,
      v.drip_last_sent_at, v.drip_stop_reason, v.drip_stopped_at, v.drip_stopped_by, v.st_check, v.st_checked_at,
      c.first_name, c.last_name, c.time_zone
    FROM sms_conversations v JOIN sms_contacts c ON c.phone = v.phone WHERE v.phone = ${phone}`;
  if (!rows.length) return null;
  const v = rows[0];
  const messages = await sql`SELECT id, direction, body, media, kind, status, error_code, error_message, sent_by, created_at
    FROM sms_messages WHERE conversation_id = ${v.id}
    ORDER BY created_at DESC, id DESC LIMIT ${Math.min(Math.max(limit, 1), 500)}`;
  return {
    phone,
    firstName: (v.first_name as string) || null,
    lastName: (v.last_name as string) || null,
    timeZone: safeTimeZone(String(v.time_zone || DEFAULT_TIME_ZONE)),
    botStatus: v.bot_status === "paused" ? "paused" : "on",
    handoffReason: (v.handoff_reason as string) ?? null,
    handoffSummary: (v.handoff_summary as string) ?? null,
    handoffAt: toIso(v.handoff_at),
    handoffResolvedAt: toIso(v.handoff_resolved_at),
    handoffResolvedBy: (v.handoff_resolved_by as string) ?? null,
    leadStatus: (v.lead_status as string) ?? null,
    assignedTo: (v.assigned_to as string) ?? null,
    assignedAt: toIso(v.assigned_at),
    bookingRequest: v.booking_request ?? null,
    bookingDoneAt: toIso(v.booking_done_at),
    bookingDoneBy: (v.booking_done_by as string) ?? null,
    customerNotes: notesFrom(v.customer_notes),
    optOut: await findOptOut(phone),
    consent: await activeConsentTypes(phone),
    lead: {
      at: toIso(v.lead_at),
      count: Number(v.lead_count || 0),
      info: (v.lead_info as Record<string, unknown>) ?? null,
      drip: {
        status: (v.drip_status as string) ?? null,
        step: v.drip_step == null ? null : Number(v.drip_step),
        nextAt: toIso(v.drip_next_at),
        startedAt: toIso(v.drip_started_at),
        lastSentAt: toIso(v.drip_last_sent_at),
        stopReason: (v.drip_stop_reason as string) ?? null,
        stoppedAt: toIso(v.drip_stopped_at),
        stoppedBy: (v.drip_stopped_by as string) ?? null,
      },
      stCheck: v.st_check ?? null,
      stCheckedAt: toIso(v.st_checked_at),
    },
    messages: messages.reverse().map((m) => ({
      id: Number(m.id),
      direction: m.direction === "outbound" ? "outbound" : "inbound",
      body: String(m.body || ""),
      media: mediaList(m.media),
      kind: (m.kind as string) ?? null,
      status: String(m.status || ""),
      errorCode: (m.error_code as string) ?? null,
      errorMessage: (m.error_message as string) ?? null,
      sentBy: (m.sent_by as string) ?? null,
      createdAt: toIso(m.created_at) || "",
    })),
  };
}

/**
 * A person marked the conversation handled: clears the "Needs CSR" flag and any
 * "waiting" texts up to now. The AI's on/paused switch is not changed. A new
 * text from the customer after this time shows up as waiting again.
 */
export async function markHandoffHandled(phone: string, by: string, at: Date): Promise<boolean> {
  const sql = await db();
  const rows = await sql`UPDATE sms_conversations SET handoff_resolved_at = ${iso(at)}::timestamptz,
      handoff_resolved_by = ${by.slice(0, 120)}, updated_at = now()
    WHERE phone = ${phone} RETURNING id`;
  return rows.length > 0;
}

/**
 * A person is texting this customer: the AI stops answering this number and any
 * open "Needs CSR" flag counts as handled. Keeps the AI's handoff reason if there was one.
 */
export async function takeOverConversation(phone: string, by: string, at: Date) {
  const contact = await ensureContact(phone);
  const sql = await db();
  await sql`UPDATE sms_conversations SET bot_status = 'paused',
      handoff_reason = COALESCE(handoff_reason, 'csr_took_over'),
      handoff_at = COALESCE(handoff_at, ${iso(at)}::timestamptz),
      handoff_resolved_at = ${iso(at)}::timestamptz, handoff_resolved_by = ${by.slice(0, 120)},
      assigned_at = CASE WHEN assigned_to IS NULL THEN ${iso(at)}::timestamptz ELSE assigned_at END,
      assigned_to = COALESCE(assigned_to, ${by.slice(0, 120)}),
      updated_at = now()
    WHERE id = ${contact.conversationId}`;
}

/** Give this customer to a team member (email), or null to put them back in the shared queue. */
export async function assignConversation(phone: string, to: string | null, at: Date): Promise<boolean> {
  const sql = await db();
  const rows = await sql`UPDATE sms_conversations SET assigned_to = ${to ? to.slice(0, 120) : null},
      assigned_at = ${to ? iso(at) : null}::timestamptz, updated_at = now()
    WHERE phone = ${phone} RETURNING id`;
  return rows.length > 0;
}

/** Who owns this customer in the inbox (null = nobody yet). */
export async function conversationAssignee(phone: string): Promise<string | null> {
  const sql = await db();
  const rows = await sql`SELECT assigned_to FROM sms_conversations WHERE phone = ${phone}`;
  return rows.length ? ((rows[0].assigned_to as string) ?? null) : null;
}

/** Name a CSR typed for this number (we only know phone numbers until lead intake exists). */
export async function setContactName(phone: string, firstName: string | null, lastName: string | null): Promise<boolean> {
  const sql = await db();
  const rows = await sql`UPDATE sms_contacts SET first_name = ${firstName ? firstName.slice(0, 60) : null},
      last_name = ${lastName ? lastName.slice(0, 60) : null}, updated_at = now()
    WHERE phone = ${phone} RETURNING phone`;
  return rows.length > 0;
}

/** Twilio's link for a photo a customer texted us (needs the Twilio login to open). */
export async function inboundMediaUrl(messageId: number, index: number): Promise<string | null> {
  const sql = await db();
  const rows = await sql`SELECT media FROM sms_messages WHERE id = ${messageId} AND direction = 'inbound'`;
  if (!rows.length) return null;
  return mediaList(rows[0].media)[index] ?? null;
}

/** Direction of the text just before this one (to alert only on the first unanswered text). Hold texts don't count. */
export async function previousMessageDirection(phone: string, messageId: number): Promise<"inbound" | "outbound" | null> {
  const sql = await db();
  const rows = await sql`SELECT direction FROM sms_messages WHERE phone = ${phone} AND id < ${messageId}
    AND status <> 'send_failed' AND coalesce(sent_by, '') <> ${HOLD_SENDER} ORDER BY id DESC LIMIT 1`;
  if (!rows.length) return null;
  return rows[0].direction === "outbound" ? "outbound" : "inbound";
}

/** The newest text we sent this number (hold texts included): who sent it and when. */
export async function lastOutbound(phone: string): Promise<{ sentBy: string | null; createdAt: string } | null> {
  const sql = await db();
  const rows = await sql`SELECT sent_by, created_at FROM sms_messages WHERE phone = ${phone} AND direction = 'outbound'
    AND status <> 'send_failed' ORDER BY created_at DESC, id DESC LIMIT 1`;
  if (!rows.length) return null;
  return { sentBy: (rows[0].sent_by as string) ?? null, createdAt: toIso(rows[0].created_at) || "" };
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

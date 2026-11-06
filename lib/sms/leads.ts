/**
 * lib/sms/leads.ts
 *
 * Lead intake from Zapier (POST /api/leads), build step 5.
 *
 *   sms_leads   one row per form submission Zapier sends us (raw payload + the
 *               fields we understood), newest first on /sms-test
 *
 * Modes (Vercel env SMS_LEADS_MODE):
 *   log_only (default)  save + show the lead, NO texts, no conversation
 *   live                one conversation per phone (a re-submit joins it, never
 *                       restarts), consent saved, lead shown in the Texting inbox,
 *                       and the drip starts (lib/sms/drip.ts) when there's consent
 *                       and SMS_DRIP_ENABLED=true
 *
 * Consent (Steven, 2026-11-03): Facebook lead forms have carried SMS consent for
 * years, so a Facebook lead counts as form consent ("care") unless the payload
 * says sms_consent = no. Sources: SMS_CONSENT_SOURCES (default facebook, fb,
 * instagram, ig, meta). Other sources: the lead shows in the inbox, no auto texts.
 *
 * The secret: Vercel env SMS_LEADS_SECRET. Zapier sends it in the
 * X-Denny-Secret header (or "Authorization: Bearer <secret>").
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { normalizePhone } from "@/lib/sms/rules";
import { addConsent, audit, ensureContact, saveCustomerNotes, setContactName, setHandoff, smsDb } from "@/lib/sms/store";

/** Largest request we accept (a lead form is a few hundred bytes). */
export const MAX_LEAD_BYTES = 20_000;

export type LeadsMode = "log_only" | "live";

export function leadsMode(): LeadsMode {
  return (process.env.SMS_LEADS_MODE || "").trim().toLowerCase() === "live" ? "live" : "log_only";
}

export function leadsSecretConfigured(): boolean {
  return (process.env.SMS_LEADS_SECRET || "").trim().length >= 24;
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** True when the request carries the right secret. Constant-time compare. */
export function leadsSecretMatches(headers: Headers): boolean {
  const secret = (process.env.SMS_LEADS_SECRET || "").trim();
  if (secret.length < 24) return false;
  const bearer = (headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const given = (headers.get("x-denny-secret") || bearer || "").trim();
  if (!given) return false;
  return timingSafeEqual(digest(given), digest(secret));
}

// ---------------------------------------------------------------------------
// Reading the payload
// ---------------------------------------------------------------------------

export type LeadFields = {
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  phoneAsSent: string | null;
  zip: string | null;
  email: string | null;
  leadSource: string | null;
  campaignName: string | null;
  adName: string | null;
  /** Session 6 PR 3 (Melanie's Zap, Nov 4): the ServiceTitan campaign to book under (static "Facebook Lead Form"). */
  crmCampaignName: string | null;
  /** Facebook or Instagram. */
  platform: string | null;
  adSet: string | null;
  /** "free consultation" or "questions first", as sent. */
  inquiryTypeAsSent: string | null;
  inquiryType: InquiryType;
  formName: string | null;
  submittedAt: string | null;
  submittedAtAsSent: string | null;
  smsConsent: "yes" | "no" | "not_sent";
  smsConsentAsSent: string | null;
  consentText: string | null;
  projectInterest: string | null;
  bestTime: string | null;
  /** Fields we didn't recognise, exactly as sent (so Melanie can rename them). */
  other: Record<string, string>;
};

export type InquiryType = "free_consultation" | "questions_first" | null;

export type ParsedLead = { fields: LeadFields; raw: Record<string, string>; missing: string[]; warnings: string[] };

/** The keys we ask Melanie to use, plus common spellings Zapier/Facebook use. Matched without case, spaces or _. */
const ALIASES: Record<keyof Omit<LeadFields, "other" | "phone" | "submittedAt" | "smsConsent" | "inquiryType">, string[]> = {
  firstName: ["firstname", "first", "fname", "contactfirstname", "givenname"],
  lastName: ["lastname", "last", "lname", "contactlastname", "surname", "familyname"],
  phoneAsSent: ["phone", "phonenumber", "mobile", "mobilephone", "mobilenumber", "cell", "cellphone", "contactphone"],
  zip: ["zip", "zipcode", "postalcode", "postcode", "zippostalcode"],
  email: ["email", "emailaddress", "contactemail"],
  leadSource: ["leadsource", "source"],
  campaignName: ["campaignname", "campaign", "adcampaign", "adcampaignname"],
  adName: ["adname", "ad"],
  crmCampaignName: ["crmcampaignname", "crmcampaign", "stcampaign", "stcampaignname", "servicetitancampaign"],
  platform: ["platform", "socialplatform", "adplatform"],
  adSet: ["adset", "adsetname", "adgroup", "adgroupname"],
  inquiryTypeAsSent: ["inquirytype", "inquiry", "leadtype", "requesttype"],
  formName: ["formname", "form", "leadformname"],
  submittedAtAsSent: ["submittedat", "submittime", "submittedtime", "createdtime", "created", "createdat", "timestamp", "datesubmitted"],
  smsConsentAsSent: ["smsconsent", "consent", "smsoptin", "textconsent", "textoptin", "smsagree", "agreetotexts"],
  consentText: ["consenttext", "consentwording", "disclaimer", "disclaimertext"],
  projectInterest: ["projectinterest", "interest", "project", "product", "whatareyouinterestedin"],
  bestTime: ["besttime", "besttimetoreach", "besttimetocall", "besttimetocontact"],
};
const FULL_NAME_KEYS = ["fullname", "name", "contactname"];

const keyOf = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Flatten nested JSON ({a:{b:1}} -> "a.b": "1"); arrays join with ", ". */
function flatten(value: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (value === null || value === undefined) {
    if (prefix) out[prefix] = "";
  } else if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== "object")) out[prefix || "value"] = value.map((v) => String(v ?? "")).join(", ");
    else value.forEach((v, i) => flatten(v, prefix ? `${prefix}.${i}` : String(i), out));
  } else if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out[prefix] = String(value);
  }
  return out;
}

/** JSON (Zapier's default) or form-encoded body -> flat key/value list. */
export function readLeadBody(text: string, contentType: string): Record<string, string> | null {
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (contentType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const data = JSON.parse(trimmed) as unknown;
      // "Wrap request in array" = yes in Zapier sends [ {...} ].
      const first = Array.isArray(data) && data.length === 1 && data[0] && typeof data[0] === "object" ? data[0] : data;
      return typeof first === "object" && first !== null ? flatten(first) : null;
    } catch {
      return null;
    }
  }
  const params = new URLSearchParams(trimmed);
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = out[k] ? `${out[k]}, ${v}` : v;
  return out;
}

const YES = new Set(["yes", "y", "true", "1", "on", "checked", "agree", "agreed", "iagree", "accepted", "accept", "optin", "optedin"]);
const NO = new Set(["no", "n", "false", "0", "off", "unchecked", "disagree", "declined", "optout"]);

/** "Yes", "true", "1", "checked", "I agree" -> yes; "No", "false", "0" -> no; blank -> not sent. Anything else -> no (we never guess consent). */
export function readConsent(value: string | null): "yes" | "no" | "not_sent" {
  if (value === null || !value.trim()) return "not_sent";
  const key = keyOf(value);
  if (YES.has(key) || /^(yes|iagree|iconsent|agree)/.test(key)) return "yes";
  if (NO.has(key)) return "no";
  return "no";
}

/** Facebook "2026-11-02T17:05:12+0000", ISO, US "11/2/2026 9:05 AM" or Unix seconds/ms -> ISO. Null when unreadable. */
export function readSubmitTime(value: string | null): string | null {
  if (!value || !value.trim()) return null;
  const v = value.trim();
  if (/^\d{10}$/.test(v)) return new Date(Number(v) * 1000).toISOString();
  if (/^\d{13}$/.test(v)) return new Date(Number(v)).toISOString();
  const fixed = v.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(fixed);
  if (!Number.isFinite(ms)) return null;
  const year = new Date(ms).getUTCFullYear();
  return year >= 2020 && year <= 2100 ? new Date(ms).toISOString() : null;
}

const clean = (v: string | undefined | null, max = 200): string | null => {
  if (v === undefined || v === null) return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

export function parseLead(raw: Record<string, string>): ParsedLead {
  const used = new Set<string>();
  const byKey = new Map<string, string>();
  for (const k of Object.keys(raw)) {
    const nk = keyOf(k.split(".").pop() || k);
    if (!byKey.has(nk)) byKey.set(nk, k);
  }
  const pick = (aliases: string[]): string | null => {
    for (const a of aliases) {
      const original = byKey.get(a);
      if (original !== undefined) {
        used.add(original);
        return raw[original];
      }
    }
    return null;
  };

  const fields: LeadFields = {
    firstName: clean(pick(ALIASES.firstName), 80),
    lastName: clean(pick(ALIASES.lastName), 80),
    phoneAsSent: clean(pick(ALIASES.phoneAsSent), 40),
    phone: null,
    zip: null,
    email: clean(pick(ALIASES.email), 160),
    leadSource: clean(pick(ALIASES.leadSource), 120),
    campaignName: clean(pick(ALIASES.campaignName), 200),
    adName: clean(pick(ALIASES.adName), 200),
    crmCampaignName: clean(pick(ALIASES.crmCampaignName), 120),
    platform: clean(pick(ALIASES.platform), 60),
    adSet: clean(pick(ALIASES.adSet), 200),
    inquiryTypeAsSent: clean(pick(ALIASES.inquiryTypeAsSent), 120),
    inquiryType: null,
    formName: clean(pick(ALIASES.formName), 200),
    submittedAtAsSent: clean(pick(ALIASES.submittedAtAsSent), 60),
    submittedAt: null,
    smsConsentAsSent: clean(pick(ALIASES.smsConsentAsSent), 200),
    smsConsent: "not_sent",
    consentText: clean(pick(ALIASES.consentText), 1000),
    projectInterest: clean(pick(ALIASES.projectInterest), 300),
    bestTime: clean(pick(ALIASES.bestTime), 120),
    other: {},
  };
  const zipAsSent = clean(pick(ALIASES.zip), 20);
  const fullName = clean(pick(FULL_NAME_KEYS), 160);
  if (fullName && !fields.firstName && !fields.lastName) {
    const parts = fullName.split(" ");
    fields.firstName = parts[0] || null;
    fields.lastName = parts.slice(1).join(" ") || null;
  }

  const warnings: string[] = [];
  fields.phone = normalizePhone(fields.phoneAsSent ?? undefined);
  if (fields.phoneAsSent && !fields.phone) warnings.push(`Phone "${fields.phoneAsSent}" isn't a US mobile number we can text.`);
  const zipMatch = zipAsSent?.match(/\b(\d{5})(?:-\d{4})?\b/);
  fields.zip = zipMatch ? zipMatch[1] : null;
  if (zipAsSent && !fields.zip) warnings.push(`ZIP "${zipAsSent}" isn't a 5-digit ZIP code.`);
  fields.submittedAt = readSubmitTime(fields.submittedAtAsSent);
  if (fields.submittedAtAsSent && !fields.submittedAt) warnings.push(`Submit time "${fields.submittedAtAsSent}" couldn't be read (we'll use the time it arrived).`);
  fields.smsConsent = readConsent(fields.smsConsentAsSent);
  fields.inquiryType = readInquiryType(fields.inquiryTypeAsSent);
  if (fields.inquiryTypeAsSent && !fields.inquiryType) warnings.push(`Inquiry type "${fields.inquiryTypeAsSent}" isn't "free consultation" or "questions first", so the AI treats it as a normal lead.`);
  if (fields.smsConsentAsSent && fields.smsConsent === "no" && !NO.has(keyOf(fields.smsConsentAsSent))) {
    warnings.push(`SMS consent value "${fields.smsConsentAsSent}" wasn't a clear yes, so it counts as NO consent.`);
  }
  if (fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) warnings.push(`Email "${fields.email}" doesn't look like an email address.`);

  for (const [k, v] of Object.entries(raw)) if (!used.has(k)) fields.other[k.slice(0, 80)] = String(v).slice(0, 500);

  const missing: string[] = [];
  if (!fields.firstName) missing.push("first_name");
  if (!fields.lastName) missing.push("last_name");
  if (!fields.phoneAsSent) missing.push("phone");
  if (!zipAsSent) missing.push("zip");
  if (!fields.email) missing.push("email");
  if (!fields.leadSource) missing.push("lead_source");
  if (!fields.campaignName && !fields.adName && !fields.adSet) missing.push("campaign_name / ad_name");
  if (!fields.formName) missing.push("form_name");
  if (!fields.submittedAtAsSent) missing.push("submitted_at");
  // Facebook/Instagram leads carry consent by source (Steven 2026-11-03), so a missing
  // sms_consent field isn't "missing" for them (Session 6 PR 3).
  if (!fields.smsConsentAsSent && !sourceGivesConsent(fields)) missing.push("sms_consent");

  return { fields, raw, missing, warnings };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

let tablesReady: Promise<void> | null = null;
async function leadsDb() {
  const sql = await smsDb();
  if (!tablesReady) {
    tablesReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS sms_leads (
        id BIGSERIAL PRIMARY KEY,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        mode TEXT NOT NULL,
        phone TEXT,
        first_name TEXT,
        last_name TEXT,
        email TEXT,
        zip TEXT,
        lead_source TEXT,
        campaign_name TEXT,
        ad_name TEXT,
        form_name TEXT,
        submitted_at TIMESTAMPTZ,
        sms_consent TEXT NOT NULL,
        fields JSONB NOT NULL,
        raw JSONB NOT NULL,
        missing JSONB,
        warnings JSONB,
        result TEXT NOT NULL,
        user_agent TEXT
      )`;
      await sql`CREATE INDEX IF NOT EXISTS sms_leads_received ON sms_leads (received_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS sms_leads_phone ON sms_leads (phone)`;
    })().catch((error) => { tablesReady = null; throw error; });
  }
  await tablesReady;
  return sql;
}

/** Tests only. */
export function resetLeadTablesForTests() { tablesReady = null; }

export async function saveLead(lead: ParsedLead, input: { mode: LeadsMode; result: string; userAgent: string | null; at: Date }): Promise<number> {
  const sql = await leadsDb();
  const f = lead.fields;
  const rows = await sql`INSERT INTO sms_leads
      (received_at, mode, phone, first_name, last_name, email, zip, lead_source, campaign_name, ad_name, form_name,
       submitted_at, sms_consent, fields, raw, missing, warnings, result, user_agent)
    VALUES (${input.at.toISOString()}::timestamptz, ${input.mode}, ${f.phone}, ${f.firstName}, ${f.lastName}, ${f.email}, ${f.zip},
      ${f.leadSource}, ${f.campaignName}, ${f.adName}, ${f.formName}, ${f.submittedAt}::timestamptz, ${f.smsConsent},
      ${JSON.stringify(f)}::jsonb, ${JSON.stringify(lead.raw)}::jsonb, ${JSON.stringify(lead.missing)}::jsonb,
      ${JSON.stringify(lead.warnings)}::jsonb, ${input.result}, ${input.userAgent ? input.userAgent.slice(0, 200) : null})
    RETURNING id`;
  return Number(rows[0].id);
}

export type LeadRow = {
  id: number;
  receivedAt: string;
  mode: string;
  result: string;
  fields: LeadFields;
  raw: Record<string, string>;
  missing: string[];
  warnings: string[];
};

export async function recentLeads(limit = 25): Promise<LeadRow[]> {
  const sql = await leadsDb();
  const rows = await sql`SELECT id, received_at, mode, result, fields, raw, missing, warnings
    FROM sms_leads ORDER BY received_at DESC, id DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    id: Number(r.id),
    receivedAt: new Date(r.received_at as string).toISOString(),
    mode: String(r.mode),
    result: String(r.result),
    fields: r.fields as LeadFields,
    raw: (r.raw || {}) as Record<string, string>,
    missing: (r.missing || []) as string[],
    warnings: (r.warnings || []) as string[],
  }));
}

// ---------------------------------------------------------------------------
// Live intake (SMS_LEADS_MODE=live)
// ---------------------------------------------------------------------------

export type LiveResult =
  | "drip_started"      // new lead, consent, drip on: welcome goes out now (or at 8 AM)
  | "joined_existing"   // we already have this number: no restart
  | "no_consent"        // shown in the inbox, no automated texts
  | "drip_off"          // SMS_DRIP_ENABLED is off: shown in the inbox, no automated texts
  | "no_valid_phone";   // nothing to text: saved on /sms-test only

const DEFAULT_CONSENT_SOURCES = ["facebook", "fb", "instagram", "ig", "meta"];

export function consentSources(): string[] {
  const raw = (process.env.SMS_CONSENT_SOURCES || "").trim();
  return raw ? raw.split(/[,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean) : DEFAULT_CONSENT_SOURCES;
}

/** The lead source (or, if Melanie only sends it, the platform) is one that carries SMS consent. */
function sourceGivesConsent(fields: Pick<LeadFields, "leadSource" | "platform">): boolean {
  return [fields.leadSource, fields.platform].some((value) => {
    const source = (value || "").toLowerCase();
    return Boolean(source) && consentSources().some((s) => source.split(/[^a-z0-9]+/).includes(s) || source === s);
  });
}

/** Does this lead give us form consent to text (Steven, 2026-11-03)? */
export function leadHasConsent(fields: LeadFields): boolean {
  if (fields.smsConsent === "no" && fields.smsConsentAsSent) return false;
  if (fields.smsConsent === "yes") return true;
  return sourceGivesConsent(fields);
}

/** "Free in-home consultation" / "I have questions first" -> one of two values (else null). */
export function readInquiryType(value: string | null): InquiryType {
  const v = (value || "").toLowerCase();
  if (!v.trim()) return null;
  if (/question|info|learn|not sure|just looking/.test(v)) return "questions_first";
  if (/consult|appointment|estimate|quote|book|schedul|visit/.test(v)) return "free_consultation";
  return null;
}

export const INQUIRY_LABELS: Record<Exclude<InquiryType, null>, string> = {
  free_consultation: "Free consultation",
  questions_first: "Questions first",
};

/** Arizona doesn't change clocks; everything else we serve is Pacific. */
export function timeZoneForZip(zip: string | null): string {
  return zip && /^8[56]\d{3}$/.test(zip) ? "America/Phoenix" : "America/Los_Angeles";
}

/** What the inbox and the AI see about the form (no raw ROAS fields). */
export function leadInfo(lead: ParsedLead, leadId: number, receivedAt: Date) {
  const f = lead.fields;
  return {
    leadId,
    receivedAt: receivedAt.toISOString(),
    submittedAt: f.submittedAt,
    source: f.leadSource,
    campaign: f.campaignName,
    ad: f.adName,
    crmCampaign: f.crmCampaignName,
    platform: f.platform,
    adSet: f.adSet,
    inquiryType: f.inquiryType ? INQUIRY_LABELS[f.inquiryType] : f.inquiryTypeAsSent,
    form: f.formName,
    zip: f.zip,
    email: f.email,
    projectInterest: f.projectInterest,
    bestTime: f.bestTime,
    consent: leadHasConsent(f) ? "yes" : "no",
  };
}

function shortDate(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(new Date(iso));
}

async function markLeadResult(leadId: number, result: string) {
  const sql = await leadsDb();
  await sql`UPDATE sms_leads SET result = ${result} WHERE id = ${leadId}`;
}

/**
 * One live lead. Returns what happened; when it's "drip_started" the caller
 * sends the welcome (processDrip) after answering Zapier.
 */
export async function processLiveLead(lead: ParsedLead, leadId: number, now: Date, options: { dripOn: boolean }): Promise<LiveResult> {
  const f = lead.fields;
  const phone = f.phone;
  if (!phone) {
    await markLeadResult(leadId, "no_valid_phone");
    return "no_valid_phone";
  }
  const info = leadInfo(lead, leadId, now);
  const timeZone = timeZoneForZip(f.zip);
  const consent = leadHasConsent(f);
  const sql = await smsDb();

  const existingRows = await sql`SELECT v.id, v.lead_at, v.drip_status, v.drip_restart_ok,
      EXISTS (SELECT 1 FROM sms_messages m WHERE m.conversation_id = v.id) AS has_messages
    FROM sms_conversations v WHERE v.phone = ${phone}`;
  const existing = existingRows[0];
  const isExisting = Boolean(existing) && existing.drip_restart_ok !== true
    && (existing.lead_at != null || existing.has_messages === true || existing.drip_status != null);

  await ensureContact(phone);
  if (consent) {
    await addConsent(phone, "care", "facebook_lead_form", JSON.stringify({
      leadId, form: f.formName, campaign: f.campaignName, source: f.leadSource, platform: f.platform, submittedAt: f.submittedAt,
      basis: "Facebook lead form submit; Steven 2026-11-03: these forms carry SMS consent",
    }), now);
  }
  const named = await sql`SELECT first_name, last_name FROM sms_contacts WHERE phone = ${phone}`;
  if (!named[0]?.first_name && !named[0]?.last_name && (f.firstName || f.lastName)) await setContactName(phone, f.firstName, f.lastName);

  const formWords = [
    `${f.leadSource || f.platform || "Lead"} form${f.formName ? ` "${f.formName}"` : ""} on ${shortDate(f.submittedAt || now.toISOString(), timeZone)}`,
    f.projectInterest ? `interested in: ${f.projectInterest}` : "",
    f.bestTime ? `best time to reach: ${f.bestTime}` : "",
  ].filter(Boolean).join("; ");
  const notes: Record<string, string> = { lead_form: formWords.slice(0, 200) };
  if (f.firstName) notes.first_name = f.firstName;
  if (f.zip) notes.form_zip = `${f.zip} (from their form, not checked yet)`;
  // What they asked for (the AI sees this) + where to book them (code-only "_" notes for the 📅 card).
  if (f.inquiryType === "questions_first") notes.inquiry_type = "questions first (they want answers before booking a visit)";
  if (f.inquiryType === "free_consultation") notes.inquiry_type = "free in-home consultation";
  if (f.crmCampaignName) notes._crm_campaign = f.crmCampaignName;
  if (f.platform) notes._platform = f.platform;
  if (f.adSet) notes._ad_set = f.adSet;
  await saveCustomerNotes(phone, notes);

  if (isExisting) {
    await sql`UPDATE sms_conversations SET lead_at = ${now.toISOString()}::timestamptz, lead_info = ${JSON.stringify(info)}::jsonb,
        lead_count = lead_count + 1, updated_at = now()
      WHERE phone = ${phone}`;
    await audit({ phone, action: "lead_resubmitted", reason: existing.drip_status ? `drip ${existing.drip_status}` : "existing conversation", detail: { leadId }, actor: "zapier" });
    if (existing.drip_status !== "active") {
      await setHandoff(phone, "lead_resubmitted", `Sent another lead form (${formWords}). We already have a conversation with them, so no drip restarted.`, now, { keepAi: true });
    }
    await markLeadResult(leadId, "joined_existing");
    return "joined_existing";
  }

  await sql`UPDATE sms_contacts SET time_zone = ${timeZone}, updated_at = now() WHERE phone = ${phone}`;
  const result: LiveResult = !consent ? "no_consent" : !options.dripOn ? "drip_off" : "drip_started";
  if (result === "drip_started") {
    await sql`UPDATE sms_conversations SET lead_at = ${now.toISOString()}::timestamptz, lead_info = ${JSON.stringify(info)}::jsonb,
        lead_count = lead_count + 1, drip_status = 'active', drip_step = 0, drip_next_at = ${now.toISOString()}::timestamptz,
        drip_day1 = NULL, drip_started_at = ${now.toISOString()}::timestamptz, drip_last_sent_at = NULL,
        drip_stop_reason = NULL, drip_stopped_at = NULL, drip_stopped_by = NULL, drip_restart_ok = false, updated_at = now()
      WHERE phone = ${phone}`;
  } else {
    const why = result === "no_consent" ? "no SMS consent on this form" : "the drip is switched off";
    await sql`UPDATE sms_conversations SET lead_at = ${now.toISOString()}::timestamptz, lead_info = ${JSON.stringify(info)}::jsonb,
        lead_count = lead_count + 1, drip_status = 'off', drip_step = NULL, drip_next_at = NULL,
        drip_stop_reason = ${why}, drip_restart_ok = false, updated_at = now()
      WHERE phone = ${phone}`;
    await setHandoff(phone, "new_lead_no_texts", `New lead (${formWords}). No automated texts: ${why}. Call or text them.`, now, { keepAi: true });
  }
  await audit({ phone, action: "lead_live", reason: result, detail: { leadId, form: f.formName, consent }, actor: "zapier" });
  await markLeadResult(leadId, result);
  return result;
}

/**
 * Owners' test button (/sms-test): let the next lead for this number start a
 * fresh drip, as if it were new. Texts and notes stay. Optionally skip the
 * ServiceTitan check for this number (test phones are often real customers).
 */
export async function resetLeadForTest(phone: string, options: { skipServiceTitan: boolean }): Promise<boolean> {
  const sql = await smsDb();
  const rows = await sql`UPDATE sms_conversations SET drip_status = NULL, drip_step = NULL, drip_next_at = NULL, drip_day1 = NULL,
      drip_started_at = NULL, drip_last_sent_at = NULL, drip_stop_reason = NULL, drip_stopped_at = NULL, drip_stopped_by = NULL,
      lead_at = NULL, lead_info = NULL, lead_count = 0, st_check = NULL, st_checked_at = NULL,
      st_test_bypass = ${options.skipServiceTitan}, drip_restart_ok = true, followups_off = false, followup_lock_until = NULL,
      handoff_summary = CASE WHEN handoff_reason IN ('new_lead_no_texts', 'lead_resubmitted', 'st_excluded') THEN NULL ELSE handoff_summary END,
      handoff_at = CASE WHEN handoff_reason IN ('new_lead_no_texts', 'lead_resubmitted', 'st_excluded') THEN NULL ELSE handoff_at END,
      handoff_reason = CASE WHEN handoff_reason IN ('new_lead_no_texts', 'lead_resubmitted', 'st_excluded') THEN NULL ELSE handoff_reason END,
      updated_at = now()
    WHERE phone = ${phone} RETURNING id`;
  return rows.length > 0;
}

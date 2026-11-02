/**
 * lib/sms/leads.ts
 *
 * Lead intake from Zapier (POST /api/leads). Build step 5, first PR = "log only"
 * test mode: every lead is saved with all of its fields and shown on the
 * Texting setup & test page (/sms-test), and NO texts are sent, no contact or
 * conversation is created.
 *
 *   sms_leads   one row per form submission Zapier sends us (raw payload + the
 *               fields we understood), newest first on /sms-test
 *
 * The secret: Vercel env SMS_LEADS_SECRET. Zapier sends it in the
 * X-Denny-Secret header (or "Authorization: Bearer <secret>").
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { normalizePhone } from "@/lib/sms/rules";
import { smsDb } from "@/lib/sms/store";

/** Largest request we accept (a lead form is a few hundred bytes). */
export const MAX_LEAD_BYTES = 20_000;

export type LeadsMode = "log_only";

/** Step 5 PR 1: intake only logs. Real intake (texts) comes in the next PR. */
export function leadsMode(): LeadsMode {
  return "log_only";
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

export type ParsedLead = { fields: LeadFields; raw: Record<string, string>; missing: string[]; warnings: string[] };

/** The keys we ask Melanie to use, plus common spellings Zapier/Facebook use. Matched without case, spaces or _. */
const ALIASES: Record<keyof Omit<LeadFields, "other" | "phone" | "submittedAt" | "smsConsent">, string[]> = {
  firstName: ["firstname", "first", "fname", "contactfirstname", "givenname"],
  lastName: ["lastname", "last", "lname", "contactlastname", "surname", "familyname"],
  phoneAsSent: ["phone", "phonenumber", "mobile", "mobilephone", "mobilenumber", "cell", "cellphone", "contactphone"],
  zip: ["zip", "zipcode", "postalcode", "postcode", "zippostalcode"],
  email: ["email", "emailaddress", "contactemail"],
  leadSource: ["leadsource", "source", "platform"],
  campaignName: ["campaignname", "campaign", "adcampaign", "adcampaignname"],
  adName: ["adname", "ad", "adsetname", "adset", "adgroup", "adgroupname"],
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
  if (!fields.campaignName && !fields.adName) missing.push("campaign_name / ad_name");
  if (!fields.formName) missing.push("form_name");
  if (!fields.submittedAtAsSent) missing.push("submitted_at");
  if (!fields.smsConsentAsSent) missing.push("sms_consent");

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

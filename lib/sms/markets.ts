/**
 * lib/sms/markets.ts
 *
 * Session 8 PR 2 (Nor-Cal numbers): which of our Twilio numbers a NEW lead gets.
 * Edited by owners on the "Texting numbers" page (/sms-numbers), so Melanie can
 * change ad sets without a code change.
 *
 *   sms_numbers  one row per Twilio number: name, ServiceTitan line calls forward to
 *                (used by the calls PR), "texting for new leads" on/off, ZIPs and
 *                customer area codes it covers
 *   sms_ad_sets  ad set words -> number ("chico" -> (530) 456-4834)
 *
 * Picking order for a new lead (only numbers switched On; the default number is always on):
 *   1. the ad set name contains an ad set's words (longest words win)
 *   2. the lead's ZIP: an exact 5-digit ZIP first, then its first 3 digits
 *   3. the area code of the lead's own phone
 *   4. the default number (916) 891-1680
 * A conversation keeps its number after that (sticky, lib/sms/numbers.ts).
 */
import { formatPhone, normalizePhone } from "@/lib/sms/rules";
import { defaultSendingNumber } from "@/lib/sms/numbers";
import { smsDb, type Sql } from "@/lib/sms/store";

export type SmsNumber = {
  number: string;
  name: string;
  forwardTo: string | null;
  textingOn: boolean;
  zips: string[];
  areaCodes: string[];
  sort: number;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type SmsAdSet = { words: string; number: string };

export type NumberPick = {
  number: string;
  name: string;
  matchedBy: "ad_set" | "zip" | "area_code" | "default";
  /** Short reason, saved on the conversation: "ad set Chico", "ZIP 95926", "area code 530", "default number". */
  reason: string;
  /** Matches we skipped because that number is switched Off. */
  skipped: string[];
};

// ---------------------------------------------------------------------------
// Starting setup (Session 8, 2026-11-17). Only used the first time the tables are created.
// ---------------------------------------------------------------------------
const SEED_NUMBERS: Omit<SmsNumber, "updatedAt" | "updatedBy">[] = [
  { number: "+19168911680", name: "Sacramento", forwardTo: "+19164096367", textingOn: true, zips: ["956", "957", "958"], areaCodes: ["916", "279"], sort: 1 },
  { number: "+15304564834", name: "Chico", forwardTo: null, textingOn: false, zips: ["959", "960", "961"], areaCodes: ["530"], sort: 2 },
  { number: "+16614915275", name: "Bakersfield", forwardTo: "+16615502092", textingOn: false, zips: ["933", "935"], areaCodes: ["661"], sort: 3 },
  { number: "+15592725548", name: "Fresno", forwardTo: "+15592426194", textingOn: false, zips: ["932", "936", "937"], areaCodes: ["559"], sort: 4 },
  { number: "+12093950383", name: "Modesto + Stockton", forwardTo: "+12093796776", textingOn: false, zips: ["952", "953"], areaCodes: ["209", "350"], sort: 5 },
  { number: "+16508859207", name: "San Jose", forwardTo: "+14082142692", textingOn: false, zips: ["940", "943", "944", "950", "951"], areaCodes: ["408", "669", "831", "650"], sort: 6 },
  { number: "+15105904401", name: "Bay Area", forwardTo: "+15104403415", textingOn: false, zips: ["941", "945", "946", "947", "948", "949"], areaCodes: ["510", "341", "925", "415", "628"], sort: 7 },
  {
    number: "+17072100914", name: "Santa Rosa + Vacaville", forwardTo: null, textingOn: false,
    // Vacaville, Dixon, Fairfield, Travis AFB, Benicia, Vallejo and Napa are 707 towns with 956/945 ZIPs.
    zips: ["954", "955", "95687", "95688", "95620", "94533", "94534", "94535", "94510", "94589", "94590", "94591", "94558", "94559"],
    areaCodes: ["707"], sort: 8,
  },
];

const SEED_AD_SETS: SmsAdSet[] = [
  { words: "sacramento", number: "+19168911680" },
  { words: "chico", number: "+15304564834" },
  { words: "bakersfield", number: "+16614915275" },
  { words: "fresno", number: "+15592725548" },
  { words: "modesto", number: "+12093950383" },
  { words: "stockton", number: "+12093950383" },
  { words: "san jose", number: "+16508859207" },
  { words: "bay area", number: "+15105904401" },
  { words: "santa rosa", number: "+17072100914" },
  { words: "vacaville", number: "+17072100914" },
];

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------
let ready: Promise<void> | null = null;

/** Tests only. */
export function resetMarketTablesForTests() { ready = null; }

async function marketsDb(): Promise<Sql> {
  const sql = await smsDb();
  if (!ready) {
    ready = createTables(sql).catch((error) => { ready = null; throw error; });
  }
  await ready;
  return sql;
}

async function createTables(sql: Sql) {
  await sql`CREATE TABLE IF NOT EXISTS sms_numbers (
    number TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    forward_to TEXT,
    texting_on BOOLEAN NOT NULL DEFAULT false,
    zips TEXT NOT NULL DEFAULT '',
    area_codes TEXT NOT NULL DEFAULT '',
    sort INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by TEXT
  )`;
  await sql`CREATE TABLE IF NOT EXISTS sms_ad_sets (
    id BIGSERIAL PRIMARY KEY,
    words TEXT NOT NULL UNIQUE,
    number TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by TEXT
  )`;
  const count = await sql`SELECT count(*)::int AS n FROM sms_numbers`;
  if (Number(count[0]?.n) === 0) {
    for (const n of SEED_NUMBERS) {
      await sql`INSERT INTO sms_numbers (number, name, forward_to, texting_on, zips, area_codes, sort, updated_by)
        VALUES (${n.number}, ${n.name}, ${n.forwardTo}, ${n.textingOn}, ${n.zips.join(", ")}, ${n.areaCodes.join(", ")}, ${n.sort}, 'setup')
        ON CONFLICT (number) DO NOTHING`;
    }
    for (const a of SEED_AD_SETS) {
      await sql`INSERT INTO sms_ad_sets (words, number, updated_by) VALUES (${a.words}, ${a.number}, 'setup') ON CONFLICT (words) DO NOTHING`;
    }
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
const tokens = (text: string) => text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);

/** "Bay-Area  Leads!" -> "bay area leads" (for matching ad set words). */
export function normalizeWords(text: string | null | undefined): string {
  return (text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export async function listNumbers(): Promise<SmsNumber[]> {
  const sql = await marketsDb();
  const rows = await sql`SELECT * FROM sms_numbers ORDER BY sort, name`;
  return rows.map((r) => ({
    number: String(r.number),
    name: String(r.name),
    forwardTo: r.forward_to ? String(r.forward_to) : null,
    textingOn: r.texting_on === true,
    zips: tokens(String(r.zips || "")),
    areaCodes: tokens(String(r.area_codes || "")),
    sort: Number(r.sort) || 0,
    updatedAt: r.updated_at ? new Date(r.updated_at as string).toISOString() : null,
    updatedBy: r.updated_by ? String(r.updated_by) : null,
  }));
}

export async function listAdSets(): Promise<SmsAdSet[]> {
  const sql = await marketsDb();
  const rows = await sql`SELECT words, number FROM sms_ad_sets ORDER BY words`;
  return rows.map((r) => ({ words: String(r.words), number: String(r.number) }));
}

/** Name for one of our numbers ("Chico"), or the formatted number when it isn't on the page. */
export async function numberName(number: string | null): Promise<string | null> {
  if (!number) return null;
  const found = (await listNumbers()).find((n) => n.number === number);
  return found ? found.name : formatPhone(number);
}

// ---------------------------------------------------------------------------
// Picking a number for a new lead
// ---------------------------------------------------------------------------
export function pickFrom(numbers: SmsNumber[], adSets: SmsAdSet[], lead: { adSet?: string | null; zip?: string | null; phone?: string | null }): NumberPick {
  const fallback = defaultSendingNumber();
  const byNumber = new Map(numbers.map((n) => [n.number, n]));
  const isOn = (number: string) => number === fallback || byNumber.get(number)?.textingOn === true;
  const nameOf = (number: string) => byNumber.get(number)?.name || formatPhone(number);
  const skipped: string[] = [];
  const result = (number: string, matchedBy: NumberPick["matchedBy"], reason: string): NumberPick =>
    ({ number, name: nameOf(number), matchedBy, reason, skipped });

  // 1. Ad set words (whole words, longest first: "san jose" before "jose").
  const adSet = ` ${normalizeWords(lead.adSet)} `;
  if (adSet.trim()) {
    const rules = [...adSets].sort((a, b) => normalizeWords(b.words).length - normalizeWords(a.words).length);
    for (const rule of rules) {
      const words = normalizeWords(rule.words);
      if (!words || !adSet.includes(` ${words} `)) continue;
      if (isOn(rule.number)) return result(rule.number, "ad_set", `ad set ${String(lead.adSet).trim().slice(0, 60)}`);
      skipped.push(`ad set "${rule.words}" → ${nameOf(rule.number)} is Off`);
      break;
    }
  }

  // 2. ZIP: exact 5 digits, then the first 3.
  const zip = (lead.zip || "").match(/\b(\d{5})\b/)?.[1];
  if (zip) {
    for (const key of [zip, zip.slice(0, 3)]) {
      const owner = numbers.find((n) => n.zips.includes(key));
      if (!owner) continue;
      if (isOn(owner.number)) return result(owner.number, "zip", `ZIP ${zip}`);
      skipped.push(`ZIP ${zip} → ${owner.name} is Off`);
      break;
    }
  }

  // 3. The area code of the lead's own phone.
  const phone = normalizePhone(lead.phone || "");
  if (phone) {
    const areaCode = phone.slice(2, 5);
    const owner = numbers.find((n) => n.areaCodes.includes(areaCode));
    if (owner) {
      if (isOn(owner.number)) return result(owner.number, "area_code", `area code ${areaCode}`);
      skipped.push(`area code ${areaCode} → ${owner.name} is Off`);
    }
  }

  // 4. Default.
  return result(fallback, "default", "default number");
}

export async function pickNumberForLead(lead: { adSet?: string | null; zip?: string | null; phone?: string | null }): Promise<NumberPick> {
  const [numbers, adSets] = await Promise.all([listNumbers(), listAdSets()]);
  return pickFrom(numbers, adSets, lead);
}

// ---------------------------------------------------------------------------
// Saving (the page sends the whole list each time)
// ---------------------------------------------------------------------------
export type NumberInput = { number: string; name: string; forwardTo: string; textingOn: boolean; zips: string; areaCodes: string };
export type AdSetInput = { words: string; number: string };

export type CleanSetup = { numbers: Omit<SmsNumber, "updatedAt" | "updatedBy">[]; adSets: SmsAdSet[] };

/** Check what an owner typed. Returns the cleaned setup or a list of problems in plain words. */
export function validateSetup(numbersIn: NumberInput[], adSetsIn: AdSetInput[]): { ok: true; setup: CleanSetup } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const numbers: CleanSetup["numbers"] = [];
  const seenZip = new Map<string, string>();
  const seenArea = new Map<string, string>();
  numbersIn.forEach((raw, i) => {
    const number = normalizePhone(raw.number);
    const label = (raw.name || "").trim() || `row ${i + 1}`;
    if (!number) { problems.push(`${label}: "${raw.number}" isn't a valid phone number.`); return; }
    if (numbers.some((n) => n.number === number)) { problems.push(`${formatPhone(number)} is listed twice.`); return; }
    const name = (raw.name || "").trim().slice(0, 60);
    if (!name) problems.push(`${formatPhone(number)}: give it a name (like "Chico").`);
    let forwardTo: string | null = null;
    if ((raw.forwardTo || "").trim()) {
      forwardTo = normalizePhone(raw.forwardTo);
      if (!forwardTo) problems.push(`${label}: calls-forward number "${raw.forwardTo}" isn't a valid phone number.`);
      if (forwardTo && forwardTo === number) problems.push(`${label}: calls can't forward to the same number.`);
    }
    const zips = tokens(raw.zips || "");
    for (const z of zips) {
      if (!/^\d{3}$|^\d{5}$/.test(z)) { problems.push(`${label}: "${z}" should be a 5-digit ZIP or its first 3 digits.`); continue; }
      const other = seenZip.get(z);
      if (other) problems.push(`ZIP ${z} is on both ${other} and ${label}.`);
      else seenZip.set(z, label);
    }
    const areaCodes = tokens(raw.areaCodes || "");
    for (const a of areaCodes) {
      if (!/^[2-9]\d{2}$/.test(a)) { problems.push(`${label}: "${a}" isn't an area code.`); continue; }
      const other = seenArea.get(a);
      if (other) problems.push(`Area code ${a} is on both ${other} and ${label}.`);
      else seenArea.set(a, label);
    }
    numbers.push({ number, name, forwardTo, textingOn: Boolean(raw.textingOn), zips, areaCodes, sort: i + 1 });
  });
  const fallback = defaultSendingNumber();
  if (!numbers.some((n) => n.number === fallback)) problems.push(`The default number ${formatPhone(fallback)} must stay on the list.`);

  const adSets: SmsAdSet[] = [];
  adSetsIn.forEach((raw) => {
    const words = normalizeWords(raw.words).slice(0, 60);
    if (!words) return; // empty row: ignore
    const number = normalizePhone(raw.number);
    if (!number || !numbers.some((n) => n.number === number)) { problems.push(`Ad set "${raw.words}": pick one of our numbers.`); return; }
    if (adSets.some((a) => a.words === words)) { problems.push(`Ad set "${raw.words}" is listed twice.`); return; }
    adSets.push({ words, number });
  });

  return problems.length ? { ok: false, problems } : { ok: true, setup: { numbers, adSets } };
}

export async function saveSetup(setup: CleanSetup, by: string): Promise<void> {
  const sql = await marketsDb();
  for (const n of setup.numbers) {
    await sql`INSERT INTO sms_numbers (number, name, forward_to, texting_on, zips, area_codes, sort, updated_at, updated_by)
      VALUES (${n.number}, ${n.name}, ${n.forwardTo}, ${n.textingOn}, ${n.zips.join(", ")}, ${n.areaCodes.join(", ")}, ${n.sort}, now(), ${by})
      ON CONFLICT (number) DO UPDATE SET name = EXCLUDED.name, forward_to = EXCLUDED.forward_to, texting_on = EXCLUDED.texting_on,
        zips = EXCLUDED.zips, area_codes = EXCLUDED.area_codes, sort = EXCLUDED.sort, updated_at = now(), updated_by = EXCLUDED.updated_by`;
  }
  const keep = setup.numbers.map((n) => n.number);
  const existing = await sql`SELECT number FROM sms_numbers`;
  for (const row of existing) {
    if (!keep.includes(String(row.number))) await sql`DELETE FROM sms_numbers WHERE number = ${String(row.number)}`;
  }
  const keepWords = setup.adSets.map((a) => a.words);
  for (const a of setup.adSets) {
    await sql`INSERT INTO sms_ad_sets (words, number, updated_at, updated_by) VALUES (${a.words}, ${a.number}, now(), ${by})
      ON CONFLICT (words) DO UPDATE SET number = EXCLUDED.number, updated_at = now(), updated_by = EXCLUDED.updated_by`;
  }
  const existingWords = await sql`SELECT words FROM sms_ad_sets`;
  for (const row of existingWords) {
    if (!keepWords.includes(String(row.words))) await sql`DELETE FROM sms_ad_sets WHERE words = ${String(row.words)}`;
  }
}

/** Newest number picks for new leads (page list), phone shown as last 4 digits only. */
export async function recentPicks(limit = 25): Promise<{ at: string; phoneLast4: string; number: string; reason: string; skipped: string[] }[]> {
  const sql = await marketsDb();
  const rows = await sql`SELECT phone, detail, created_at FROM sms_audit WHERE action = 'number_assigned' ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map((r) => {
    const d = (r.detail || {}) as Record<string, unknown>;
    return {
      at: new Date(r.created_at as string).toISOString(),
      phoneLast4: String(r.phone || "").slice(-4),
      number: String(d.number || ""),
      reason: String(d.reason || ""),
      skipped: Array.isArray(d.skipped) ? d.skipped.map(String) : [],
    };
  });
}

/**
 * lib/sms/simulator.ts
 *
 * The texting Simulator (/sms-sim, owners): runs the REAL texting brain
 * (composeBotReply in lib/sms/bot.ts) against an AI that plays the customer,
 * or against an owner typing as the customer. Nothing is texted: no Twilio,
 * no customer records, no Slack. Reply hours and caps don't apply here.
 *
 * Tables (created on first use, same Neon database as texting):
 *   sms_sim_scenarios  the scenario list Melanie and Steven edit
 *   sms_sim_runs       every saved run (the test log), with transcript and events
 */
import OpenAI from "openai";
import { CUSTOMER_POLICY_VERSION } from "@/lib/ai/customerPolicy";
import { botModel, composeBotReply, type BotEffects } from "@/lib/sms/bot";
import { OPT_OUT_CONFIRMATION } from "@/lib/sms/rules";
import { smsDb, type ThreadMessage } from "@/lib/sms/store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SimMessage = { from: "customer" | "bot"; text: string; media?: string[] };
export type SimEvent = { turn: number; type: string; text: string };
export type SimScenario = { id?: number; name: string; persona: string; opening: string; maxTurns: number };

export type SimTurnInput = {
  scenario: SimScenario;
  transcript: SimMessage[];
  notes: Record<string, string>;
  /** Set in "chat yourself" mode: the owner's own text. Otherwise the AI customer writes it. */
  customerText?: string;
};

export type SimTurnResult = {
  customerText: string;
  botReply: string | null;
  media: string[];
  events: SimEvent[];
  notes: Record<string, string>;
  ended: boolean;
  endReason: string | null;
  model: string;
};

export const SIM_MAX_TURNS = 15;
const END = "[END]";

export function customerModel(): string {
  return (process.env.SMS_SIM_CUSTOMER_MODEL || "gpt-4.1-mini").trim();
}

// ---------------------------------------------------------------------------
// The AI customer
// ---------------------------------------------------------------------------

type Complete = (params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming) => Promise<string>;

async function openAiText(params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing");
  const completion = await new OpenAI({ apiKey }).chat.completions.create(params);
  return completion.choices?.[0]?.message?.content?.trim() || "";
}

let customerComplete: Complete = openAiText;
export function setSimDepsForTests(deps: { customer?: Complete } | null) {
  customerComplete = deps?.customer ?? openAiText;
}

function customerSystemPrompt(persona: string): string {
  return `You are role-playing a homeowner texting Den Defenders, a company that sells and installs custom security screen doors, from your cell phone. Stay in character the whole time.

WHO YOU ARE AND WHAT YOU WANT
${persona}

HOW TO WRITE
- Write ONLY your next text message. One message, like a real person texts: short, casual, sometimes lowercase or with small typos. No signature, no quotes, no labels.
- Stick to your persona. If they ask something your persona doesn't cover, answer the way that person plausibly would and stay consistent with what you already said.
- React to what they actually said. If they repeat themselves, ignore your question or say something odd, react like a real customer would (confused, annoyed, or asking again).
- Never say you are an AI, a test or a simulation.
- When your goal is done, they hand you off to a person, you've said goodbye, or a real person would stop replying, write exactly ${END}`;
}

/** The AI customer's next text, or "[END]". */
export async function nextCustomerText(scenario: SimScenario, transcript: SimMessage[]): Promise<string> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: customerSystemPrompt(scenario.persona) },
  ];
  // From the customer's side: Den Defenders' texts are "user", their own are "assistant".
  for (const m of transcript) {
    const photos = m.media?.length ? ` [${m.media.length} photo${m.media.length > 1 ? "s" : ""} of installed doors attached]` : "";
    messages.push({ role: m.from === "bot" ? "user" : "assistant", content: `${m.text}${photos}` });
  }
  if (!transcript.length) messages.push({ role: "user", content: "(Write your first text to Den Defenders.)" });
  const text = await customerComplete({ model: customerModel(), temperature: 0.8, max_completion_tokens: 120, messages });
  const clean = text.replace(/^["']|["']$/g, "").trim();
  return !clean || clean.includes(END) ? END : clean.slice(0, 600);
}

// ---------------------------------------------------------------------------
// One turn: customer text -> real brain -> bot reply
// ---------------------------------------------------------------------------

function threadFrom(transcript: SimMessage[], customerText: string): ThreadMessage[] {
  const at = new Date().toISOString();
  const all: SimMessage[] = [...transcript, { from: "customer", text: customerText }];
  return all.slice(-40).map((m, i) => ({
    id: i + 1,
    direction: m.from === "customer" ? "inbound" : "outbound",
    body: m.text,
    mediaCount: m.media?.length || 0,
    createdAt: at,
  }));
}

const HANDOFF_LABELS: Record<string, string> = {
  wants_call: "wants a call",
  ready_to_book: "ready to book",
  complaint: "complaint",
  existing_customer: "existing customer",
  appointment_change: "appointment change",
  price_objection: "price objection",
  unsupported_work: "unsupported work",
  service_area_check: "service area check",
  abusive_or_spam: "abusive or spam",
  question_for_team: "question for the team",
};

export async function simulateTurn(input: SimTurnInput): Promise<SimTurnResult> {
  const turn = input.transcript.filter((m) => m.from === "customer").length + 1;
  const events: SimEvent[] = [];
  const notes = { ...input.notes };
  const add = (type: string, text: string) => { events.push({ turn, type, text }); };

  const customerText = (input.customerText ?? "").trim()
    || (!input.transcript.length && input.scenario.opening.trim())
    || await nextCustomerText(input.scenario, input.transcript);

  if (customerText === END) {
    return { customerText, botReply: null, media: [], events, notes, ended: true, endReason: "Customer stopped replying", model: botModel() };
  }

  let handoff: string | null = null;
  let optedOut = false;
  const fx: BotEffects = {
    log: async (action, reason, detail = {}) => {
      if (action === "bot_zip_check") add("zip", `ZIP check ${String(detail.zip || "")}: ${reason.toLowerCase().replace(/_/g, " ")}${detail.city ? ` (${detail.city}, ${detail.state})` : ""}`);
      else if (action === "bot_photos") add("photos", `Attached ${detail.count} photo(s): ${reason}`);
      else if (action === "bot_model_fallback") add("warning", `Model ${reason} failed, used the backup model`);
      else if (action === "bot_photo_claim_retry") add("fixup", "AI said photos were attached without attaching any; asked it to retry");
      else if (action === "bot_photo_claim_removed") add("fixup", "Code removed a false \"photos attached\" line");
      else if (action === "bot_no_reply") add("warning", `No reply (${reason})`);
    },
    saveNotes: async (fresh) => {
      const shown = Object.entries(fresh).filter(([k, v]) => v && !k.startsWith("_"));
      Object.assign(notes, fresh);
      if (shown.length) add("notes", `Saved: ${shown.map(([k, v]) => `${k.replace(/_/g, " ")} = ${v}`).join("; ")}`);
    },
    handOff: async (reason, summary, _notes, auto) => {
      handoff = reason;
      add("handoff", `Needs CSR: ${HANDOFF_LABELS[reason] || reason}${auto ? " (flagged by code)" : ""}. ${summary}`);
    },
    outcome: async (outcome) => { add("outcome", `Lead marked: ${outcome.replace(/_/g, " ")}`); },
    optOut: async () => { optedOut = true; add("opt_out", "Opted out (AI recognized \"stop texting me\")"); },
  };

  const composed = await composeBotReply({ thread: threadFrom(input.transcript, customerText), notes, now: new Date() }, fx);

  if (composed.kind === "opted_out" || optedOut) {
    return { customerText, botReply: OPT_OUT_CONFIRMATION, media: [], events, notes, ended: true, endReason: "Customer opted out", model: botModel() };
  }
  if (composed.kind === "no_reply") {
    return {
      customerText, botReply: null, media: [], events, notes,
      ended: Boolean(composed.handedOff || handoff),
      endReason: composed.handedOff || handoff ? "Handed off (no final message)" : null,
      model: botModel(),
    };
  }
  const reason = composed.handedOff?.reason || handoff;
  return {
    customerText,
    botReply: composed.reply,
    media: composed.media,
    events,
    notes,
    ended: Boolean(reason),
    endReason: reason ? `Handed off to a CSR: ${HANDOFF_LABELS[reason] || reason}` : null,
    model: composed.model,
  };
}

// ---------------------------------------------------------------------------
// Transcript text (copy / download)
// ---------------------------------------------------------------------------

export function transcriptText(run: { name: string; persona?: string; transcript: SimMessage[]; events: SimEvent[]; endReason?: string | null; createdAt?: string; policyVersion?: string }): string {
  const lines = [`Scenario: ${run.name}`];
  if (run.persona) lines.push(`Customer: ${run.persona}`);
  if (run.createdAt || run.policyVersion) lines.push(`Run: ${run.createdAt ? new Date(run.createdAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles" }) : ""}${run.policyVersion ? ` · brain policy ${run.policyVersion}` : ""}`);
  lines.push("");
  let turn = 0;
  for (const m of run.transcript) {
    if (m.from === "customer") turn++;
    lines.push(`${m.from === "customer" ? "CUSTOMER" : "DEN DEFENDERS"}: ${m.text.replace(/\n\n/g, "\n   ")}${m.media?.length ? `\n   [${m.media.length} photo(s) attached]` : ""}`);
    if (m.from === "bot") for (const e of run.events.filter((x) => x.turn === turn)) lines.push(`   (${e.text})`);
  }
  if (run.endReason) lines.push("", `Ended: ${run.endReason}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Storage: scenarios + saved runs
// ---------------------------------------------------------------------------

export const DEFAULT_SCENARIOS: SimScenario[] = [
  { name: "Price shopper, single front door", persona: "Homeowner in Citrus Heights, CA (ZIP 95610). Wants a security screen door for the single front door, mostly for airflow and security. First thing you want is the price. Fine with the price if it's under about $5,500. Prefers weekday mornings.", opening: "How much is a security screen door?", maxTurns: 8 },
  { name: "Patio slider", persona: "Homeowner in Phoenix, AZ (ZIP 85018) with a regular two-panel sliding glass patio door. Wants a security slider so the dog can't push through the screen. Asks how much and whether it's sturdy.", opening: "do you guys do sliding screen doors?", maxTurns: 8 },
  { name: "Double doors + financing", persona: "Homeowner in Sacramento, CA (ZIP 95826) with French double doors at the front. Wants a decorative look. Asks about price, then asks if there's financing or monthly payments.", opening: "", maxTurns: 8 },
  { name: "Too expensive, then declines", persona: "Homeowner in Elk Grove, CA (ZIP 95758) wanting one front security door. Expects it to be around $1,500 like the hardware store. When you hear the real price you say it's too expensive, and after one more reply you politely say no thanks.", opening: "", maxTurns: 6 },
  { name: "Existing customer, broken latch", persona: "You bought a Den Defenders security door two years ago. The latch is broken and the door won't lock. You're a little frustrated and want it fixed.", opening: "Hey the latch on the door you guys put in is broken and it won't lock", maxTurns: 5 },
  { name: "Wants a new front door (not what we do)", persona: "You want to replace your old wooden front door with a brand new steel entry door. You don't really know what a security screen door is.", opening: "Do you install new front doors? Mine is old and drafty", maxTurns: 6 },
  { name: "Las Vegas, one door only", persona: "Homeowner in Las Vegas, NV (ZIP 89123) who only wants ONE security door for the front. Ask for the price and when someone can come out.", opening: "", maxTurns: 7 },
  { name: "Photos + HOA question", persona: "Homeowner in Roseville, CA (ZIP 95747) in an HOA with strict rules. You want to see what decorative doors look like (ask for pictures) and ask if the HOA will approve it.", opening: "can I see some pictures of your doors?", maxTurns: 7 },
  { name: "Just call me", persona: "Busy homeowner in Stockton, CA (ZIP 95209). You don't like texting. You want someone to call you this afternoon about a security door. Your number is the one you're texting from.", opening: "Can someone just call me", maxTurns: 5 },
  { name: "Spam (press release pitch)", persona: "You are NOT a customer. You sell press-release services to small businesses and you're cold-texting. Keep pushing your service politely; you're not interested in doors.", opening: "Anything new at your business? A new service, a launch, something you're proud of? If so, I'd love to tell you how a press release could work for it. If you're not interested, just let me know so I can remove you from the list?", maxTurns: 4 },
];

let tablesReady: Promise<void> | null = null;
async function simDb() {
  const sql = await smsDb();
  if (!tablesReady) {
    tablesReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS sms_sim_scenarios (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        persona TEXT NOT NULL,
        opening TEXT NOT NULL DEFAULT '',
        max_turns INT NOT NULL DEFAULT 8,
        updated_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS sms_sim_runs (
        id BIGSERIAL PRIMARY KEY,
        scenario_name TEXT NOT NULL,
        persona TEXT,
        mode TEXT NOT NULL DEFAULT 'auto',
        transcript JSONB NOT NULL,
        events JSONB,
        notes JSONB,
        end_reason TEXT,
        turns INT NOT NULL DEFAULT 0,
        policy_version TEXT,
        model TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS sms_sim_runs_created ON sms_sim_runs (created_at DESC)`;
    })().catch((error) => { tablesReady = null; throw error; });
  }
  await tablesReady;
  return sql;
}

/** Tests only. */
export function resetSimTablesForTests() { tablesReady = null; }

function cleanScenario(raw: Partial<SimScenario>): SimScenario | null {
  const name = String(raw.name || "").trim().slice(0, 80);
  const persona = String(raw.persona || "").trim().slice(0, 1500);
  if (!name || !persona) return null;
  const turns = Number(raw.maxTurns);
  return {
    name,
    persona,
    opening: String(raw.opening || "").trim().slice(0, 600),
    maxTurns: Number.isFinite(turns) ? Math.min(Math.max(Math.round(turns), 1), SIM_MAX_TURNS) : 8,
  };
}

export async function listScenarios(): Promise<SimScenario[]> {
  const sql = await simDb();
  let rows = await sql`SELECT id, name, persona, opening, max_turns FROM sms_sim_scenarios ORDER BY id`;
  if (!rows.length) {
    for (const s of DEFAULT_SCENARIOS) {
      await sql`INSERT INTO sms_sim_scenarios (name, persona, opening, max_turns, updated_by)
        VALUES (${s.name}, ${s.persona}, ${s.opening}, ${s.maxTurns}, 'starter set')`;
    }
    rows = await sql`SELECT id, name, persona, opening, max_turns FROM sms_sim_scenarios ORDER BY id`;
  }
  return rows.map((r) => ({ id: Number(r.id), name: String(r.name), persona: String(r.persona), opening: String(r.opening || ""), maxTurns: Number(r.max_turns) }));
}

export async function saveScenario(raw: Partial<SimScenario>, by: string): Promise<SimScenario | null> {
  const s = cleanScenario(raw);
  if (!s) return null;
  const sql = await simDb();
  const id = Number(raw.id);
  if (Number.isFinite(id) && id > 0) {
    const rows = await sql`UPDATE sms_sim_scenarios SET name = ${s.name}, persona = ${s.persona}, opening = ${s.opening},
        max_turns = ${s.maxTurns}, updated_by = ${by}, updated_at = now() WHERE id = ${id} RETURNING id`;
    return rows.length ? { ...s, id } : null;
  }
  const rows = await sql`INSERT INTO sms_sim_scenarios (name, persona, opening, max_turns, updated_by)
    VALUES (${s.name}, ${s.persona}, ${s.opening}, ${s.maxTurns}, ${by}) RETURNING id`;
  return { ...s, id: Number(rows[0].id) };
}

export async function deleteScenario(id: number): Promise<boolean> {
  const sql = await simDb();
  const rows = await sql`DELETE FROM sms_sim_scenarios WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

export type SavedRun = {
  id: number; name: string; persona: string; mode: string; transcript: SimMessage[]; events: SimEvent[];
  notes: Record<string, string>; endReason: string | null; turns: number; policyVersion: string; model: string;
  createdBy: string; createdAt: string;
};

export async function saveRun(run: { name: string; persona: string; mode: "auto" | "manual"; transcript: SimMessage[]; events: SimEvent[]; notes: Record<string, string>; endReason: string | null; model: string }, by: string): Promise<number> {
  const sql = await simDb();
  const transcript = run.transcript.slice(0, 2 * SIM_MAX_TURNS + 10).map((m) => ({
    from: m.from === "bot" ? "bot" : "customer",
    text: String(m.text || "").slice(0, 1000),
    media: Array.isArray(m.media) ? m.media.slice(0, 3).map(String) : undefined,
  }));
  const turns = transcript.filter((m) => m.from === "customer").length;
  const rows = await sql`INSERT INTO sms_sim_runs (scenario_name, persona, mode, transcript, events, notes, end_reason, turns, policy_version, model, created_by)
    VALUES (${run.name.slice(0, 80)}, ${run.persona.slice(0, 1500)}, ${run.mode}, ${JSON.stringify(transcript)}::jsonb,
      ${JSON.stringify((run.events || []).slice(0, 200))}::jsonb, ${JSON.stringify(run.notes || {})}::jsonb,
      ${run.endReason ? run.endReason.slice(0, 200) : null}, ${turns}, ${CUSTOMER_POLICY_VERSION}, ${run.model.slice(0, 60)}, ${by})
    RETURNING id`;
  return Number(rows[0].id);
}

function runFrom(r: Record<string, unknown>): SavedRun {
  const parse = <T,>(v: unknown, fallback: T): T => {
    if (v == null) return fallback;
    if (typeof v === "string") { try { return JSON.parse(v) as T; } catch { return fallback; } }
    return v as T;
  };
  return {
    id: Number(r.id),
    name: String(r.scenario_name),
    persona: String(r.persona || ""),
    mode: String(r.mode),
    transcript: parse<SimMessage[]>(r.transcript, []),
    events: parse<SimEvent[]>(r.events, []),
    notes: parse<Record<string, string>>(r.notes, {}),
    endReason: (r.end_reason as string) ?? null,
    turns: Number(r.turns || 0),
    policyVersion: String(r.policy_version || ""),
    model: String(r.model || ""),
    createdBy: String(r.created_by || ""),
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

export async function recentRuns(limit = 50): Promise<SavedRun[]> {
  const sql = await simDb();
  const rows = await sql`SELECT * FROM sms_sim_runs ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
  return rows.map(runFrom);
}

export async function deleteRun(id: number): Promise<boolean> {
  const sql = await simDb();
  const rows = await sql`DELETE FROM sms_sim_runs WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

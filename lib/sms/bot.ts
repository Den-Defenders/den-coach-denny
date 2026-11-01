/**
 * lib/sms/bot.ts
 *
 * Den Defenders' AI assistant answering texts to the pilot number (build step 2).
 *
 * Called by /api/sms/inbound AFTER it has answered Twilio (so Twilio's
 * 15-second webhook limit never matters). For each normal text:
 *
 *   1. wait 2.5 seconds; if they sent another text meanwhile, let that one answer both
 *   2. skip (no AI cost) when: bot switched off, number not on the pilot list, opted out,
 *      handed off to the team, or outside reply hours (any hour since 2026-11-01)
 *   3. read the last 40 texts + the customer's saved notes, ask OpenAI for one reply
 *      (tools: ZIP check, handoff, outcome, opt-out, save notes). The prompt starts with
 *      the shared customer policy (lib/ai/customerPolicy.ts); its version is logged per reply
 *   4. send it through THE send helper (lib/sms/send.ts) as kind "reply", so every
 *      guardrail still applies: opt-outs, allow-list, 24-hour window, hours, caps
 *
 * Handoffs ("Needs CSR") pause the bot for that number until a person turns it
 * back on in the Texting inbox.
 *
 * Step 4a (lib/sms/booking.ts): find_open_times offers REAL open consultation times
 * from the Denny scheduler (read-only); choose_time + request_booking turn the one the
 * customer picks into a "📅 Ready to book" handoff a CSR books in ServiceTitan.
 * The AI never books and code removes any "booked / scheduled / confirmed" claim.
 *
 * composeBotReply() is the brain on its own (no sending); the Simulator
 * (lib/sms/simulator.ts, /sms-sim) runs it with an AI playing the customer.
 */
import { after } from "next/server";
import OpenAI from "openai";
import salesZipDirectory from "@/app/lib/salesZipDirectory.json";
import { COMPANY_FACTS, NV_ASK_TEAM_CITIES, NV_SERVED_CITIES } from "@/lib/ai/companyFacts";
import { CUSTOMER_POLICY_VERSION } from "@/lib/ai/customerPolicy";
import { DOOR_PHOTO_CATEGORIES, doorPhotoName, isCategory, pickDoorPhotos } from "@/lib/doorPhotos";
import { inboxLink, ownerMention, pilotTag, postReadyToBookAlert, postSmsSlack, slackAlertsEnabled } from "@/lib/sms/alerts";
import {
  CHECKING_TEXT,
  CHOSEN_TIME_KEY,
  LOOKUPS_KEY,
  MAX_LOOKUPS_PER_DAY,
  MAX_TIMES_OFFERED,
  OPEN_TIMES_KEY,
  SAFE_BOOKING_GOODBYE,
  bookingLines,
  checkTimeAtAddress,
  chosenTimeFrom,
  claimsBooked,
  datesArg,
  hasTwoOrMoreDoors,
  isSlow,
  lookupOpenTimes,
  lookupsToday,
  matchOffered,
  openTimesFrom,
  partOfDay,
  teamNotesText,
  timeWords,
  weekdaysArg,
  withoutBookingClaim,
  type BookingRequest,
  type OfferedTime,
  type SlotCheck,
} from "@/lib/sms/booking";
import { smsBotSystemPrompt, type KnownAboutCustomer } from "@/lib/sms/botPrompt";
import { DEFAULT_TIME_ZONE, MAX_BODY_CHARS, TEAM_HOURS_TEXT, formatPhone, localTime, teamIsTexting, withinSendingHours } from "@/lib/sms/rules";
import { allowList, checkCaps, sendOptOutConfirmation, sendSms, sendingEnabled, smsNow, type SendResult } from "@/lib/sms/send";
import {
  CHECKING_SENDER,
  audit,
  conversationState,
  ensureContact,
  findOptOut,
  clearLeadStatus,
  latestInboundId,
  nameContactIfEmpty,
  outboundSinceMessage,
  recordOptOut,
  saveBookingRequest,
  saveCustomerNotes,
  setHandoff,
  setLeadStatus,
  threadForBot,
  type LeadStatus,
  type ThreadMessage,
} from "@/lib/sms/store";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** On/off switch for AI replies (separate from SMS_SENDING_ENABLED, which stops ALL texts). */
export function botEnabled(): boolean {
  return (process.env.SMS_BOT_ENABLED || "").trim().toLowerCase() === "true";
}

/** gpt-4.1-mini follows the long texting rules better than gpt-4o-mini (Steven, 2026-10-25). */
export const DEFAULT_BOT_MODEL = "gpt-4.1-mini";
/** Used only if the main model errors (e.g. not enabled on the OpenAI account). */
export const FALLBACK_BOT_MODEL = "gpt-4o-mini";

export function botModel(): string {
  return (process.env.SMS_BOT_MODEL || DEFAULT_BOT_MODEL).trim();
}

function debounceMs(): number {
  const n = Number.parseInt((process.env.SMS_BOT_DEBOUNCE_MS || "").trim(), 10);
  return Number.isFinite(n) && n >= 0 && n <= 20000 ? n : 2500;
}

/** Keep AI replies to about 3-4 SMS segments; the send helper's hard limit is 640. */
const MAX_REPLY_CHARS = 600;
const MAX_ROUNDS = 5;

export const HANDOFF_REASONS = [
  "wants_call",
  "ready_to_book",
  "complaint",
  "existing_customer",
  "appointment_change",
  "price_objection",
  "unsupported_work",
  "service_area_check",
  "abusive_or_spam",
  "question_for_team",
] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

// ---------------------------------------------------------------------------
// Test hooks (swap the model and the wait)
// ---------------------------------------------------------------------------

type CompletionMessage = OpenAI.Chat.Completions.ChatCompletionMessage;
type CompletionParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type Complete = (params: CompletionParams) => Promise<CompletionMessage | null>;

async function openAiComplete(params: CompletionParams): Promise<CompletionMessage | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing");
  const completion = await new OpenAI({ apiKey }).chat.completions.create(params);
  return completion.choices?.[0]?.message ?? null;
}

type Schedule = (task: () => Promise<void>) => void;
const runAfterResponse: Schedule = (task) => after(task);

let complete: Complete = openAiComplete;
let sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let schedule: Schedule = runAfterResponse;
export function setBotDepsForTests(deps: { complete?: Complete; sleep?: (ms: number) => Promise<void>; schedule?: Schedule } | null) {
  complete = deps?.complete ?? openAiComplete;
  sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  schedule = deps?.schedule ?? runAfterResponse;
}

/**
 * Called by /api/sms/inbound: answer this text after Twilio has its response
 * (next/server after()), so Twilio's 15-second webhook limit never matters.
 */
export function scheduleBotReply(phone: string, inboundId: number) {
  try {
    schedule(async () => { await runBotReply(phone, inboundId); });
  } catch (error) {
    console.error("SMS bot reply could not be scheduled:", error instanceof Error ? error.message : error);
  }
}

// ---------------------------------------------------------------------------
// Tools the model may call
// ---------------------------------------------------------------------------

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "check_service_zip",
      description: "Check whether a 5-digit ZIP is in the Den Defenders service area. Call only after the customer gave a ZIP.",
      parameters: {
        type: "object",
        properties: { zip: { type: "string", pattern: "^\\d{5}$" } },
        required: ["zip"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hand_off_to_team",
      description:
        "Flag this conversation 'Needs CSR' so a person takes over. After this you stop replying to this number; send one short final message. Use for the handoff cases in your instructions.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", enum: [...HANDOFF_REASONS] },
          summary: {
            type: "string",
            description:
              "2 to 4 plain sentences for the team: what they want, product/single-double/ZIP if known, price quoted and whether they accepted it, best number/time to call or preferred days, anything promised.",
          },
        },
        required: ["reason", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "record_outcome",
      description:
        "Record a lead outcome: price_accepted when they said on their own that the price works for them (never ask them to approve it); not_interested when they clearly declined the project.",
      parameters: {
        type: "object",
        properties: { outcome: { type: "string", enum: ["price_accepted", "not_interested"] } },
        required: ["outcome"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_customer_notes",
      description:
        "Save details the customer just told you so you never ask again. Fill only the fields with NEW information, in their words. Never guess.",
      parameters: {
        type: "object",
        properties: {
          first_name: { type: "string" },
          need: { type: "string", description: "What got them looking / what matters most (airflow, security, look, pets, a break-in...)" },
          product: { type: "string", description: "Security door, slider, window screens, VistaLuxe; style if said (full-view, decorative, wood)" },
          door_count: { type: "string", description: "Single, double, how many doors or windows" },
          style: { type: "string", description: "Color or look they want" },
          concerns: { type: "string", description: "Worries or objections they raised (price, HOA, timing...)" },
          timing: { type: "string" },
          decision_makers: { type: "string", description: "Only if they said someone else is involved" },
          preferred_days: { type: "string" },
          other: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_door_photos",
      description:
        "Attach 1 to 2 real installed photos of one style to THIS reply (one picture text). Use when they ask to see a style or photos, or right after you recommend a style. Write your reply as if the photos are attached, but only if this returns ok.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", enum: DOOR_PHOTO_CATEGORIES.map((c) => c.key) },
          variant: { type: "string", enum: ["single", "double"], description: "double for double / French doors" },
        },
        required: ["category"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_open_times",
      description:
        "Look up REAL open in-home consultation times near their ZIP (live calendar). Call when they want a consultation and you know the product and single/double (or how many). Offer only the times this returns.",
      parameters: {
        type: "object",
        properties: {
          zip: { type: "string", pattern: "^\\d{5}$" },
          product: { type: "string", description: "What they want, e.g. 'security door (Centurion)', 'sliding security door', 'window screens'" },
          door_count: { type: "string", description: "Single, double, or how many doors or windows" },
          weekdays: {
            type: "array",
            items: { type: "string", enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] },
            description: "Only days they asked for",
          },
          part_of_day: { type: "string", enum: ["morning", "afternoon", "any"] },
          dates: { type: "array", items: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, description: "Exact dates they asked for (YYYY-MM-DD)" },
        },
        required: ["zip", "product", "door_count"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "choose_time",
      description: "The customer picked one of the times find_open_times returned. Pass its option number (or its date).",
      parameters: {
        type: "object",
        properties: {
          option: { type: "integer", minimum: 1, maximum: 3 },
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_booking",
      description:
        "Pass the picked time to the team to book (you can't book). Call after choose_time, once you have their full name and street address, or they'd rather not text the address. Then send one short final message.",
      parameters: {
        type: "object",
        properties: {
          full_name: { type: "string", description: "First and last name, as they wrote it" },
          street_address: { type: "string", description: "Street address of the home (with city if given). Empty if they won't share it by text." },
          backup_option: { type: "integer", minimum: 1, maximum: 3, description: "Only if they said another offered time also works" },
        },
        required: ["full_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "record_opt_out",
      description:
        "The customer asked in their own words not to be texted or contacted anymore. Stops all texts to them and sends the standard confirmation. Write nothing else afterward.",
      parameters: { type: "object", properties: {} },
    },
  },
];

type ZipDirectory = Record<string, [string, string]>;
const SERVICE_ZIPS = salesZipDirectory as unknown as ZipDirectory;

export type ZipResult = "IN_AREA" | "IN_AREA_NV_TWO_DOOR_MINIMUM" | "NOT_SERVED" | "NEEDS_TEAM_CHECK";

/**
 * Nevada (Steven, 2026-10-26): Reno and Las Vegas only, 2-door minimum.
 * Henderson, North Las Vegas and Sparks go to the team; other NV cities aren't served.
 * Unknown ZIPs always go to the team (never a guessed yes or no).
 */
export function checkServiceZip(zip: string): { result: ZipResult; city?: string; state?: string } {
  const z = (zip || "").trim();
  const hit = /^\d{5}$/.test(z) ? SERVICE_ZIPS[z] : undefined;
  if (!hit) return { result: "NEEDS_TEAM_CHECK" };
  const [city, state] = hit;
  if (state.toUpperCase() === "NV") {
    const c = city.trim().toLowerCase();
    if (NV_SERVED_CITIES.has(c)) return { result: "IN_AREA_NV_TWO_DOOR_MINIMUM", city, state };
    if (NV_ASK_TEAM_CITIES.has(c)) return { result: "NEEDS_TEAM_CHECK", city, state };
    return { result: "NOT_SERVED", city, state };
  }
  return { result: "IN_AREA", city, state };
}

const ZIP_TOOL_ANSWER: Record<ZipResult, string> = {
  IN_AREA: "We serve this ZIP.",
  IN_AREA_NV_TWO_DOOR_MINIMUM: "We serve this ZIP, but Nevada projects need at least 2 doors. Follow the Nevada rule.",
  NOT_SERVED: "We don't serve this ZIP right now. Say so kindly and offer the office phone in case that changes. No handoff.",
  NEEDS_TEAM_CHECK: "Don't say yes or no. Say the team will double-check the ZIP and hand off with reason service_area_check.",
};

// ---------------------------------------------------------------------------
// Text clean-up
// ---------------------------------------------------------------------------

/** Openers Melanie's docs ban ("Great!", "Perfect!", "Got it."). */
const BANNED_OPENER = /^((great|good|perfect|awesome|excellent|nice|wonderful) (news|choice|question|pick|call)|great|perfect|awesome|excellent|love it|got it|absolutely)\s*[!.,]+\s*/i;

/**
 * Plain SMS text: no markdown, no dashes the docs ban, no emojis (they triple the cost),
 * no banned openers. Parts of a reply are kept apart with ONE blank line (Mike, 2026-10-27:
 * no run-on paragraphs), still sent as a single text.
 */
export function cleanSmsText(text: string): string {
  let out = (text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/(\d)[ \t]*[–—][ \t]*(\$?\d)/g, "$1 to $2")
    .replace(/[ \t]*[—–][ \t]*/g, ", ")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/[ \t]+/g, " ")
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  const opener = out.match(BANNED_OPENER);
  if (opener && out.length > opener[0].length + 10) {
    const rest = out.slice(opener[0].length);
    out = rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  if (out.length > MAX_REPLY_CHARS) {
    const cut = out.slice(0, MAX_REPLY_CHARS);
    let end = -1;
    for (const m of cut.matchAll(/[.?!](?=\s)/g)) end = m.index ?? end;
    out = end > 200 ? cut.slice(0, end + 1).trim() : cut.slice(0, Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"))).trim();
  }
  return dropRepeatedParagraphs(out).slice(0, MAX_BODY_CHARS);
}

function wordSet(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9']+/g) || []).filter((w) => w.length > 3));
}

/**
 * The AI sometimes says the same thing twice in one text ("Here are a couple…"
 * then "I've sent photos…"). Drop a paragraph that mostly repeats an earlier one.
 */
export function dropRepeatedParagraphs(text: string): string {
  const kept: Array<{ part: string; words: Set<string> }> = [];
  for (const part of text.split("\n\n")) {
    const words = wordSet(part);
    const repeat = words.size >= 4 && kept.some((k) => {
      let same = 0;
      for (const w of words) if (k.words.has(w)) same++;
      return same / Math.min(words.size, k.words.size) >= 0.6;
    });
    if (!repeat) kept.push({ part, words });
  }
  return kept.map((k) => k.part).join("\n\n");
}

/** "Here are a couple of Artisan doors we installed", "I've sent photos…": the reply says photos are attached. */
export function claimsPhotos(reply: string): boolean {
  if (/https?:\/\//i.test(reply)) return false;
  return /\b(here (are|is)|here's|i('ve| have)? sent|i'm sending|sending you|attached)\b[^.?!\n]{0,60}\b(photos?|pictures?|pics?|images?|examples?|installed)\b/i.test(reply)
    || /\b(photos?|pictures?|pics?)\b[^.?!\n]{0,30}\b(attached|sent)\b/i.test(reply);
}

/** Last resort: take out the photo claim and point to the gallery instead. */
function withoutPhotoClaim(reply: string): string {
  const parts = reply.split(/(?<=[.?!])\s+/).filter((s) => !claimsPhotos(s));
  return [parts.join(" ").trim(), `You can see installed doors in our gallery: ${COMPANY_FACTS.gallery}`].filter(Boolean).join("\n\n");
}

const INCLUSIONS = `That includes ${COMPANY_FACTS.doorInclusions}.`;

/** Range text without "around"/"starting" words, e.g. "$3,800 to $5,300". */
function bareRange(fact: string): string {
  const m = fact.match(/\$[\d,]+ to \$[\d,]+/);
  return m ? m[0] : fact;
}

/**
 * The FIRST door price quote in a thread must say what it includes (the AI kept
 * dropping it), so the code adds the short sentence when it's missing. Later
 * quotes are left alone: Mike's policy says don't repeat the price paragraph.
 */
export function ensurePriceInclusions(reply: string, priceAlreadyGiven = false): string {
  if (priceAlreadyGiven) return reply;
  const ranges = [bareRange(COMPANY_FACTS.perDoor), bareRange(COMPANY_FACTS.doubleDoor)];
  const at = ranges.map((r) => reply.indexOf(r)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (at === undefined || /includ\w*[^.?!]{0,40}(installation|hardware|tax)/i.test(reply)) return reply;
  const end = reply.slice(at).search(/[.?!](\s|$)/);
  if (end < 0) return `${reply.trim()}. ${INCLUSIONS}`;
  const cut = at + end + 1;
  return `${reply.slice(0, cut)} ${INCLUSIONS}${reply.slice(cut)}`.replace(/[ \t]+/g, " ").trim();
}

/**
 * Re-quoting a door price after it was already given: keep just the number
 * (Mike's policy: don't repeat the price paragraph). The AI kept re-sending the
 * whole thing, so code trims it. Only when the reply contains the price range,
 * so an answer to "what's included?" is left alone.
 */
export function trimRepeatedPrice(reply: string, priceAlreadyGiven: boolean): string {
  if (!priceAlreadyGiven || !/\$[\d,]+ to \$[\d,]+/.test(reply)) return reply;
  return reply
    .replace(/\s*That includes [^.?!]*[.?!]/gi, "")
    .replace(/,?\s*includ(?:ing|es)\s+(?:the\s+)?door,\s*hardware,\s*installation,?\s*and\s+tax/gi, "")
    .replace(/\s*Each one is custom-built for your entry\./gi, "")
    .replace(/[ \t]+([.,?!])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "A team member will text you…", "our team will call you" etc. */
export function promisesTeamFollowUp(reply: string): boolean {
  return /\b(team member|our team|the team|someone (from|on) (our|the) team|our specialist|a specialist|our office)\b[^.?!]{0,40}\b(will|'ll|is going to)\b[^.?!]{0,40}\b(text|call|reach out|contact|follow up|get back|send)/i.test(reply);
}

/** Did we already text them a price range (any "$x to $y")? */
export function priceAlreadyGiven(thread: ThreadMessage[]): boolean {
  return thread.some((m) => m.direction === "outbound" && /\$[\d,]+ to \$[\d,]+/.test(m.body));
}

/** Which of our links already went out in this thread (so the bot doesn't resend them). */
export function linksSent(thread: ThreadMessage[]): string[] {
  const links: Array<[string, string]> = [
    ["gallery link", COMPANY_FACTS.gallery],
    ["catalog link", COMPANY_FACTS.catalog],
    ["financing page link", COMPANY_FACTS.financingPage],
  ];
  const out = thread.filter((m) => m.direction === "outbound").map((m) => m.body).join(" ");
  return links.filter(([, url]) => out.includes(url.replace(/\/$/, ""))).map(([label]) => label);
}

/** One line of saved notes for the team's Slack alert. */
function notesLine(notes: Record<string, string>): string {
  // Code-only "_" keys (open times, photo file names) never go to the team.
  const text = teamNotesText(notes);
  return text ? `Notes: ${text}`.slice(0, 600) : "";
}

function todayPacific(now: Date): string {
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(now);
  // The AI answers any hour; real people text 8 AM - 7 PM. Tell the AI which it is right now.
  const team = teamIsTexting(now, DEFAULT_TIME_ZONE)
    ? `Our team (real people) texts customers ${TEAM_HOURS_TEXT} every day, and they're working now.`
    : `Our team (real people) texts customers ${TEAM_HOURS_TEXT} every day, and it's outside those hours now. If you hand off, say in your final message that a team member will text them after 8 AM.`;
  return `${date}. ${team}`;
}

/** After hours, a handoff goodbye must say when a person will answer (added by code if the AI didn't). */
export const AFTER_HOURS_HANDOFF_NOTE = `Our team texts between ${TEAM_HOURS_TEXT.replace(" to ", " and ")}, so expect a reply after 8 AM.`;

export function withAfterHoursNote(reply: string, now: Date, timeZone = DEFAULT_TIME_ZONE): string {
  if (teamIsTexting(now, timeZone) || /\b8(:00)?\s?(am|a\.m\.)/i.test(reply)) return reply;
  const longer = `${reply}\n\n${AFTER_HOURS_HANDOFF_NOTE}`;
  return longer.length <= MAX_BODY_CHARS ? longer : reply;
}

// ---------------------------------------------------------------------------
// Slack alert for handoffs (optional: SMS_SLACK_WEBHOOK_URL)
// ---------------------------------------------------------------------------

async function postHandoffToSlack(phone: string, reason: string, summary: string, notes: Record<string, string> = {}) {
  if (!slackAlertsEnabled()) return;
  const mention = await ownerMention(phone);
  const text = [
    `${pilotTag()}${mention}:raising_hand: *Texting: Needs CSR* - ${formatPhone(phone)}`,
    `Reason: ${reason.replace(/_/g, " ")}`,
    summary,
    notesLine(notes),
    `<${inboxLink(phone)}|Open in the Texting inbox>`,
  ].filter(Boolean).join("\n");
  await postSmsSlack(text);
}

// ---------------------------------------------------------------------------
// The brain: decide the reply (shared by real texting and the Simulator)
// ---------------------------------------------------------------------------

/**
 * Everything the brain does to the outside world goes through these hooks, so
 * the Simulator (/sms-sim) can run the exact same brain without touching
 * Twilio, the customer's real record or Slack.
 */
export type BotEffects = {
  /** Guardrail-log line (real) or a Simulator event. */
  log: (action: string, reason: string, detail?: Record<string, unknown>, actor?: string) => Promise<void>;
  saveNotes: (fresh: Record<string, string>) => Promise<void>;
  /**
   * auto = flagged by code (the AI promised a follow-up without handing off).
   * booking = the customer picked a real open time ("📅 Ready to book", step 4a).
   */
  handOff: (reason: string, summary: string, notes: Record<string, string>, auto: boolean, booking?: BookingRequest) => Promise<void>;
  outcome: (outcome: LeadStatus) => Promise<void>;
  /** Natural-language opt-out: record it and send the standard confirmation. */
  optOut: () => Promise<void>;
  /** The open-times lookup is slow: one short "checking our calendar" text (real) or an event (Simulator). */
  progress?: (text: string) => Promise<void>;
};

const NO_TIMES_MESSAGE =
  "No open times to offer. Don't invent any. Call hand_off_to_team with reason ready_to_book, with their product, ZIP and preferred days in the summary; final message: a team member will text them open times.";

/** "2026-11-01" in Pacific time (the lookup counter resets each day). */
function pacificDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: DEFAULT_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function cleanArg(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export type ComposeResult =
  | { kind: "reply"; reply: string; media: string[]; handedOff: { reason: string } | null; model: string }
  | { kind: "opted_out" }
  | { kind: "no_reply"; reason: string; handedOff: { reason: string } | null };

/**
 * Decide what the bot texts back to the newest text in `thread`.
 * No sending here: the caller sends (real) or shows it (Simulator).
 */
export async function composeBotReply(
  input: { thread: ThreadMessage[]; notes: Record<string, string>; now: Date },
  fx: BotEffects,
): Promise<ComposeResult> {
  const { thread } = input;
  const notes = { ...input.notes };
  const offered = openTimesFrom(notes);
  const picked = chosenTimeFrom(notes);
  const known: KnownAboutCustomer = {
    notes,
    priceAlreadyGiven: priceAlreadyGiven(thread),
    linksSent: linksSent(thread),
    openTimes: offered?.times.map((t) => `${t.n}. ${timeWords(t)}`),
    chosenTime: picked ? timeWords(picked) : undefined,
  };
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: smsBotSystemPrompt(todayPacific(input.now), known) },
  ];
  for (const m of thread) {
    const plural = m.mediaCount > 1 ? "s" : "";
    const photos = !m.mediaCount ? ""
      : m.direction === "inbound" ? ` [they sent ${m.mediaCount} photo${plural}; you can't view photos]`
      : ` [we sent ${m.mediaCount} door photo${plural}]`;
    const content = `${m.body}${photos}`.trim();
    if (!content) continue;
    messages.push({ role: m.direction === "inbound" ? "user" : "assistant", content });
  }
  if (messages[messages.length - 1]?.role !== "user") return { kind: "no_reply", reason: "nothing_to_answer", handedOff: null };

  let handedOff: { reason: string } | null = null;
  let reply = "";
  let media: string[] = [];
  let photoNudged = false;
  let bookingNudged = false;
  let usedModel = botModel();

  const saveZip = async (zip: string) => {
    const result = checkServiceZip(zip);
    await fx.log("bot_zip_check", result.result, { zip, city: result.city, state: result.state });
    const place = result.city ? ` ${result.city}, ${result.state}` : "";
    notes.zip = `${zip}${place}: ${result.result.toLowerCase().replace(/_/g, " ")}`;
    await fx.saveNotes({ zip: notes.zip });
    return result;
  };

  // --- Step 4a: real open times -------------------------------------------------
  const findOpenTimes = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const zip = cleanArg(args.zip, 5);
    if (!/^\d{5}$/.test(zip)) return { ok: false, error: "NEED_ZIP", message: "Ask for the 5-digit ZIP of the home first." };
    const area = await saveZip(zip);
    if (area.result === "NOT_SERVED" || area.result === "NEEDS_TEAM_CHECK") {
      return { ok: false, zipResult: area.result, message: ZIP_TOOL_ANSWER[area.result] };
    }
    const product = cleanArg(args.product, 120);
    const doorCount = cleanArg(args.door_count, 80);
    if (!product || !doorCount) {
      return { ok: false, error: "MISSING", message: "First find out the product and single or double (or how many). Ask only for the one that's missing." };
    }
    if (area.result === "IN_AREA_NV_TWO_DOOR_MINIMUM" && !hasTwoOrMoreDoors(doorCount)) {
      return { ok: false, error: "NEVADA_TWO_DOORS", message: "Nevada projects need at least two doors. Follow the Nevada rule; don't offer times." };
    }
    const fresh: Record<string, string> = {};
    if (!notes.product) fresh.product = product;
    if (!notes.door_count) fresh.door_count = doorCount;

    const today = pacificDate(input.now);
    const used = lookupsToday(notes, today);
    if (used >= MAX_LOOKUPS_PER_DAY) {
      await fx.log("bot_open_times", "lookup_limit", { used });
      return { ok: false, error: "LOOKUP_LIMIT", message: NO_TIMES_MESSAGE };
    }
    fresh[LOOKUPS_KEY] = `${today}:${used + 1}`;
    Object.assign(notes, fresh);
    await fx.saveNotes(fresh);

    const work = lookupOpenTimes({
      location: zip,
      ...partOfDay(args.part_of_day),
      requestedWeekdays: weekdaysArg(args.weekdays),
      requestedDates: datesArg(args.dates),
      maxOptions: 6,
    });
    if (fx.progress && await isSlow(work)) await fx.progress(CHECKING_TEXT);
    let found: Awaited<typeof work>;
    try {
      found = await work;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      console.error("SMS bot open-times lookup failed:", why);
      await fx.log("bot_open_times", "lookup_failed", { zip, error: why.slice(0, 200) });
      return { ok: false, error: "LOOKUP_FAILED", message: NO_TIMES_MESSAGE };
    }
    await fx.log("bot_open_times", found.status, { zip, count: found.options.length });
    if (found.status === "outside_service_area") {
      return { ok: false, error: "OUTSIDE_AREA", message: ZIP_TOOL_ANSWER.NEEDS_TEAM_CHECK };
    }
    if (!found.options.length) return { ok: false, error: "NO_TIMES", message: NO_TIMES_MESSAGE };

    const times: OfferedTime[] = found.options.slice(0, MAX_TIMES_OFFERED).map((o, i) => ({
      n: i + 1, date: o.date, weekday: o.weekday, window: o.arrivalWindow, rep: o.consultantName,
    }));
    const saved = { [OPEN_TIMES_KEY]: JSON.stringify({ zip, at: input.now.toISOString(), times }), [CHOSEN_TIME_KEY]: "none" };
    Object.assign(notes, saved);
    await fx.saveNotes(saved);
    return {
      ok: true,
      times: times.map((t) => ({ option: t.n, say: timeWords(t) })),
      mentionPriceFirst: !known.priceAlreadyGiven,
      message: `Offer these times, each on its own line, in these words, then ask which works best.${known.priceAlreadyGiven ? "" : " Price hasn't come up yet: start with the price range in one short line."} Never offer any other time and never say a time is held or booked.`,
    };
  };

  const chooseTime = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const open = openTimesFrom(notes);
    if (!open?.times.length) return { ok: false, error: "NO_TIMES_OFFERED", message: "Call find_open_times first; only offer times it returns." };
    const pick = matchOffered(open.times, args);
    if (!pick) {
      return { ok: false, error: "NOT_OFFERED", message: "That isn't one of the times you offered. Offer the listed times again, or call find_open_times with their new days. Never accept a time that wasn't offered." };
    }
    notes[CHOSEN_TIME_KEY] = JSON.stringify(pick);
    await fx.saveNotes({ [CHOSEN_TIME_KEY]: notes[CHOSEN_TIME_KEY] });
    await fx.log("bot_time_chosen", pick.date, { window: pick.window });
    return {
      ok: true,
      picked: timeWords(pick),
      message: "Saved. Unless you already have both, ask in one short text for their full name and the street address of the home. If you have both, call request_booking now. Don't say anything is booked, scheduled or confirmed.",
    };
  };

  const requestBooking = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const open = openTimesFrom(notes);
    const chosen = chosenTimeFrom(notes);
    if (!open || !chosen) return { ok: false, error: "NO_TIME_PICKED", message: "Ask which of the offered times works, then call choose_time." };
    const name = cleanArg(args.full_name, 80) || (notes.first_name || "");
    const address = cleanArg(args.street_address, 160);
    let slotCheck: SlotCheck = "zip_only";
    let rep = chosen.rep;
    if (address) {
      try {
        const slot = await checkTimeAtAddress(address.includes(open.zip) ? address : `${address}, ${open.zip}`, chosen.date, chosen.window);
        if (!slot) {
          notes[CHOSEN_TIME_KEY] = "none";
          await fx.saveNotes({ [CHOSEN_TIME_KEY]: "none" });
          await fx.log("bot_slot_gone", chosen.date, { window: chosen.window });
          return { ok: false, error: "SLOT_GONE", message: "That time just filled up for their address. Apologize briefly and offer the other times you listed (or call find_open_times again). Don't hand off and don't call request_booking until they pick again." };
        }
        slotCheck = "open_at_address";
        rep = slot.consultantName || rep;
      } catch (error) {
        console.error("SMS bot address re-check failed:", error instanceof Error ? error.message : error);
        slotCheck = "check_failed";
      }
    }
    const others = open.times.filter((t) => !(t.date === chosen.date && t.window === chosen.window));
    const saidOk = args.backup_option ? matchOffered(others, { option: args.backup_option }) : null;
    const backup = saidOk || others[0] || null;
    const area = checkServiceZip(open.zip);
    const booking: BookingRequest = {
      chosen: { date: chosen.date, weekday: chosen.weekday, window: chosen.window },
      backup: backup ? { date: backup.date, weekday: backup.weekday, window: backup.window, customerSaidOk: Boolean(saidOk) } : null,
      suggestedRep: rep,
      name: name || null,
      address: address || null,
      zip: open.zip,
      area: area.city ? `${area.city}, ${area.state}` : null,
      product: notes.product || null,
      doorCount: notes.door_count || null,
      slotCheck,
      requestedAt: input.now.toISOString(),
    };
    const summary = ["The customer picked a consultation time by text. Book it in ServiceTitan, then click \"Booked in ServiceTitan\".", ...bookingLines(booking, "", notes).filter((l) => !l.startsWith("Phone:"))].join("\n");
    await fx.handOff("ready_to_book", summary, notes, false, booking);
    handedOff = { reason: "ready_to_book" };
    return {
      ok: true,
      message: `Passed to the team. Now send one short final message: thank them and say you've passed ${timeWords(chosen)} to our team and a team member will text them shortly to finish setting it up. Never say booked, scheduled, confirmed, reserved or "see you".`,
    };
  };

  for (let round = 0; round < MAX_ROUNDS && !reply; round++) {
    const params = (model: string): CompletionParams => ({
      model,
      temperature: 0.3,
      max_completion_tokens: 300,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
    });
    let message: CompletionMessage | null;
    try {
      message = await complete(params(botModel()));
    } catch (error) {
      if (botModel() === FALLBACK_BOT_MODEL) throw error;
      const why = error instanceof Error ? error.message : String(error);
      console.warn(`SMS bot: ${botModel()} failed (${why}); using ${FALLBACK_BOT_MODEL}`);
      await fx.log("bot_model_fallback", botModel(), { error: why.slice(0, 200) });
      usedModel = FALLBACK_BOT_MODEL;
      message = await complete(params(FALLBACK_BOT_MODEL));
    }
    if (!message) break;
    messages.push(message);
    const calls = (message.tool_calls || []).filter((c) => c.type === "function");
    if (!calls.length) {
      reply = trimRepeatedPrice(ensurePriceInclusions(cleanSmsText(message.content || ""), known.priceAlreadyGiven), known.priceAlreadyGiven);
      // The AI said photos are attached but never attached any: one more try.
      if (!media.length && !photoNudged && round < MAX_ROUNDS - 1 && claimsPhotos(reply)) {
        photoNudged = true;
        await fx.log("bot_photo_claim_retry", "no_photos_attached", {}, "system");
        messages.push({
          role: "system",
          content: "Check (from the system, not the customer): your reply says photos are attached, but none are. If they want to see a style, call send_door_photos now and then write the reply. Otherwise rewrite the reply without mentioning photos.",
        });
        reply = "";
        continue;
      }
      // The AI can't book: never let it say something is booked, scheduled or confirmed.
      if (!bookingNudged && round < MAX_ROUNDS - 1 && claimsBooked(reply)) {
        bookingNudged = true;
        await fx.log("bot_booking_claim_retry", "said_booked", {}, "system");
        messages.push({
          role: "system",
          content: "Check (from the system, not the customer): your reply says something is booked, scheduled, confirmed or set. You can't book; only the team can. Rewrite it without saying that (for example: you've passed their time to the team and a team member will text them to finish setting it up).",
        });
        reply = "";
        continue;
      }
      break;
    }

    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
      const answer = (content: unknown) => messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(content) });
      const name = call.function.name;

      if (name === "check_service_zip") {
        const zip = String(args.zip || "");
        const result = await saveZip(zip);
        answer({ result: result.result, city: result.city, state: result.state, message: ZIP_TOOL_ANSWER[result.result] });
      } else if (name === "find_open_times") {
        answer(await findOpenTimes(args));
      } else if (name === "choose_time") {
        answer(await chooseTime(args));
      } else if (name === "request_booking") {
        if (handedOff) answer({ ok: false, message: "Already passed to the team. Write your final message." });
        else answer(await requestBooking(args));
      } else if (name === "hand_off_to_team") {
        const reason = HANDOFF_REASONS.includes(args.reason as HandoffReason) ? String(args.reason) : "question_for_team";
        const summary = String(args.summary || "").trim() || "No summary given.";
        await fx.handOff(reason, summary, notes, false);
        handedOff = { reason };
        answer({ ok: true, message: "Flagged for the team. Now write your one short final message (no promised call or text time)." });
      } else if (name === "send_door_photos") {
        const category = isCategory(args.category) ? args.category : null;
        const variant = args.variant === "double" ? "double" : "single";
        if (!category) {
          answer({ ok: false, message: "Unknown style." });
        } else if (media.length) {
          answer({ ok: false, message: "Photos are already attached to this reply." });
        } else {
          const sentBefore = (notes._photos_sent || "").split(",").map((x) => x.trim()).filter(Boolean);
          const pick = await pickDoorPhotos(category, variant, sentBefore);
          if (!pick.photos.length) {
            answer({ ok: false, message: "No photos of that style yet. Offer the gallery link instead and don't say photos are attached." });
          } else {
            media = pick.photos.map((p) => p.url);
            const label = DOOR_PHOTO_CATEGORIES.find((c) => c.key === category)?.label || category;
            const names = [...sentBefore, ...pick.photos.map((p) => doorPhotoName(p.pathname))].slice(-20);
            notes._photos_sent = names.join(",");
            notes.photos_sent = [notes.photos_sent, `${label} (${pick.variant})`].filter(Boolean).join("; ").slice(0, 200);
            await fx.saveNotes({ _photos_sent: notes._photos_sent, photos_sent: notes.photos_sent });
            await fx.log("bot_photos", `${category}/${pick.variant}`, { count: media.length });
            answer({
              ok: true,
              attached: media.length,
              message: pick.fellBackToSingle
                ? `Attached ${media.length} single-door photo(s); we don't have double-door photos of this style yet, so say these show the style on a single door.`
                : `Attached ${media.length} installed ${label} photo(s). Now write your reply.`,
            });
          }
        }
      } else if (name === "save_customer_notes") {
        const fresh: Record<string, string> = {};
        for (const [k, v] of Object.entries(args)) {
          if (typeof v === "string" && v.trim() && k !== "zip" && !k.startsWith("_") && k !== "photos_sent") fresh[k] = v.trim();
        }
        await fx.saveNotes(fresh);
        Object.assign(notes, fresh);
        answer({ ok: true, message: "Saved. Now write your reply." });
      } else if (name === "record_outcome") {
        const outcome = args.outcome === "not_interested" ? "not_interested" : args.outcome === "price_accepted" ? "price_accepted" : null;
        if (outcome) await fx.outcome(outcome);
        answer({ ok: Boolean(outcome) });
      } else if (name === "record_opt_out") {
        await fx.optOut();
        return { kind: "opted_out" };
      } else {
        answer({ error: "Unknown tool." });
      }
    }
  }

  if (!reply) {
    const reason = handedOff ? "handoff_without_message" : "empty_model_reply";
    await fx.log("bot_no_reply", reason, {});
    return { kind: "no_reply", reason, handedOff };
  }

  // Never tell them photos are attached when none are.
  if (!media.length && claimsPhotos(reply)) {
    await fx.log("bot_photo_claim_removed", "no_photos_attached", {}, "system");
    reply = withoutPhotoClaim(reply);
  }

  // Still says booked/scheduled/confirmed after the retry: code takes those sentences out.
  if (claimsBooked(reply)) {
    await fx.log("bot_booking_claim_removed", "said_booked", {}, "system");
    reply = withoutBookingClaim(reply) || SAFE_BOOKING_GOODBYE;
  }

  // Safety net: the AI told them the team will follow up but forgot to hand off.
  if (!handedOff && promisesTeamFollowUp(reply)) {
    const reason = /\b(times?|day|days|schedul|consultation|appointment)\b/i.test(reply) ? "ready_to_book" : "question_for_team";
    const lastText = [...thread].reverse().find((m) => m.direction === "inbound")?.body || "";
    const summary = [
      "Flagged by code: the AI told the customer our team will follow up but didn't hand off.",
      lastText ? `Their last text: "${lastText.slice(0, 200)}".` : "",
      notesLine(notes),
    ].filter(Boolean).join(" ");
    await fx.handOff(reason, summary, notes, true);
    handedOff = { reason };
  }

  // After hours (7 PM - 8 AM), tell them when a person will pick this up.
  if (handedOff) {
    const withNote = withAfterHoursNote(reply, input.now);
    if (withNote !== reply) {
      await fx.log("bot_after_hours_note", "added", {}, "system");
      reply = withNote;
    }
  }

  return { kind: "reply", reply, media, handedOff, model: usedModel };
}

// ---------------------------------------------------------------------------
// The real reply (texts to the pilot number)
// ---------------------------------------------------------------------------

export type BotRunResult =
  | { status: "sent"; result: SendResult }
  | { status: "not_sent"; result: SendResult }
  | { status: "skipped"; reason: string }
  | { status: "opted_out" }
  | { status: "error"; message: string };

async function skip(phone: string, reason: string, inboundId: number, logIt = true): Promise<BotRunResult> {
  if (logIt) await audit({ phone, action: "bot_skipped", reason, detail: { inboundId }, actor: "denny-ai" });
  return { status: "skipped", reason };
}

/** The real hooks: guardrail log, the customer's record, Slack, opt-out confirmation. */
function liveEffects(phone: string, inboundId: number): BotEffects {
  return {
    log: (action, reason, detail = {}, actor = "denny-ai") => audit({ phone, action, reason, detail: { inboundId, ...detail }, actor }),
    saveNotes: (fresh) => saveCustomerNotes(phone, fresh),
    handOff: async (reason, summary, notes, auto, booking) => {
      await setHandoff(phone, reason, summary, smsNow());
      if (booking) {
        await saveBookingRequest(phone, booking);
        if (booking.name) await nameContactIfEmpty(phone, booking.name);
        // They asked for a time, so an old "not interested" no longer applies.
        await clearLeadStatus(phone);
      }
      await audit({
        phone,
        action: "bot_handoff",
        reason,
        detail: auto ? { summary, inboundId, auto: true } : { summary: summary.slice(0, 500), inboundId, booking: Boolean(booking) },
        actor: auto ? "system" : "denny-ai",
      });
      // "📅 Ready to book" gets its own alert (@here when nobody owns the customer yet).
      if (booking) await postReadyToBookAlert(phone, booking, notes);
      else await postHandoffToSlack(phone, reason, summary, notes);
    },
    progress: async (text) => {
      // A person took over while the AI was looking: say nothing.
      if ((await conversationState(phone)).botStatus === "paused") return;
      const sent = await sendSms({ to: phone, body: text, kind: "reply", purpose: "care", sentBy: CHECKING_SENDER });
      await audit({ phone, action: "checking_text", reason: sent.ok ? "sent" : `blocked:${sent.reason}`, detail: { inboundId }, actor: "denny-ai" });
    },
    outcome: async (outcome) => {
      await setLeadStatus(phone, outcome, smsNow());
      await audit({ phone, action: "bot_outcome", reason: outcome, detail: { inboundId }, actor: "denny-ai" });
    },
    optOut: async () => {
      await recordOptOut(phone, "ai_detected", null, smsNow());
      await audit({ phone, action: "opt_out", reason: "ai_detected", detail: { inboundId }, actor: "denny-ai" });
      const confirmation = await sendOptOutConfirmation(phone);
      if (!confirmation.ok) console.warn("SMS AI opt-out confirmation not sent:", confirmation.reason);
    },
  };
}

/** Answer the text with id `inboundId` from `phone` (if it's still their newest one). */
export async function runBotReply(phone: string, inboundId: number): Promise<BotRunResult> {
  try {
    if (!botEnabled()) return skip(phone, "bot_off", inboundId);

    await sleep(debounceMs());
    if (await latestInboundId(phone) !== inboundId) return skip(phone, "newer_text_will_answer", inboundId, false);

    // Cheap checks first, so blocked texts never cost an OpenAI call.
    if (!sendingEnabled()) return skip(phone, "sending_disabled", inboundId);
    const allowed = allowList();
    if (!allowed.everyone && !allowed.numbers.includes(phone)) return skip(phone, "not_on_allow_list", inboundId);
    if (await findOptOut(phone)) return skip(phone, "opted_out", inboundId);
    const state = await conversationState(phone);
    if (state.botStatus === "paused") return skip(phone, `handed_off:${state.handoffReason || "team"}`, inboundId);
    const contact = await ensureContact(phone);
    if (!withinSendingHours("reply", localTime(smsNow(), contact.timeZone))) return skip(phone, "outside_reply_hours", inboundId);
    const capHit = await checkCaps(phone, "reply");
    if (capHit) return skip(phone, capHit.reason, inboundId);

    const thread = await threadForBot(phone, 40);
    const composed = await composeBotReply({ thread, notes: state.customerNotes, now: smsNow() }, liveEffects(phone, inboundId));
    if (composed.kind === "opted_out") return { status: "opted_out" };
    if (composed.kind === "no_reply") {
      if (composed.reason === "nothing_to_answer") return skip(phone, "nothing_to_answer", inboundId);
      return { status: "skipped", reason: "empty_model_reply" };
    }
    const { reply, media, handedOff } = composed;

    // Last look before sending: a newer text (that run answers it) or a reply already sent.
    // A handoff's final message always goes out: the newer texts' runs are paused by the handoff.
    if (!handedOff) {
      if (await latestInboundId(phone) !== inboundId) return skip(phone, "newer_text_will_answer", inboundId, false);
      if (await outboundSinceMessage(phone, inboundId)) return skip(phone, "already_answered", inboundId);
      // A person took over in the Texting inbox while the AI was thinking.
      if ((await conversationState(phone)).botStatus === "paused") return skip(phone, "person_took_over", inboundId);
    }

    const result = await sendSms({ to: phone, body: reply, kind: "reply", purpose: "care", sentBy: "denny-ai", mediaUrls: media });
    await audit({
      phone,
      action: "bot_reply",
      reason: `policy ${CUSTOMER_POLICY_VERSION}`,
      detail: { inboundId, policyVersion: CUSTOMER_POLICY_VERSION, model: composed.model, sent: result.ok, photos: media.length },
      actor: "denny-ai",
    });
    return result.ok ? { status: "sent", result } : { status: "not_sent", result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("SMS bot reply failed:", message);
    await audit({ phone, action: "bot_error", reason: message.slice(0, 120), detail: { inboundId }, actor: "denny-ai" });
    return { status: "error", message };
  }
}

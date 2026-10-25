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
 *      handed off to the team, or outside reply hours (8 AM - 7 PM their time)
 *   3. read the last 40 texts, ask OpenAI for one reply (tools: ZIP check, handoff, outcome, opt-out)
 *   4. send it through THE send helper (lib/sms/send.ts) as kind "reply", so every
 *      guardrail still applies: opt-outs, allow-list, 24-hour window, hours, caps
 *
 * Handoffs ("Needs CSR") pause the bot for that number until an owner turns it
 * back on at /sms-test. The Texting inbox (step 3) will show them too.
 */
import { after } from "next/server";
import OpenAI from "openai";
import salesZipDirectory from "@/app/lib/salesZipDirectory.json";
import { SMS_BOT_FACTS, smsBotSystemPrompt } from "@/lib/sms/botPrompt";
import { MAX_BODY_CHARS, formatPhone, localTime, withinSendingHours } from "@/lib/sms/rules";
import { allowList, checkCaps, sendOptOutConfirmation, sendSms, sendingEnabled, smsNow, type SendResult } from "@/lib/sms/send";
import {
  audit,
  conversationState,
  ensureContact,
  findOptOut,
  latestInboundId,
  outboundSinceMessage,
  recordOptOut,
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
const MAX_ROUNDS = 4;

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
        "Record a lead outcome: price_accepted when they clearly said the quoted range works; not_interested when they clearly declined the project.",
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
      name: "record_opt_out",
      description:
        "The customer asked in their own words not to be texted or contacted anymore. Stops all texts to them and sends the standard confirmation. Write nothing else afterward.",
      parameters: { type: "object", properties: {} },
    },
  },
];

type ZipDirectory = Record<string, [string, string]>;
const SERVICE_ZIPS = salesZipDirectory as unknown as ZipDirectory;
/**
 * States in the sales ZIP list that Melanie's SERVICE AREA v1.3 says we don't serve.
 * Until Mike confirms, the bot never says yes for these; the team checks.
 */
const TEAM_CHECK_STATES = new Set(["NV"]);

export function checkServiceZip(zip: string): { result: "IN_AREA" | "NEEDS_TEAM_CHECK"; city?: string; state?: string } {
  const z = (zip || "").trim();
  const hit = /^\d{5}$/.test(z) ? SERVICE_ZIPS[z] : undefined;
  if (!hit) return { result: "NEEDS_TEAM_CHECK" };
  if (TEAM_CHECK_STATES.has(hit[1].toUpperCase())) return { result: "NEEDS_TEAM_CHECK", city: hit[0], state: hit[1] };
  return { result: "IN_AREA", city: hit[0], state: hit[1] };
}

// ---------------------------------------------------------------------------
// Text clean-up
// ---------------------------------------------------------------------------

/** Openers Melanie's docs ban ("Great!", "Perfect!", "Got it."). */
const BANNED_OPENER = /^((great|good|perfect|awesome|excellent|nice|wonderful) (news|choice|question|pick|call)|great|perfect|awesome|excellent|love it|got it|absolutely)\s*[!.,]+\s*/i;

/** Plain SMS text: no markdown, no dashes the docs ban, no emojis (they triple the cost), no banned openers. */
export function cleanSmsText(text: string): string {
  let out = (text || "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/(\d)\s*[–—]\s*(\$?\d)/g, "$1 to $2")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .trim();
  const opener = out.match(BANNED_OPENER);
  if (opener && out.length > opener[0].length + 10) {
    const rest = out.slice(opener[0].length);
    out = rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  if (out.length > MAX_REPLY_CHARS) {
    const cut = out.slice(0, MAX_REPLY_CHARS);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    out = end > 200 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(" ")).trim();
  }
  return out.slice(0, MAX_BODY_CHARS);
}

const INCLUSIONS =
  "That includes installation, hardware, tax, upgrades, a 10-year workmanship warranty and our Lifetime No Break-In Guarantee.";

/** Range text without "around"/"starting" words, e.g. "$3,700 to $5,300". */
function bareRange(fact: string): string {
  const m = fact.match(/\$[\d,]+ to \$[\d,]+/);
  return m ? m[0] : fact;
}

/**
 * Single/double security door quotes must carry the inclusions (Melanie's PRICING rules).
 * The AI kept shortening them, so the code adds the sentence when it's missing.
 */
export function ensurePriceInclusions(reply: string): string {
  const ranges = [bareRange(SMS_BOT_FACTS.singleDoor), bareRange(SMS_BOT_FACTS.doubleDoor)];
  const at = ranges.map((r) => reply.indexOf(r)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (at === undefined || /includ\w*[^.?!]{0,40}(installation|hardware|tax)/i.test(reply)) return reply;
  const end = reply.slice(at).search(/[.?!](\s|$)/);
  if (end < 0) return `${reply.trim()}. ${INCLUSIONS}`;
  const cut = at + end + 1;
  return `${reply.slice(0, cut)} ${INCLUSIONS}${reply.slice(cut)}`.replace(/\s+/g, " ").trim();
}

/** "A team member will text you…", "our team will call you" etc. */
export function promisesTeamFollowUp(reply: string): boolean {
  return /\b(team member|our team|the team|someone (from|on) (our|the) team|our specialist|a specialist|our office)\b[^.?!]{0,40}\b(will|'ll|is going to)\b[^.?!]{0,40}\b(text|call|reach out|contact|follow up|get back|send)/i.test(reply);
}

const YES = /^(yes|yeah|yep|yup|sure|ok|okay|sounds good|that works|works for me|it works|that's fine|thats fine|fine|absolutely|definitely|of course|correct|y)\b/i;

/** Their newest text is a yes, and our text right before it asked whether the price works. */
export function saidYesToPrice(thread: ThreadMessage[]): boolean {
  const last = thread[thread.length - 1];
  if (!last || last.direction !== "inbound" || !YES.test(last.body.trim())) return false;
  for (let i = thread.length - 2; i >= 0; i--) {
    if (thread[i].direction === "outbound") {
      const b = thread[i].body;
      return /\$[\d,]+/.test(b) && /(price|range|budget)[^?]{0,60}(work|fit|okay|ok)\b/i.test(b);
    }
  }
  return false;
}

function todayPacific(now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  }).format(now);
}

// ---------------------------------------------------------------------------
// Slack alert for handoffs (optional: SMS_SLACK_WEBHOOK_URL)
// ---------------------------------------------------------------------------

async function postHandoffToSlack(phone: string, reason: string, summary: string) {
  const url = (process.env.SMS_SLACK_WEBHOOK_URL || "").trim();
  if (!url) return;
  const pilot = !allowList().everyone;
  const text = [
    `${pilot ? "[PILOT] " : ""}:raising_hand: *Texting: Needs CSR* - ${formatPhone(phone)}`,
    `Reason: ${reason.replace(/_/g, " ")}`,
    summary,
  ].join("\n");
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  } catch (error) {
    console.error("SMS handoff Slack post failed:", error instanceof Error ? error.message : error);
  }
}

// ---------------------------------------------------------------------------
// The reply
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

    // A "yes" right after our price question = price accepted (recorded by code, not left to the AI).
    if (state.leadStatus !== "price_accepted" && saidYesToPrice(thread)) {
      await setLeadStatus(phone, "price_accepted", smsNow());
      await audit({ phone, action: "bot_outcome", reason: "price_accepted", detail: { inboundId, by: "code" }, actor: "system" });
    }
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: smsBotSystemPrompt(todayPacific(smsNow())) },
    ];
    for (const m of thread) {
      const photos = m.mediaCount ? ` [sent ${m.mediaCount} photo${m.mediaCount > 1 ? "s" : ""}; you can't view photos]` : "";
      const content = `${m.body}${photos}`.trim();
      if (!content) continue;
      messages.push({ role: m.direction === "inbound" ? "user" : "assistant", content });
    }
    if (messages[messages.length - 1]?.role !== "user") return skip(phone, "nothing_to_answer", inboundId);

    let handedOff: { reason: string } | null = null;
    let reply = "";

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
        await audit({ phone, action: "bot_model_fallback", reason: botModel(), detail: { error: why.slice(0, 200) }, actor: "denny-ai" });
        message = await complete(params(FALLBACK_BOT_MODEL));
      }
      if (!message) break;
      messages.push(message);
      const calls = (message.tool_calls || []).filter((c) => c.type === "function");
      if (!calls.length) {
        reply = ensurePriceInclusions(cleanSmsText(message.content || ""));
        break;
      }

      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
        const answer = (content: unknown) => messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(content) });
        const name = call.function.name;

        if (name === "check_service_zip") {
          const zip = String(args.zip || "");
          const result = checkServiceZip(zip);
          await audit({ phone, action: "bot_zip_check", reason: result.result, detail: { zip, city: result.city, state: result.state }, actor: "denny-ai" });
          answer(result.result === "IN_AREA"
            ? { result: "IN_AREA", city: result.city, state: result.state }
            : { result: "NEEDS_TEAM_CHECK", message: "Don't say yes or no. Say the team will double-check the ZIP and hand off with reason service_area_check." });
        } else if (name === "hand_off_to_team") {
          const reason = HANDOFF_REASONS.includes(args.reason as HandoffReason) ? String(args.reason) : "question_for_team";
          const summary = String(args.summary || "").trim() || "No summary given.";
          await setHandoff(phone, reason, summary, smsNow());
          await audit({ phone, action: "bot_handoff", reason, detail: { summary: summary.slice(0, 500), inboundId }, actor: "denny-ai" });
          await postHandoffToSlack(phone, reason, summary);
          handedOff = { reason };
          answer({ ok: true, message: "Flagged for the team. Now write your one short final message (no promised call or text time)." });
        } else if (name === "record_outcome") {
          const outcome = args.outcome === "not_interested" ? "not_interested" : args.outcome === "price_accepted" ? "price_accepted" : null;
          if (outcome) {
            await setLeadStatus(phone, outcome as LeadStatus, smsNow());
            await audit({ phone, action: "bot_outcome", reason: outcome, detail: { inboundId }, actor: "denny-ai" });
          }
          answer({ ok: Boolean(outcome) });
        } else if (name === "record_opt_out") {
          await recordOptOut(phone, "ai_detected", null, smsNow());
          await audit({ phone, action: "opt_out", reason: "ai_detected", detail: { inboundId }, actor: "denny-ai" });
          const confirmation = await sendOptOutConfirmation(phone);
          if (!confirmation.ok) console.warn("SMS AI opt-out confirmation not sent:", confirmation.reason);
          return { status: "opted_out" };
        } else {
          answer({ error: "Unknown tool." });
        }
      }
    }

    if (!reply) {
      await audit({ phone, action: "bot_no_reply", reason: handedOff ? "handoff_without_message" : "empty_model_reply", detail: { inboundId }, actor: "denny-ai" });
      return { status: "skipped", reason: "empty_model_reply" };
    }

    // Safety net: the AI told them the team will follow up but forgot to hand off.
    if (!handedOff && promisesTeamFollowUp(reply)) {
      const reason = /\b(times?|day|days|schedul|consultation|appointment)\b/i.test(reply) ? "ready_to_book" : "question_for_team";
      const summary = "Flagged by code: the AI told the customer our team will follow up but didn't hand off. Read the thread.";
      await setHandoff(phone, reason, summary, smsNow());
      await audit({ phone, action: "bot_handoff", reason, detail: { summary, inboundId, auto: true }, actor: "system" });
      await postHandoffToSlack(phone, reason, summary);
      handedOff = { reason };
    }

    // Last look before sending: a newer text (that run answers it) or a reply already sent.
    // A handoff's final message always goes out: the newer texts' runs are paused by the handoff.
    if (!handedOff) {
      if (await latestInboundId(phone) !== inboundId) return skip(phone, "newer_text_will_answer", inboundId, false);
      if (await outboundSinceMessage(phone, inboundId)) return skip(phone, "already_answered", inboundId);
    }

    const result = await sendSms({ to: phone, body: reply, kind: "reply", purpose: "care", sentBy: "denny-ai" });
    return result.ok ? { status: "sent", result } : { status: "not_sent", result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("SMS bot reply failed:", message);
    await audit({ phone, action: "bot_error", reason: message.slice(0, 120), detail: { inboundId }, actor: "denny-ai" });
    return { status: "error", message };
  }
}

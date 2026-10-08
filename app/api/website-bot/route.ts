/**
 * app/api/website-bot/route.ts
 *
 * Public chat endpoint behind the dendefenders.com chat bubble (Phase 1).
 *
 *   - No login. proxy.ts lets this path through; everything else on Denny
 *     still requires Auth0.
 *   - Only accepts requests from the websites in WEBSITE_BOT_ALLOWED_ORIGINS.
 *   - Off unless WEBSITE_BOT_ENABLED=true (the kill switch).
 *   - One tool: find_open_times -> recommend_sales_schedule, reduced to
 *     dates and arrival windows before the model sees it.
 *   - No booking, no customer lookups, no ServiceTitan writes.
 */
import OpenAI from "openai";
import { NextResponse } from "next/server";
import { websiteBotSystemPrompt } from "@/app/lib/websiteBotPrompt";
import {
  allowLookup,
  allowMessage,
  clientIp,
  corsHeaders,
  originAllowed,
  websiteBotEnabled,
} from "@/lib/websiteBotGuard";
import { findOpenSalesTimes, WebsiteBotConfigError } from "@/lib/websiteBotMcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 1000;
const MODEL = process.env.WEBSITE_BOT_MODEL || "gpt-4o-mini";

type ChatMessage = { role: "user" | "assistant"; content: string };

function json(body: unknown, status: number, origin: string | null) {
  return NextResponse.json(body, { status, headers: corsHeaders(origin) });
}

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  if (!originAllowed(origin)) return new NextResponse(null, { status: 403 });
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

function todayPacific(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date());
}

function cleanMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const item of raw.slice(-MAX_MESSAGES)) {
    const role = item?.role === "assistant" ? "assistant" : item?.role === "user" ? "user" : null;
    const content = typeof item?.content === "string" ? item.content.trim().slice(0, MAX_MESSAGE_CHARS) : "";
    if (role && content) out.push({ role, content });
  }
  return out;
}

const FIND_OPEN_TIMES_TOOL = {
  type: "function" as const,
  function: {
    name: "find_open_times",
    description:
      "Look up open in-home consultation times near the visitor's ZIP code. Call only after the visitor has given a 5-digit ZIP. Returns dates with arrival windows.",
    parameters: {
      type: "object",
      properties: {
        zip: { type: "string", description: "Visitor's 5-digit ZIP code.", pattern: "^\\d{5}$" },
        earliestStartTime: {
          type: "string",
          description: "Optional earliest acceptable start, 24-hour HH:mm (e.g. 13:00 for 'afternoons').",
        },
        latestStartTime: {
          type: "string",
          description: "Optional latest acceptable start, 24-hour HH:mm (e.g. 11:00 for 'mornings').",
        },
        requestedWeekdays: {
          type: "array",
          items: { type: "string", enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] },
          description: "Optional weekdays the visitor asked for.",
        },
        requestedDates: {
          type: "array",
          items: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          description: "Optional exact dates the visitor asked for (YYYY-MM-DD).",
        },
      },
      required: ["zip"],
    },
  },
};

export async function POST(req: Request) {
  const origin = req.headers.get("origin");

  if (!originAllowed(origin)) {
    return json({ error: "This chat can only be used from the Den Defenders website." }, 403, origin);
  }
  if (!websiteBotEnabled()) {
    return json({ error: "The chat assistant is offline right now. Please give us a call." }, 503, origin);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Website bot: OPENAI_API_KEY missing");
    return json({ error: "The chat assistant is not set up yet." }, 500, origin);
  }

  const body = await req.json().catch(() => ({}));
  const sessionId = typeof body?.sessionId === "string" && /^[a-z0-9]{8,64}$/i.test(body.sessionId)
    ? body.sessionId
    : "anon";
  const testMode = body?.mode === "test";
  const messages = cleanMessages(body?.messages);

  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return json({ error: "Missing message." }, 400, origin);
  }

  const ip = clientIp(req.headers);
  if (!allowMessage(sessionId, ip)) {
    return json(
      { error: "You've sent a lot of messages. Please give us a call and we'll be glad to help." },
      429,
      origin
    );
  }

  const openai = new OpenAI({ apiKey });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const thread: any[] = [
    { role: "system", content: websiteBotSystemPrompt(todayPacific(), testMode) },
    ...messages,
  ];

  try {
    for (let round = 0; round < 4; round++) {
      const completion = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0.3,
        max_tokens: 400,
        messages: thread,
        tools: [FIND_OPEN_TIMES_TOOL],
        tool_choice: "auto",
      });

      const message = completion.choices?.[0]?.message;
      if (!message) {
        return json({ error: "No reply. Please try again." }, 502, origin);
      }
      thread.push(message);

      const toolCalls = message.tool_calls || [];
      if (!toolCalls.length) {
        const reply = message.content?.trim();
        return json({ reply: reply || "Sorry, could you say that again?" }, 200, origin);
      }

      for (const call of toolCalls) {
        if (call.type !== "function") continue;

        if (call.function.name !== "find_open_times") {
          thread.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "TOOL_NOT_AVAILABLE" }) });
          continue;
        }

        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }

        const zip = typeof args.zip === "string" ? args.zip.trim() : "";
        if (!/^\d{5}$/.test(zip)) {
          thread.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "NEED_ZIP", message: "Ask the visitor for a 5-digit ZIP code first." }) });
          continue;
        }

        if (!allowLookup(sessionId)) {
          thread.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "LOOKUP_LIMIT", message: "Availability lookups are limited per chat. Offer the phone number." }) });
          continue;
        }

        const startedAt = Date.now();
        try {
          const availability = await findOpenSalesTimes({
            location: zip,
            earliestStartTime: timeArg(args.earliestStartTime),
            latestStartTime: timeArg(args.latestStartTime),
            requestedWeekdays: stringArray(args.requestedWeekdays),
            requestedDates: stringArray(args.requestedDates),
            maxOptions: 3,
          });
          console.info(`Website bot availability for ${zip} (${availability.status}, ${availability.options.length}) in ${Date.now() - startedAt} ms`);
          thread.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(availability) });
        } catch (error) {
          const configProblem = error instanceof WebsiteBotConfigError;
          console.error("Website bot availability failed:", error instanceof Error ? error.message : error);
          thread.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({
              error: configProblem ? "NOT_CONFIGURED" : "LOOKUP_FAILED",
              message: "Availability could not be checked right now. Apologize briefly and offer the phone number.",
            }),
          });
        }
      }
    }

    return json({ reply: "Let me get a team member to help with that. Please give us a call and we'll sort it out." }, 200, origin);
  } catch (error) {
    console.error("Website bot crashed:", error instanceof Error ? error.message : error);
    return json({ error: "Sorry, something went wrong on our side. Please try again in a moment." }, 500, origin);
  }
}

function timeArg(value: unknown): string | undefined {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string" && item.length < 20);
  return out.length ? out.slice(0, 10) : undefined;
}

/**
 * /api/sms/sim — the texting Simulator, owners only (proxy.ts + the check below).
 *   GET                                  -> scenarios + recent saved runs (the test log)
 *   POST {action:"turn", ...}            -> one customer text + the real bot's reply (nothing is texted)
 *   POST {action:"save_run", run}        -> save a finished run to the log
 *   POST {action:"delete_run", id}
 *   POST {action:"save_scenario", scenario} / {action:"delete_scenario", id}
 *
 * One turn per request, so a long scenario never hits a time limit.
 */
import { NextResponse } from "next/server";
import { getCurrentAccess } from "@/lib/currentAccess";
import { botModel } from "@/lib/sms/bot";
import {
  customerModel,
  deleteRun,
  deleteScenario,
  listScenarios,
  recentRuns,
  saveRun,
  saveScenario,
  simulateTurn,
  type SimEvent,
  type SimMessage,
  type SimScenario,
} from "@/lib/sms/simulator";
import { smsDatabaseConfigured } from "@/lib/sms/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "private, no-store" };

async function requireOwner() {
  const access = await getCurrentAccess();
  return access?.role === "owner" ? access : null;
}

function asTranscript(value: unknown): SimMessage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-60).map((m) => ({
    from: m?.from === "bot" ? "bot" : "customer",
    text: String(m?.text ?? "").slice(0, 1000),
    media: Array.isArray(m?.media) ? m.media.slice(0, 3).map(String) : undefined,
  })).filter((m) => m.text) as SimMessage[];
}

function asNotes(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
    if (typeof v === "string" && v.trim()) out[k.slice(0, 40)] = v.slice(0, 300);
  }
  return out;
}

function asScenario(value: unknown): SimScenario {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    name: String(v.name || "Chat yourself").slice(0, 80),
    persona: String(v.persona || "A homeowner texting about security screen doors.").slice(0, 1500),
    opening: String(v.opening || "").slice(0, 600),
    maxTurns: 15,
  };
}

export async function GET() {
  if (!await requireOwner()) return NextResponse.json({ error: "Owners only." }, { status: 403, headers: NO_STORE });
  const settings = { botModel: botModel(), customerModel: customerModel(), openAiConfigured: Boolean(process.env.OPENAI_API_KEY) };
  if (!smsDatabaseConfigured()) return NextResponse.json({ settings, scenarios: [], runs: [], error: "Texting database isn't set up." }, { headers: NO_STORE });
  try {
    const [scenarios, runs] = await Promise.all([listScenarios(), recentRuns(50)]);
    return NextResponse.json({ settings, scenarios, runs }, { headers: NO_STORE });
  } catch (error) {
    console.error("SMS sim GET failed:", error);
    return NextResponse.json({ settings, scenarios: [], runs: [], error: "Could not load the Simulator." }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  const access = await requireOwner();
  if (!access) return NextResponse.json({ error: "Owners only." }, { status: 403, headers: NO_STORE });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
  const by = access.email || "owner";

  try {
    if (body.action === "turn") {
      const transcript = asTranscript(body.transcript);
      if (transcript.length >= 40) return NextResponse.json({ error: "This conversation is long enough. Save it and start a new one." }, { status: 400, headers: NO_STORE });
      const result = await simulateTurn({
        scenario: asScenario(body.scenario),
        transcript,
        notes: asNotes(body.notes),
        customerText: typeof body.customerText === "string" ? body.customerText.slice(0, 600) : undefined,
      });
      return NextResponse.json(result, { headers: NO_STORE });
    }

    if (body.action === "save_run") {
      const run = (body.run && typeof body.run === "object" ? body.run : {}) as Record<string, unknown>;
      const transcript = asTranscript(run.transcript);
      if (!transcript.length) return NextResponse.json({ error: "Nothing to save." }, { status: 400, headers: NO_STORE });
      const events = Array.isArray(run.events)
        ? (run.events as SimEvent[]).slice(0, 200).map((e) => ({ turn: Number(e?.turn) || 0, type: String(e?.type || "").slice(0, 20), text: String(e?.text || "").slice(0, 600) }))
        : [];
      const id = await saveRun({
        name: String(run.name || "Chat yourself"),
        persona: String(run.persona || ""),
        mode: run.mode === "manual" ? "manual" : "auto",
        transcript,
        events,
        notes: asNotes(run.notes),
        endReason: typeof run.endReason === "string" ? run.endReason : null,
        model: String(run.model || botModel()),
      }, by);
      return NextResponse.json({ ok: true, id }, { headers: NO_STORE });
    }

    if (body.action === "delete_run") {
      return NextResponse.json({ ok: await deleteRun(Number(body.id)) }, { headers: NO_STORE });
    }

    if (body.action === "save_scenario") {
      const saved = await saveScenario((body.scenario || {}) as Partial<SimScenario>, by);
      if (!saved) return NextResponse.json({ error: "A scenario needs a name and a description of the customer." }, { status: 400, headers: NO_STORE });
      return NextResponse.json({ ok: true, scenario: saved }, { headers: NO_STORE });
    }

    if (body.action === "delete_scenario") {
      return NextResponse.json({ ok: await deleteScenario(Number(body.id)) }, { headers: NO_STORE });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400, headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("SMS sim failed:", message);
    return NextResponse.json({ error: `Something went wrong: ${message.slice(0, 200)}` }, { status: 500, headers: NO_STORE });
  }
}

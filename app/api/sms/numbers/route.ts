/**
 * /api/sms/numbers — Session 8 PR 2, owners only (proxy.ts rule + the check below).
 *   GET                                   -> our numbers, ad sets, Twilio service check, recent picks
 *   POST {action:"save", numbers, adSets}  -> replace the setup (checked first; nothing saved on a problem)
 *   POST {action:"test", adSet, zip, phone} -> which number would this lead get? (nothing saved)
 *   POST {action:"hatch_check", phone}      -> PR 2b: would the Hatch guard hold this lead? (read-only)
 */
import { NextResponse } from "next/server";
import { getCurrentAccess } from "@/lib/currentAccess";
import {
  listAdSets,
  listNumbers,
  pickFrom,
  recentPicks,
  saveSetup,
  validateSetup,
  type AdSetInput,
  type NumberInput,
} from "@/lib/sms/markets";
import { HATCH_GUARD_DAYS, hatchActivity, hatchGuardEnabled } from "@/lib/sms/hatchGuard";
import { defaultSendingNumber } from "@/lib/sms/numbers";
import { normalizePhone } from "@/lib/sms/rules";
import { smsNow } from "@/lib/sms/send";
import { audit } from "@/lib/sms/store";
import { twilioServiceNumbers } from "@/lib/sms/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

async function requireOwner() {
  const access = await getCurrentAccess();
  return access?.role === "owner" ? access : null;
}

export async function GET() {
  if (!await requireOwner()) return NextResponse.json({ error: "Owners only." }, { status: 403, headers: NO_STORE });
  try {
    const [numbers, adSets, serviceNumbers, picks] = await Promise.all([listNumbers(), listAdSets(), twilioServiceNumbers(), recentPicks()]);
    return NextResponse.json({
      numbers, adSets, serviceNumbers, picks, defaultNumber: defaultSendingNumber(),
      hatchGuard: { on: hatchGuardEnabled(), days: HATCH_GUARD_DAYS },
    }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Couldn't load the texting numbers." }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  const access = await requireOwner();
  if (!access) return NextResponse.json({ error: "Owners only." }, { status: 403, headers: NO_STORE });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    if (body.action === "test") {
      const [numbers, adSets] = await Promise.all([listNumbers(), listAdSets()]);
      const pick = pickFrom(numbers, adSets, { adSet: String(body.adSet || ""), zip: String(body.zip || ""), phone: String(body.phone || "") });
      return NextResponse.json({ pick }, { headers: NO_STORE });
    }
    if (body.action === "hatch_check") {
      const phone = normalizePhone(String(body.phone || ""));
      if (!phone) return NextResponse.json({ error: "Type a valid phone number." }, { status: 400, headers: NO_STORE });
      return NextResponse.json({ hatch: await hatchActivity(phone, smsNow()) }, { headers: NO_STORE });
    }
    if (body.action === "save") {
      const numbersIn = Array.isArray(body.numbers) ? (body.numbers as NumberInput[]).slice(0, 60) : [];
      const adSetsIn = Array.isArray(body.adSets) ? (body.adSets as AdSetInput[]).slice(0, 200) : [];
      const checked = validateSetup(numbersIn, adSetsIn);
      if (!checked.ok) return NextResponse.json({ error: "Not saved.", problems: checked.problems }, { status: 400, headers: NO_STORE });
      const by = access.email || "owner";
      await saveSetup(checked.setup, by);
      await audit({
        phone: null, action: "numbers_saved",
        detail: { on: checked.setup.numbers.filter((n) => n.textingOn).map((n) => n.name), numbers: checked.setup.numbers.length, adSets: checked.setup.adSets.length },
        actor: by,
      });
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400, headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Something went wrong." }, { status: 500, headers: NO_STORE });
  }
}

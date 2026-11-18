/**
 * lib/sms/calls.ts
 *
 * Session 8 PR 4: phone calls to our Twilio numbers. Every number's "A call comes in"
 * points at /api/voice/inbound, which forwards the call to that number's ServiceTitan
 * tracked line (Texting numbers page, "Calls forward to"), so ServiceTitan still
 * attributes the call to the right STL campaign. Each call is logged here and shown
 * in the Texting inbox chat for that phone.
 *
 * Calls are NOT texts: they never count toward caps, "Needs CSR" or consent.
 */
import { listNumbers } from "@/lib/sms/markets";
import { smsDb } from "@/lib/sms/store";

/** Where calls go when a number has no ServiceTitan line on the page: the Sacramento STL line. */
export const CALL_FALLBACK = "+19164096367";

export function callFallback(): string {
  const raw = (process.env.SMS_CALL_FALLBACK || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return raw.length === 10 ? `+1${raw}` : CALL_FALLBACK;
}

let ready: Promise<void> | null = null;
export function resetCallTablesForTests() { ready = null; }

async function callsDb() {
  const sql = await smsDb();
  if (!ready) {
    ready = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS sms_calls (
        id BIGSERIAL PRIMARY KEY,
        call_sid TEXT UNIQUE,
        phone TEXT,
        our_number TEXT,
        forwarded_to TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS sms_calls_phone ON sms_calls (phone, created_at DESC)`;
    })().catch((error) => { ready = null; throw error; });
  }
  await ready;
  return sql;
}

/** Which ServiceTitan line a call to this number of ours goes to (and the number's name). */
export async function forwardFor(ourNumber: string | null): Promise<{ forwardTo: string; name: string | null; fromPage: boolean }> {
  try {
    const found = (await listNumbers()).find((n) => n.number === ourNumber);
    if (found?.forwardTo) return { forwardTo: found.forwardTo, name: found.name, fromPage: true };
    return { forwardTo: callFallback(), name: found?.name ?? null, fromPage: false };
  } catch (error) {
    console.error("Call forward lookup failed:", error instanceof Error ? error.message : error);
    return { forwardTo: callFallback(), name: null, fromPage: false };
  }
}

export async function logCall(input: { callSid: string; phone: string | null; ourNumber: string | null; forwardedTo: string }) {
  const sql = await callsDb();
  await sql`INSERT INTO sms_calls (call_sid, phone, our_number, forwarded_to)
    VALUES (${input.callSid || null}, ${input.phone}, ${input.ourNumber}, ${input.forwardedTo})
    ON CONFLICT (call_sid) DO NOTHING`;
}

export type CallRow = { at: string; ourNumber: string | null; forwardedTo: string | null };

/** Newest calls from this phone (inbox chat). */
export async function callsFor(phone: string, limit = 5): Promise<CallRow[]> {
  const sql = await callsDb();
  const rows = await sql`SELECT created_at, our_number, forwarded_to FROM sms_calls WHERE phone = ${phone} ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    at: new Date(r.created_at as string).toISOString(),
    ourNumber: r.our_number ? String(r.our_number) : null,
    forwardedTo: r.forwarded_to ? String(r.forwarded_to) : null,
  }));
}

/** TwiML that forwards the call. callerId: the caller's own number (ServiceTitan sees who's calling);
 *  hidden / blocked callers get our number instead, or carriers may refuse the forwarded call. */
export function forwardTwiml(forwardTo: string, callerId: string | null): string {
  const esc = (v: string) => v.replace(/[^+\d]/g, "");
  const caller = callerId ? ` callerId="${esc(callerId)}"` : "";
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial answerOnBridge="true" timeout="40"${caller}><Number>${esc(forwardTo)}</Number></Dial></Response>`;
}

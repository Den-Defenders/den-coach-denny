/**
 * lib/sms/leadResults.ts
 *
 * "Lead results" report (Melanie + Shannon, 2026-11-18): for form leads in a window, how many
 * replied, wanted a call, were ready to book, booked, said not interested or texted STOP,
 * split by what they picked on the form (inquiry type) and by ad set. Read-only.
 *
 * One row per phone: the first form lead from that phone in the window. Outcomes count only
 * after that lead arrived. Spam / Test chats and staff test phones (SMS_TEST_PHONES) are left out.
 *   Got texts      we sent them at least one text after the lead
 *   Replied        they texted us after the lead (STOP-type keywords alone don't count)
 *   Wanted a call  the AI handed off "wants_call" (said yes to a quick call / asked for a call)
 *   Ready to book  the AI handed off "ready_to_book" (picked a time, or asked to book)
 *   Booked         "Booked in ServiceTitan" clicked, or the chat filed in 📅 Booked
 *   Not interested lead status or 🚫 folder
 *   STOP           opted out after the lead
 */
import { normalizePhone } from "@/lib/sms/rules";
import { leadsDb } from "@/lib/sms/leads";

export type ResultRow = {
  label: string;
  leads: number;
  gotTexts: number;
  replied: number;
  wantedCall: number;
  readyToBook: number;
  booked: number;
  notInterested: number;
  stop: number;
};

export type LeadResults = { days: number; since: string; total: ResultRow; byInquiry: ResultRow[]; byAdSet: ResultRow[] };

const INQUIRY: Record<string, string> = { questions_first: "Questions first", free_consultation: "Book a consultation" };
const STOP_WORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"];

function testPhones(): string[] {
  return (process.env.SMS_TEST_PHONES || "").split(",").map((p) => normalizePhone(p)).filter(Boolean) as string[];
}

export async function leadResults(days: number, now: Date = new Date()): Promise<LeadResults> {
  const span = [7, 30, 90].includes(days) ? days : 30;
  const since = new Date(now.getTime() - span * 86_400_000);
  const sql = await leadsDb();
  const skip = testPhones();
  const rows = await sql`
    WITH first_lead AS (
      SELECT DISTINCT ON (l.phone) l.phone, l.received_at, l.fields->>'inquiryType' AS inquiry, l.fields->>'adSet' AS ad_set
      FROM sms_leads l
      WHERE l.mode = 'live' AND l.phone IS NOT NULL AND l.received_at >= ${since.toISOString()}::timestamptz
      ORDER BY l.phone, l.received_at
    )
    SELECT f.phone, f.inquiry, f.ad_set,
      EXISTS (SELECT 1 FROM sms_messages m WHERE m.phone = f.phone AND m.direction = 'outbound'
        AND m.status <> 'send_failed' AND m.created_at >= f.received_at) AS got_texts,
      EXISTS (SELECT 1 FROM sms_messages m WHERE m.phone = f.phone AND m.direction = 'inbound'
        AND m.created_at >= f.received_at
        AND upper(regexp_replace(coalesce(m.body, ''), '[^A-Za-z]', '', 'g')) <> ALL (${STOP_WORDS}::text[])) AS replied,
      EXISTS (SELECT 1 FROM sms_audit a WHERE a.phone = f.phone AND a.action = 'bot_handoff' AND a.reason = 'wants_call'
        AND a.created_at >= f.received_at) AS wanted_call,
      EXISTS (SELECT 1 FROM sms_audit a WHERE a.phone = f.phone AND a.action = 'bot_handoff' AND a.reason = 'ready_to_book'
        AND a.created_at >= f.received_at) AS ready_to_book,
      (v.folder = 'booked' OR (v.booking_done_at IS NOT NULL AND v.booking_done_at >= f.received_at)) AS booked,
      (v.lead_status = 'not_interested' OR v.folder = 'not_interested') AS not_interested,
      EXISTS (SELECT 1 FROM sms_opt_outs o WHERE o.phone = f.phone AND o.opted_out_at >= f.received_at) AS stop
    FROM first_lead f
    LEFT JOIN sms_conversations v ON v.phone = f.phone
    WHERE coalesce(v.folder, 'active') NOT IN ('spam', 'test')`;

  const empty = (label: string): ResultRow => ({ label, leads: 0, gotTexts: 0, replied: 0, wantedCall: 0, readyToBook: 0, booked: 0, notInterested: 0, stop: 0 });
  const total = empty("All leads");
  const byInquiry = new Map<string, ResultRow>();
  const byAdSet = new Map<string, ResultRow>();
  const add = (row: ResultRow, r: Record<string, unknown>) => {
    row.leads++;
    if (r.got_texts === true) row.gotTexts++;
    if (r.replied === true) row.replied++;
    if (r.wanted_call === true) row.wantedCall++;
    if (r.ready_to_book === true) row.readyToBook++;
    if (r.booked === true) row.booked++;
    if (r.not_interested === true) row.notInterested++;
    if (r.stop === true) row.stop++;
  };
  for (const r of rows) {
    if (skip.includes(String(r.phone))) continue;
    add(total, r);
    const inquiry = INQUIRY[String(r.inquiry || "")] || "Not given";
    if (!byInquiry.has(inquiry)) byInquiry.set(inquiry, empty(inquiry));
    add(byInquiry.get(inquiry)!, r);
    const adSet = String(r.ad_set || "").trim() || "No ad set";
    const key = adSet.toLowerCase();
    if (!byAdSet.has(key)) byAdSet.set(key, empty(adSet));
    add(byAdSet.get(key)!, r);
  }
  const sorted = (m: Map<string, ResultRow>) => [...m.values()].sort((a, b) => b.leads - a.leads || a.label.localeCompare(b.label));
  return { days: span, since: since.toISOString(), total, byInquiry: sorted(byInquiry), byAdSet: sorted(byAdSet) };
}

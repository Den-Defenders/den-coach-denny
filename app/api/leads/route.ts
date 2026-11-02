/**
 * POST /api/leads — Zapier lead intake (build step 5).
 *
 * Public in proxy.ts (Zapier can't log in); this route rejects any request
 * without the SMS_LEADS_SECRET in the X-Denny-Secret header.
 *
 * PR 1 = "log only" test mode: the lead is saved with every field and shown on
 * /sms-test. No texts, no contact, no conversation, no Slack.
 */
import { NextResponse } from "next/server";
import { leadsMode, leadsSecretConfigured, leadsSecretMatches, MAX_LEAD_BYTES, parseLead, readLeadBody, saveLead } from "@/lib/sms/leads";
import { smsNow } from "@/lib/sms/send";
import { audit, smsDatabaseConfigured } from "@/lib/sms/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  return NextResponse.json({ ok: false, error: "Use POST." }, { status: 405, headers: NO_STORE });
}

export async function POST(request: Request) {
  if (!leadsSecretConfigured()) {
    return NextResponse.json({ ok: false, error: "Lead intake is not set up yet (SMS_LEADS_SECRET missing)." }, { status: 503, headers: NO_STORE });
  }
  if (!leadsSecretMatches(request.headers)) {
    return NextResponse.json({ ok: false, error: "Wrong or missing X-Denny-Secret header." }, { status: 401, headers: NO_STORE });
  }
  if (!smsDatabaseConfigured()) {
    return NextResponse.json({ ok: false, error: "Texting database is not configured." }, { status: 503, headers: NO_STORE });
  }

  const text = await request.text().catch(() => "");
  if (Buffer.byteLength(text, "utf8") > MAX_LEAD_BYTES) {
    return NextResponse.json({ ok: false, error: "Request too large." }, { status: 413, headers: NO_STORE });
  }
  const raw = readLeadBody(text, request.headers.get("content-type") || "");
  if (!raw) {
    return NextResponse.json({ ok: false, error: "Couldn't read the request. In Zapier set Payload Type to json." }, { status: 400, headers: NO_STORE });
  }
  if (!Object.keys(raw).length) {
    return NextResponse.json({ ok: false, error: "No fields were sent. Add the lead fields under Data in Zapier." }, { status: 400, headers: NO_STORE });
  }

  const lead = parseLead(raw);
  const mode = leadsMode();
  const now = smsNow();
  try {
    const leadId = await saveLead(lead, { mode, result: "logged_only", userAgent: request.headers.get("user-agent"), at: now });
    await audit({
      phone: lead.fields.phone,
      action: "lead_received",
      reason: `${mode}: no texts sent`,
      detail: { leadId, source: lead.fields.leadSource, form: lead.fields.formName, consent: lead.fields.smsConsent, missing: lead.missing },
      actor: "zapier",
    });
    return NextResponse.json({
      ok: true,
      mode,
      leadId,
      textsSent: 0,
      message: "Test lead saved. No texts were sent (log only mode). See it on dencoachdenny.com/sms-test under Lead intake.",
      understood: {
        first_name: lead.fields.firstName,
        last_name: lead.fields.lastName,
        phone: lead.fields.phone,
        zip: lead.fields.zip,
        email: lead.fields.email,
        lead_source: lead.fields.leadSource,
        campaign_name: lead.fields.campaignName,
        ad_name: lead.fields.adName,
        form_name: lead.fields.formName,
        submitted_at: lead.fields.submittedAt,
        sms_consent: lead.fields.smsConsent,
        project_interest: lead.fields.projectInterest,
        best_time: lead.fields.bestTime,
      },
      otherFields: Object.keys(lead.fields.other),
      missing: lead.missing,
      warnings: lead.warnings,
    }, { headers: NO_STORE });
  } catch (error) {
    console.error("Lead intake failed:", error);
    return NextResponse.json({ ok: false, error: "Could not save the lead." }, { status: 500, headers: NO_STORE });
  }
}

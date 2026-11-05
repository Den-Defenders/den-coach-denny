"use client";

import { useCallback, useEffect, useState } from "react";
import HatchOptOuts from "./HatchOptOuts";

type Settings = {
  sendingEnabled: boolean;
  twilioConfigured: boolean;
  databaseConfigured: boolean;
  webhookBaseUrl: string | null;
  inboundUrl: string | null;
  statusUrl: string | null;
  allowList: string;
  promoTextsEnabled: boolean;
  limits: { perContactPerHour: number; perContactPerDay: number; automatedPerContactPerDay: number; systemPerDay: number };
  botEnabled: boolean;
  botModel: string;
  openAiConfigured: boolean;
  slackAlerts: boolean;
  leadsSecretSet: boolean;
  leadsMode: string;
  leadsUrl: string | null;
  dripEnabled: boolean;
  dripSteps: number;
  timerSecretSet: boolean;
  consentSources: string;
};

type Message = {
  id: number; phone: string; direction: "inbound" | "outbound"; kind: string | null; purpose: string | null;
  body: string; media: string[] | null; status: string; error_code: string | null; error_message: string | null;
  sent_by: string | null; created_at: string;
};
type OptOut = { phone: string; opted_out_at: string; source: string; keyword: string | null };
type Handoff = { phone: string; handoff_reason: string | null; handoff_summary: string | null; handoff_at: string | null; lead_status: string | null };
type LeadFields = {
  firstName: string | null; lastName: string | null; phone: string | null; phoneAsSent: string | null; zip: string | null;
  email: string | null; leadSource: string | null; campaignName: string | null; adName: string | null; formName: string | null;
  submittedAt: string | null; submittedAtAsSent: string | null; smsConsent: "yes" | "no" | "not_sent"; smsConsentAsSent: string | null;
  consentText: string | null; projectInterest: string | null; bestTime: string | null; other: Record<string, string>;
};
type Lead = { id: number; receivedAt: string; mode: string; result: string; fields: LeadFields; raw: Record<string, string>; missing: string[]; warnings: string[] };
type AuditRow = { id: number; phone: string | null; action: string; reason: string | null; detail: Record<string, unknown> | null; actor: string | null; created_at: string };

const MAX = 640;

function phoneLabel(p: string | null) {
  if (!p) return "—";
  const d = p.replace(/^\+1/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
}

function when(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function segments(text: string) {
  const gsm = /^[\x0A\x0D\x20-\x7E£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¡ÄÖÑÜ§¿äöñüà€]*$/.test(text);
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  return text.length <= single ? 1 : Math.ceil(text.length / multi);
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return <li style={{ color: ok ? "var(--teal-dark)" : "#b3261e", fontWeight: 700 }}>{ok ? "✓" : "✗"} {label}</li>;
}

export default function SmsTester() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [optOuts, setOptOuts] = useState<OptOut[]>([]);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [resetPhone, setResetPhone] = useState("");
  const [skipSt, setSkipSt] = useState(true);
  const [to, setTo] = useState("");
  const [body, setBody] = useState("Den Defenders test: texting from Denny works. Reply to this text to test incoming.");
  const [kind, setKind] = useState("manual");
  const [purpose, setPurpose] = useState("care");
  const [status, setStatus] = useState("Loading…");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/sms/test", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (data.settings) setSettings(data.settings);
    setMessages(data.messages || []);
    setOptOuts(data.optOuts || []);
    setAuditRows(data.audit || []);
    setHandoffs(data.handoffs || []);
    setLeads(data.leads || []);
    setStatus(response.ok ? "" : data.error || "Could not load texting activity.");
  }, []);

  useEffect(() => {
    // Fetch on open, then refresh every 10 seconds so incoming texts show up.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  async function send() {
    setSending(true);
    setStatus("Sending…");
    const response = await fetch("/api/sms/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, body, kind, purpose }),
    });
    const data = await response.json().catch(() => ({}));
    setStatus(data.ok ? `Sent ✓ (Twilio status: ${data.status}). Check your phone.` : `Blocked: ${data.message || data.error || "unknown"} [${data.reason || response.status}]`);
    setSending(false);
    load();
  }

  async function resetLead() {
    const response = await fetch("/api/sms/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset_lead_test", phone: resetPhone, skipServiceTitan: skipSt }),
    });
    const data = await response.json().catch(() => ({}));
    setStatus(data.message || (response.ok ? "Done." : "Could not reset that number."));
    load();
  }

  async function resume(phone: string) {
    const response = await fetch("/api/sms/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume_bot", phone }),
    });
    const data = await response.json().catch(() => ({}));
    setStatus(data.message || (response.ok ? "Done." : "Could not turn the bot back on."));
    load();
  }

  return (
    <div className="team-page">
      <section className="surface team-form">
        <h2>Setup check</h2>
        {settings ? (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
            <Check ok={settings.databaseConfigured} label="Texting database connected" />
            <Check ok={settings.twilioConfigured} label="Twilio settings found (Account SID, Auth Token, Messaging Service SID)" />
            <Check ok={Boolean(settings.webhookBaseUrl)} label={`Webhook address: ${settings.webhookBaseUrl || "SMS_WEBHOOK_BASE_URL not set"}`} />
            <Check ok={settings.sendingEnabled} label={`Sending switch ${settings.sendingEnabled ? "ON" : "OFF"} (SMS_SENDING_ENABLED)`} />
            <Check ok={settings.botEnabled && settings.openAiConfigured} label={`AI replies ${settings.botEnabled ? "ON" : "OFF"} (SMS_BOT_ENABLED)${settings.openAiConfigured ? "" : " · OPENAI_API_KEY missing"} · model ${settings.botModel}`} />
            <li className="team-hint">Pilot allow-list: <b>{settings.allowList}</b> · Slack alert on handoff: <b>{settings.slackAlerts ? "ON" : "OFF"}</b></li>
            <li className="team-hint">Promo texts: <b>{settings.promoTextsEnabled ? "ON" : "OFF"}</b> · Caps: {settings.limits.perContactPerHour}/hour and {settings.limits.perContactPerDay}/day per number, {settings.limits.automatedPerContactPerDay} automated/day, {settings.limits.systemPerDay}/day total</li>
            {settings.inboundUrl && <li className="team-hint">Twilio “A message comes in”: <code>{settings.inboundUrl}</code></li>}
            {settings.statusUrl && <li className="team-hint">Twilio “Delivery Status Callback”: <code>{settings.statusUrl}</code></li>}
          </ul>
        ) : <p className="team-hint">Loading…</p>}
      </section>

      <section className="surface team-form">
        <h2>Send a test text</h2>
        <p className="team-hint">Goes through the real send rules (opt-out, consent, hours, caps). Text the pilot number from your phone first so there&apos;s consent on file.</p>
        <div className="team-grid">
          <label>
            <span>To (mobile number)</span>
            <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="(916) 555-1234" inputMode="tel" />
          </label>
          <label>
            <span>Kind of text</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="manual">Manual (person typing) · 8 AM–7 PM</option>
              <option value="reply">Auto-reply (within 24 h of their text) · any hour</option>
              <option value="automated">Automated follow-up · 9 AM–5 PM, no holidays</option>
            </select>
          </label>
          <label>
            <span>Purpose</span>
            <select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              <option value="care">Customer care (consultations, quotes, appointments)</option>
              <option value="marketing">Promo / offer</option>
            </select>
          </label>
        </div>
        <label className="sms-message">
          <span>Message ({body.length}/{MAX} characters · {segments(body)} segment{segments(body) === 1 ? "" : "s"})</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={MAX + 50} />
        </label>
        <div className="hero-actions" style={{ marginTop: 14 }}>
          <button className="btn btn-teal" disabled={sending || !to || !body.trim()} onClick={send}>Send test text</button>
          <button className="btn btn-outline" onClick={load}>Refresh</button>
        </div>
        {status && <div className="notice" style={{ marginTop: 12 }}>{status}</div>}
      </section>

      <section className="surface team-list">
        <h2>Lead intake (Zapier test leads)</h2>
        {settings && (
          <ul style={{ listStyle: "none", padding: 0, margin: "0 0 10px", display: "grid", gap: 6 }}>
            <Check ok={settings.leadsSecretSet} label={settings.leadsSecretSet ? "Lead secret set (SMS_LEADS_SECRET)" : "SMS_LEADS_SECRET not set in Vercel (Zapier gets an error)"} />
            <li className="team-hint">Mode: <b>{settings.leadsMode === "log_only" ? "LOG ONLY: leads are saved and shown here, no texts are sent (SMS_LEADS_MODE)" : "LIVE: leads go to the Texting inbox and start the drip (SMS_LEADS_MODE=live)"}</b></li>
            <Check ok={settings.dripEnabled} label={`Drip ${settings.dripEnabled ? "ON" : "OFF"} (SMS_DRIP_ENABLED) · ${settings.dripSteps} texts over 60 days · promo steps ${settings.promoTextsEnabled ? "ON" : "skipped (promo off)"}`} />
            <Check ok={settings.timerSecretSet} label={settings.timerSecretSet ? "Timer secret set (SMS_TIMER_SECRET): GitHub runs the drip every 15 min" : "SMS_TIMER_SECRET not set: only the first texts go out"} />
            <li className="team-hint">Sources that count as SMS consent: <b>{settings.consentSources}</b></li>
            {settings.leadsUrl && <li className="team-hint">Zapier URL (POST, json): <code>{settings.leadsUrl}</code> · header <code>X-Denny-Secret</code></li>}
          </ul>
        )}
        <div className="team-grid" style={{ alignItems: "end", marginBottom: 10 }}>
          <label>
            <span>Test again with a pilot number</span>
            <input value={resetPhone} onChange={(e) => setResetPhone(e.target.value)} placeholder="Your test cell" inputMode="tel" />
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={skipSt} onChange={(e) => setSkipSt(e.target.checked)} style={{ width: "auto" }} />
            <span>Skip the ServiceTitan check for this number</span>
          </label>
          <button className="btn btn-outline" disabled={!resetPhone} onClick={resetLead}>Let the next lead start a fresh drip</button>
        </div>
        {leads.length === 0 ? <p className="team-hint">No leads yet. Send a test lead from the Zap.</p> : (
          <div className="owner-table-wrap">
            <table className="team-table">
              <thead><tr><th>Received</th><th>Name</th><th>Phone</th><th>ZIP</th><th>Email</th><th>Source / campaign / ad / form</th><th>Submitted</th><th>SMS consent</th><th>Interest · best time</th><th>Check</th></tr></thead>
              <tbody>
                {leads.map((l) => {
                  const f = l.fields;
                  return (
                    <tr key={l.id}>
                      <td>{when(l.receivedAt)}<br /><span className="team-hint">#{l.id} · {l.result.replace(/_/g, " ")}</span></td>
                      <td>{[f.firstName, f.lastName].filter(Boolean).join(" ") || "—"}</td>
                      <td>{f.phone ? phoneLabel(f.phone) : <span style={{ color: "#b3261e" }}>{f.phoneAsSent || "missing"}</span>}</td>
                      <td>{f.zip || "—"}</td>
                      <td>{f.email || "—"}</td>
                      <td style={{ whiteSpace: "pre-wrap", maxWidth: 260 }}>{[f.leadSource, f.campaignName, f.adName, f.formName].map((v) => v || "—").join("\n")}</td>
                      <td>{f.submittedAt ? when(f.submittedAt) : f.submittedAtAsSent || "—"}</td>
                      <td style={{ fontWeight: 700, color: f.smsConsent === "yes" ? "var(--teal-dark)" : "#b3261e" }}>
                        {f.smsConsent === "yes" ? "✓ Yes" : f.smsConsent === "no" ? "✗ No" : "Not sent"}
                        {f.smsConsentAsSent ? <><br /><span className="team-hint" style={{ fontWeight: 400 }}>sent: &quot;{f.smsConsentAsSent}&quot;</span></> : null}
                      </td>
                      <td style={{ whiteSpace: "pre-wrap", maxWidth: 200 }}>{f.projectInterest || "—"}{f.bestTime ? `\n${f.bestTime}` : ""}</td>
                      <td style={{ maxWidth: 320 }}>
                        {l.missing.length ? <div style={{ color: "#b3261e" }}>Missing: {l.missing.join(", ")}</div> : <div style={{ color: "var(--teal-dark)" }}>All fields ✓</div>}
                        {l.warnings.map((w) => <div key={w} className="team-hint">⚠ {w}</div>)}
                        <details>
                          <summary>All fields as sent ({Object.keys(l.raw).length})</summary>
                          <div style={{ whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: 12 }}>
                            {Object.entries(l.raw).map(([k, v]) => `${k}: ${v}`).join("\n")}
                          </div>
                          {f.consentText && <p className="team-hint">Consent wording sent: {f.consentText}</p>}
                        </details>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <HatchOptOuts />

      <section className="surface team-list">
        <h2>Needs CSR (AI paused for these numbers)</h2>
        {handoffs.length === 0 ? <p className="team-hint">No handoffs. The AI is answering every number on the pilot list.</p> : (
          <div className="owner-table-wrap">
            <table className="team-table">
              <thead><tr><th>When</th><th>Number</th><th>Why</th><th>Summary for the team</th><th></th></tr></thead>
              <tbody>
                {handoffs.map((h) => (
                  <tr key={h.phone}>
                    <td>{h.handoff_at ? when(h.handoff_at) : "—"}</td>
                    <td>{phoneLabel(h.phone)}</td>
                    <td>{(h.handoff_reason || "team").replace(/_/g, " ")}{h.lead_status ? ` · ${h.lead_status.replace(/_/g, " ")}` : ""}</td>
                    <td style={{ whiteSpace: "pre-wrap", maxWidth: 420 }}>{h.handoff_summary || "—"}</td>
                    <td><button className="btn btn-outline" onClick={() => resume(h.phone)}>Turn AI back on</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="surface team-list">
        <h2>Texts (newest first)</h2>
        {messages.length === 0 ? <p className="team-hint">No texts yet.</p> : (
          <div className="owner-table-wrap">
            <table className="team-table">
              <thead><tr><th>When</th><th>Number</th><th>Direction</th><th>Message</th><th>Status</th><th>Kind</th><th>By</th></tr></thead>
              <tbody>
                {messages.map((m) => (
                  <tr key={m.id}>
                    <td>{when(m.created_at)}</td>
                    <td>{phoneLabel(m.phone)}</td>
                    <td>{m.direction === "inbound" ? "⬅ In" : "➡ Out"}</td>
                    <td style={{ whiteSpace: "pre-wrap", maxWidth: 420 }}>{m.body}{m.media?.length ? ` 📎 ${m.media.length} photo(s)` : ""}</td>
                    <td>{m.status}{m.error_code ? ` (${m.error_code})` : ""}</td>
                    <td>{m.kind || "—"}{m.purpose === "marketing" ? " · promo" : ""}</td>
                    <td>{m.sent_by || (m.direction === "inbound" ? "customer" : "—")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="surface team-list">
        <h2>Opted out (STOP list)</h2>
        {optOuts.length === 0 ? <p className="team-hint">Nobody has opted out.</p> : (
          <div className="owner-table-wrap">
            <table className="team-table">
              <thead><tr><th>Number</th><th>When</th><th>How</th><th>Word</th></tr></thead>
              <tbody>
                {optOuts.map((o) => (
                  <tr key={o.phone}><td>{phoneLabel(o.phone)}</td><td>{when(o.opted_out_at)}</td><td>{o.source}</td><td>{o.keyword || "—"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="surface team-list">
        <h2>Guardrail log</h2>
        {auditRows.length === 0 ? <p className="team-hint">Nothing logged yet.</p> : (
          <div className="owner-table-wrap">
            <table className="team-table">
              <thead><tr><th>When</th><th>Number</th><th>What</th><th>Why</th><th>Who</th></tr></thead>
              <tbody>
                {auditRows.map((a) => (
                  <tr key={a.id}><td>{when(a.created_at)}</td><td>{phoneLabel(a.phone)}</td><td>{a.action}</td><td>{a.reason || "—"}</td><td>{a.actor || "—"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

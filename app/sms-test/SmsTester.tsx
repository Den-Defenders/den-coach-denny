"use client";

import { useCallback, useEffect, useState } from "react";

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
};

type Message = {
  id: number; phone: string; direction: "inbound" | "outbound"; kind: string | null; purpose: string | null;
  body: string; media: string[] | null; status: string; error_code: string | null; error_message: string | null;
  sent_by: string | null; created_at: string;
};
type OptOut = { phone: string; opted_out_at: string; source: string; keyword: string | null };
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
            <li className="team-hint">Pilot allow-list: <b>{settings.allowList}</b></li>
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
              <option value="manual">Manual (person typing) · 8 AM–9 PM</option>
              <option value="reply">Auto-reply (within 24 h of their text) · 8 AM–7 PM</option>
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
        <label className="team-grid" style={{ marginTop: 14 }}>
          <span>Message ({body.length}/{MAX} characters · {segments(body)} segment{segments(body) === 1 ? "" : "s"})</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={MAX + 50}
            style={{ padding: 12, border: "1px solid var(--line)", borderRadius: 11, font: "inherit" }} />
        </label>
        <div className="hero-actions" style={{ marginTop: 14 }}>
          <button className="btn btn-teal" disabled={sending || !to || !body.trim()} onClick={send}>Send test text</button>
          <button className="btn btn-outline" onClick={load}>Refresh</button>
        </div>
        {status && <div className="notice" style={{ marginTop: 12 }}>{status}</div>}
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

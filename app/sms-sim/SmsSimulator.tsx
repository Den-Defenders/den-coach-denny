"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type SimMessage = { from: "customer" | "bot"; text: string; media?: string[] };
type SimEvent = { turn: number; type: string; text: string };
type Scenario = { id?: number; name: string; persona: string; opening: string; maxTurns: number };
type Run = {
  key: string; id?: number; name: string; persona: string; mode: "auto" | "manual";
  transcript: SimMessage[]; events: SimEvent[]; notes: Record<string, string>;
  status: "running" | "done" | "error"; endReason: string | null; error?: string; model: string;
  createdAt?: string; createdBy?: string; policyVersion?: string; turns?: number;
};
type TurnResult = {
  customerText: string; botReply: string | null; media: string[]; events: SimEvent[];
  notes: Record<string, string>; ended: boolean; endReason: string | null; model: string; error?: string;
};
type Settings = { botModel: string; customerModel: string; openAiConfigured: boolean };

const EMPTY: Scenario = { name: "", persona: "", opening: "", maxTurns: 8 };
const PARALLEL = 3;

function when(iso?: string) {
  return iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
}

function transcriptText(run: Run): string {
  const lines = [`Scenario: ${run.name}`];
  if (run.persona) lines.push(`Customer: ${run.persona}`);
  if (run.createdAt || run.policyVersion) lines.push(`Run: ${when(run.createdAt)}${run.policyVersion ? ` · brain policy ${run.policyVersion}` : ""}`);
  lines.push("");
  let turn = 0;
  for (const m of run.transcript) {
    if (m.from === "customer") turn++;
    lines.push(`${m.from === "customer" ? "CUSTOMER" : "DEN DEFENDERS"}: ${m.text.replace(/\n\n/g, "\n   ")}${m.media?.length ? `\n   [${m.media.length} photo(s) attached]` : ""}`);
    if (m.from === "bot") for (const e of run.events.filter((x) => x.turn === turn)) lines.push(`   (${e.text})`);
  }
  if (run.endReason) lines.push("", `Ended: ${run.endReason}`);
  return lines.join("\n");
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

async function api<T>(body: unknown): Promise<T> {
  const response = await fetch("/api/sms/sim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
  return data as T;
}

function Transcript({ run }: { run: Run }) {
  let turn = 0;
  return (
    <div className="sim-thread">
      {run.transcript.map((m, i) => {
        if (m.from === "customer") turn++;
        const events = m.from === "bot" ? run.events.filter((e) => e.turn === turn) : [];
        return (
          <div key={i} className={`sim-row sim-${m.from}`}>
            <div className="sim-who">{m.from === "customer" ? "Customer" : "Den Defenders AI"}</div>
            <div className="sim-bubble">{m.text}</div>
            {!!m.media?.length && (
              <div className="sim-photos">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {m.media.map((url) => <a key={url} href={url} target="_blank" rel="noreferrer"><img src={url} alt="Door photo the AI attached" /></a>)}
              </div>
            )}
            {events.map((e, j) => <div key={j} className={`sim-event sim-event-${e.type}`}>{e.text}</div>)}
          </div>
        );
      })}
      {run.status === "running" && <div className="sim-typing">…</div>}
    </div>
  );
}

function RunCard({ run, onSave, onDelete, defaultOpen = true }: { run: Run; onSave?: () => void; onDelete?: () => void; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const turns = run.turns ?? run.transcript.filter((m) => m.from === "customer").length;
  return (
    <div className="sim-run">
      <div className="sim-run-head">
        <button className="sim-run-title" onClick={() => setOpen(!open)}>{open ? "▾" : "▸"} {run.name}</button>
        <span className="team-hint">
          {run.status === "running" ? `Running… turn ${turns}` : run.status === "error" ? `Error: ${run.error}` : `${turns} turn${turns === 1 ? "" : "s"} · ${run.endReason || "Reached the turn limit"}`}
          {run.createdAt ? ` · ${when(run.createdAt)}${run.createdBy ? ` by ${run.createdBy}` : ""}` : ""}
          {run.mode === "manual" ? " · typed by a person" : ""}
        </span>
        <span className="sim-run-actions">
          <button className="btn btn-outline btn-small" onClick={() => { navigator.clipboard?.writeText(transcriptText(run)); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied ✓" : "Copy"}</button>
          {onSave && run.status !== "running" && !run.id && <button className="btn btn-teal btn-small" onClick={onSave}>Save to log</button>}
          {onDelete && <button className="btn btn-outline btn-small" onClick={onDelete}>Delete</button>}
        </span>
      </div>
      {open && <Transcript run={run} />}
    </div>
  );
}

export default function SmsSimulator() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saved, setSaved] = useState<Run[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [editing, setEditing] = useState<Scenario | null>(null);
  const [status, setStatus] = useState("Loading…");
  const [busy, setBusy] = useState(false);
  const stopRef = useRef(false);

  // "Chat yourself"
  const [chat, setChat] = useState<Run | null>(null);
  const [chatText, setChatText] = useState("");
  const [chatBusy, setChatBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/sms/sim", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (data.settings) setSettings(data.settings);
    setScenarios(data.scenarios || []);
    setSaved((data.runs || []).map((r: Run) => ({ ...r, key: `saved-${r.id}`, status: "done" as const })));
    setStatus(data.error || "");
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const update = (key: string, change: (r: Run) => Run) => setRuns((all) => all.map((r) => (r.key === key ? change(r) : r)));

  async function runScenario(s: Scenario, key: string) {
    let run: Run = { key, name: s.name, persona: s.persona, mode: "auto", transcript: [], events: [], notes: {}, status: "running", endReason: null, model: settings?.botModel || "" };
    setRuns((all) => [run, ...all.filter((r) => r.key !== key)]);
    try {
      for (let t = 0; t < s.maxTurns && !stopRef.current; t++) {
        const r = await api<TurnResult>({ action: "turn", scenario: s, transcript: run.transcript, notes: run.notes });
        const transcript = [...run.transcript];
        if (r.customerText !== "[END]") transcript.push({ from: "customer", text: r.customerText });
        if (r.botReply) transcript.push({ from: "bot", text: r.botReply, media: r.media });
        run = { ...run, transcript, events: [...run.events, ...r.events], notes: r.notes, model: r.model, endReason: r.endReason };
        update(key, () => run);
        if (r.ended) break;
      }
      run = { ...run, status: "done", endReason: run.endReason || (stopRef.current ? "Stopped" : "Reached the turn limit") };
      update(key, () => run);
      // Auto-run results go straight to the log.
      const savedRun = await api<{ id: number }>({ action: "save_run", run });
      update(key, (r) => ({ ...r, id: savedRun.id }));
    } catch (error) {
      update(key, (r) => ({ ...r, status: "error", error: error instanceof Error ? error.message : "failed" }));
    }
  }

  async function runMany(list: Scenario[]) {
    if (!list.length) return;
    stopRef.current = false;
    setBusy(true);
    setStatus(`Running ${list.length} scenario${list.length === 1 ? "" : "s"} (${PARALLEL} at a time)…`);
    const stamp = Date.now();
    const queue = list.map((s, i) => ({ s, key: `run-${stamp}-${i}` }));
    const workers = Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      while (queue.length) {
        const next = queue.shift()!;
        await runScenario(next.s, next.key);
      }
    });
    await Promise.all(workers);
    setBusy(false);
    setStatus(stopRef.current ? "Stopped." : "Done. Results are saved in the test log below.");
    load();
  }

  async function sendChat() {
    const text = chatText.trim();
    if (!text || chatBusy) return;
    const base: Run = chat || { key: `chat-${Date.now()}`, name: "Chat yourself", persona: "", mode: "manual", transcript: [], events: [], notes: {}, status: "done", endReason: null, model: settings?.botModel || "" };
    const pending: Run = { ...base, status: "running", transcript: [...base.transcript, { from: "customer", text }] };
    setChat(pending);
    setChatText("");
    setChatBusy(true);
    try {
      const r = await api<TurnResult>({ action: "turn", scenario: { name: base.name }, transcript: base.transcript, notes: base.notes, customerText: text });
      const transcript = [...pending.transcript];
      if (r.botReply) transcript.push({ from: "bot", text: r.botReply, media: r.media });
      setChat({ ...pending, transcript, events: [...base.events, ...r.events], notes: r.notes, model: r.model, status: "done", endReason: r.endReason });
    } catch (error) {
      setChat({ ...pending, status: "error", error: error instanceof Error ? error.message : "failed" });
    }
    setChatBusy(false);
  }

  async function saveChat() {
    if (!chat?.transcript.length) return;
    const r = await api<{ id: number }>({ action: "save_run", run: chat });
    setChat({ ...chat, id: r.id });
    setStatus("Saved to the test log.");
    load();
  }

  async function saveScenario() {
    if (!editing) return;
    try {
      await api({ action: "save_scenario", scenario: editing });
      setEditing(null);
      setStatus("Scenario saved.");
      load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save.");
    }
  }

  async function removeScenario(s: Scenario) {
    if (!s.id) return;
    await api({ action: "delete_scenario", id: s.id });
    load();
  }

  async function removeRun(run: Run) {
    if (!run.id) return;
    await api({ action: "delete_run", id: run.id });
    load();
  }

  const toggle = (id?: number) => {
    if (!id) return;
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allForDownload = [...runs.filter((r) => r.status !== "running"), ...saved.filter((s) => !runs.some((r) => r.id === s.id))];

  return (
    <div className="team-page">
      <section className="surface team-form">
        <h2>Texting Simulator</h2>
        <p className="team-hint">
          Runs the <b>real</b> texting AI (same brain and rules as the pilot number) with an AI pretending to be the customer, or with you typing as the customer.
          Nothing is texted to anyone: no Twilio charges, and reply hours and text limits don&apos;t apply here. About $0.05 of AI per scenario.
        </p>
        {settings && (
          <p className="team-hint">
            Texting AI: <b>{settings.botModel}</b> · Pretend customer: <b>{settings.customerModel}</b>
            {!settings.openAiConfigured && <b style={{ color: "#b3261e" }}> · OPENAI_API_KEY missing</b>}
          </p>
        )}
        {status && <div className="notice" style={{ marginTop: 10 }}>{status}</div>}
      </section>

      <section className="surface team-list">
        <h2>Scenarios</h2>
        <p className="team-hint">Tick the ones to run, or run them all. Each one plays out until the customer is done, the AI hands off to a CSR, or it hits its turn limit. Results are saved to the test log automatically.</p>
        <div className="owner-table-wrap sim-scenarios">
          <table className="team-table">
            <colgroup><col className="sim-col-pick" /><col className="sim-col-name" /><col /><col className="sim-col-first" /><col className="sim-col-turns" /><col className="sim-col-actions" /></colgroup>
            <thead><tr><th></th><th>Name</th><th>Who the customer is and what they want</th><th>First text</th><th>Turns</th><th></th></tr></thead>
            <tbody>
              {scenarios.map((s) => (
                <tr key={s.id}>
                  <td><input type="checkbox" checked={selected.has(s.id || 0)} onChange={() => toggle(s.id)} aria-label={`Select ${s.name}`} /></td>
                  <td className="sim-name">{s.name}</td>
                  <td>{s.persona}</td>
                  <td>{s.opening ? <q>{s.opening}</q> : <span className="team-hint">AI writes it</span>}</td>
                  <td className="sim-turns">{s.maxTurns}</td>
                  <td className="sim-actions">
                    <button className="btn btn-outline btn-small" disabled={busy} onClick={() => runMany([s])}>Run</button>{" "}
                    <button className="btn btn-outline btn-small" onClick={() => setEditing({ ...s })}>Edit</button>{" "}
                    <button className="btn btn-outline btn-small" onClick={() => removeScenario(s)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="hero-actions" style={{ marginTop: 14 }}>
          <button className="btn btn-teal" disabled={busy || !selected.size} onClick={() => runMany(scenarios.filter((s) => selected.has(s.id || 0)))}>Run selected ({selected.size})</button>
          <button className="btn btn-teal" disabled={busy || !scenarios.length} onClick={() => runMany(scenarios)}>Run all ({scenarios.length})</button>
          {busy && <button className="btn btn-outline" onClick={() => { stopRef.current = true; setStatus("Stopping after the current turns…"); }}>Stop</button>}
          <button className="btn btn-outline" onClick={() => setEditing({ ...EMPTY })}>Add a scenario</button>
        </div>

        {editing && (
          <div className="sim-edit">
            <h3>{editing.id ? "Edit scenario" : "New scenario"}</h3>
            <div className="team-grid">
              <label><span>Name</span><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Price shopper, Phoenix slider" /></label>
              <label><span>Max turns (1 to 15)</span><input type="number" min={1} max={15} value={editing.maxTurns} onChange={(e) => setEditing({ ...editing, maxTurns: Number(e.target.value) })} /></label>
            </div>
            <label className="sms-message">
              <span>Who the customer is and what they want (city/ZIP, door, mood, what they&apos;ll say yes or no to)</span>
              <textarea rows={3} value={editing.persona} onChange={(e) => setEditing({ ...editing, persona: e.target.value })} />
            </label>
            <label className="sms-message">
              <span>Their first text (optional; leave blank and the AI customer writes it)</span>
              <textarea rows={2} value={editing.opening} onChange={(e) => setEditing({ ...editing, opening: e.target.value })} />
            </label>
            <div className="hero-actions" style={{ marginTop: 12 }}>
              <button className="btn btn-teal" onClick={saveScenario}>Save scenario</button>
              <button className="btn btn-outline" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        )}
      </section>

      <section className="surface team-form">
        <h2>Chat yourself</h2>
        <p className="team-hint">Type as the customer and see what the AI would text back. Nothing is sent to a phone.</p>
        {chat && <RunCard run={chat} onSave={saveChat} />}
        <div className="sim-chat-box">
          <textarea rows={2} value={chatText} placeholder="Type what the customer texts…" onChange={(e) => setChatText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }} />
          <button className="btn btn-teal" disabled={chatBusy || !chatText.trim()} onClick={sendChat}>{chatBusy ? "Thinking…" : "Send"}</button>
          <button className="btn btn-outline" disabled={chatBusy || !chat} onClick={() => setChat(null)}>Start over</button>
        </div>
      </section>

      {runs.length > 0 && (
        <section className="surface team-list">
          <h2>This session&apos;s runs</h2>
          {runs.map((r) => <RunCard key={r.key} run={r} />)}
        </section>
      )}

      <section className="surface team-list">
        <div className="sim-run-head">
          <h2 style={{ margin: 0 }}>Test log (saved runs)</h2>
          <button className="btn btn-outline btn-small" disabled={!allForDownload.length}
            onClick={() => download(`texting-sim-${new Date().toISOString().slice(0, 10)}.txt`, allForDownload.map(transcriptText).join("\n\n----------------------------------------\n\n"))}>
            Download all as .txt
          </button>
        </div>
        {saved.length === 0 ? <p className="team-hint">No saved runs yet.</p> : saved.map((r) => <RunCard key={r.key} run={r} defaultOpen={false} onDelete={() => removeRun(r)} />)}
      </section>
    </div>
  );
}

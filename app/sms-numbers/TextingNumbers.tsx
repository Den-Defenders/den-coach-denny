"use client";

import { useCallback, useEffect, useState } from "react";

type NumberRow = { number: string; name: string; forwardTo: string; textingOn: boolean; zips: string; areaCodes: string; isNew?: boolean };
type AdSetRow = { words: string; number: string };
type Pick = { number: string; name: string; matchedBy: string; reason: string; skipped: string[] };
type RecentPick = { at: string; phoneLast4: string; number: string; reason: string; skipped: string[] };
type HatchResult = { ok: true; inHatch: boolean; lastAt: string | null; workspace: string | null; contacts: number } | { ok: false; error: string };

type Loaded = {
  numbers: { number: string; name: string; forwardTo: string | null; textingOn: boolean; zips: string[]; areaCodes: string[]; updatedAt: string | null; updatedBy: string | null }[];
  adSets: AdSetRow[];
  serviceNumbers: string[] | null;
  picks: RecentPick[];
  defaultNumber: string;
  hatchGuard: { on: boolean; days: number };
};

function pretty(e164: string): string {
  const d = (e164 || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164;
}

function when(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const MATCHED: Record<string, string> = { ad_set: "Ad set", zip: "ZIP", area_code: "Their area code", default: "Default number" };

export default function TextingNumbers() {
  const [data, setData] = useState<Loaded | null>(null);
  const [numbers, setNumbers] = useState<NumberRow[]>([]);
  const [adSets, setAdSets] = useState<AdSetRow[]>([]);
  const [error, setError] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [test, setTest] = useState({ adSet: "", zip: "", phone: "" });
  const [pick, setPick] = useState<Pick | null>(null);
  const [hatchPhone, setHatchPhone] = useState("");
  const [hatch, setHatch] = useState<HatchResult | null>(null);
  const [hatchBusy, setHatchBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    const res = await fetch("/api/sms/numbers", { cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError(body?.error || `Couldn't load (HTTP ${res.status}).`); return; }
    const loaded = body as Loaded;
    setData(loaded);
    setNumbers(loaded.numbers.map((n) => ({
      number: n.number, name: n.name, forwardTo: n.forwardTo ? pretty(n.forwardTo) : "", textingOn: n.textingOn,
      zips: n.zips.join(", "), areaCodes: n.areaCodes.join(", "),
    })));
    setAdSets(loaded.adSets);
    setDirty(false);
  }, []);

  useEffect(() => {
    // Fetch once when the page opens (same pattern as the other owner pages).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function editNumber(i: number, patch: Partial<NumberRow>) {
    setNumbers((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setDirty(true);
  }
  function editAdSet(i: number, patch: Partial<AdSetRow>) {
    setAdSets((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setDirty(true);
  }

  async function save() {
    setSaving(true); setStatus(""); setProblems([]);
    const res = await fetch("/api/sms/numbers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save", numbers, adSets }),
    });
    const body = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setProblems(body?.problems || [body?.error || `Not saved (HTTP ${res.status}).`]); return; }
    setStatus("Saved. New leads use this setup from now on.");
    await load();
  }

  async function runTest() {
    setPick(null);
    const res = await fetch("/api/sms/numbers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "test", ...test }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) setPick(body.pick);
    else setError(body?.error || "Check failed.");
  }

  async function runHatchCheck() {
    setHatch(null); setHatchBusy(true);
    const res = await fetch("/api/sms/numbers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "hatch_check", phone: hatchPhone }),
    });
    const body = await res.json().catch(() => ({}));
    setHatchBusy(false);
    if (res.ok) setHatch(body.hatch);
    else setError(body?.error || "Hatch check failed.");
  }

  const service = data?.serviceNumbers ?? null;
  const savedNumbers = new Set((data?.numbers || []).map((n) => n.number));
  const options = numbers.filter((n) => savedNumbers.has(n.number));

  return (
    <div className="team-page">
      <section className="surface team-form">
        <h2>How a new lead gets its number</h2>
        <ol className="team-hint" style={{ margin: "0 0 8px 0", paddingLeft: 22, listStyle: "decimal" }}>
          <li><b>Ad set:</b> the ad set name from the Zap contains the words below (&quot;Chico&quot; matches &quot;Chico - Doors Nov&quot;).</li>
          <li><b>ZIP</b> from the form: an exact 5-digit ZIP first, then its first 3 digits.</li>
          <li><b>Their phone&apos;s area code.</b></li>
          <li>Otherwise the <b>default number {data ? pretty(data.defaultNumber) : ""}</b>.</li>
        </ol>
        <p className="team-hint">
          Only numbers with <b>Texting for new leads</b> checked are used (the default number always is). A customer keeps their number
          after that, and if they text one of our other numbers, Denny answers from the one they texted. Changes here never move existing chats.
        </p>
        <div className="hero-actions" style={{ marginTop: 10 }}>
          <a className="btn btn-outline" href="/sms-test">Back to the test page</a>
          <button className="btn btn-outline" onClick={() => void load()}>Refresh</button>
        </div>
        {error && <div className="notice" style={{ marginTop: 12 }}>{error}</div>}
      </section>

      <section className="surface team-list">
        <h2>Our numbers</h2>
        {!data ? <p className="team-hint">Loading…</p> : (
          <div className="owner-table-wrap">
            <table className="team-table sms-numbers-table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Name (shown in the inbox)</th>
                  <th>Texting for new leads</th>
                  <th>Calls forward to (ServiceTitan line)</th>
                  <th>ZIPs (5 digits or first 3)</th>
                  <th>Customer area codes</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {numbers.map((n, i) => {
                  const isDefault = n.number === data.defaultNumber;
                  const inService = service ? service.includes(n.number) : null;
                  return (
                    <tr key={n.isNew ? `new-${i}` : n.number}>
                      <td>
                        {n.isNew
                          ? <input value={n.number} placeholder="(530) 555-1234" onChange={(e) => editNumber(i, { number: e.target.value })} />
                          : <b>{pretty(n.number)}</b>}
                        {!n.isNew && (
                          <div className="team-hint" style={{ fontSize: 13 }}>
                            {inService === null ? "Twilio check unavailable" : inService ? "✓ in Den Defenders service" : "⚠ not in the Den Defenders Messaging Service"}
                            {isDefault ? " · default" : ""}
                          </div>
                        )}
                      </td>
                      <td><input value={n.name} onChange={(e) => editNumber(i, { name: e.target.value })} /></td>
                      <td>
                        <label className="team-check">
                          <input type="checkbox" checked={isDefault || n.textingOn} disabled={isDefault} onChange={(e) => editNumber(i, { textingOn: e.target.checked })} />
                          <span>{isDefault ? "Always on" : n.textingOn ? "On" : "Off"}</span>
                        </label>
                      </td>
                      <td><input value={n.forwardTo} placeholder="Not set: calls go to (916) 409-6367" onChange={(e) => editNumber(i, { forwardTo: e.target.value })} /></td>
                      <td><textarea rows={2} value={n.zips} onChange={(e) => editNumber(i, { zips: e.target.value })} /></td>
                      <td><input value={n.areaCodes} onChange={(e) => editNumber(i, { areaCodes: e.target.value })} /></td>
                      <td className="team-actions">
                        {!isDefault && (
                          <button className="team-link" onClick={() => { setNumbers((rows) => rows.filter((_, j) => j !== i)); setDirty(true); }}>Remove</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="hero-actions" style={{ marginTop: 12 }}>
          <button className="btn btn-outline" onClick={() => { setNumbers((rows) => [...rows, { number: "", name: "", forwardTo: "", textingOn: false, zips: "", areaCodes: "", isNew: true }]); setDirty(true); }}>
            Add a number
          </button>
        </div>
        <p className="team-hint" style={{ marginTop: 8 }}>
          Buy the number in Twilio and add it to the Den Defenders Messaging Service first. &quot;Calls forward to&quot; is used once Denny answers the calls (next update).
        </p>
      </section>

      <section className="surface team-list">
        <h2>Ad sets</h2>
        <p className="team-hint">Words to look for in the ad set name, and the number those leads get. Longer words win (&quot;san jose&quot; before &quot;jose&quot;).</p>
        <div className="owner-table-wrap">
          <table className="team-table sms-numbers-table">
            <thead><tr><th>Ad set words</th><th>Number</th><th></th></tr></thead>
            <tbody>
              {adSets.map((a, i) => (
                <tr key={i}>
                  <td><input value={a.words} onChange={(e) => editAdSet(i, { words: e.target.value })} /></td>
                  <td>
                    <select value={a.number} onChange={(e) => editAdSet(i, { number: e.target.value })}>
                      <option value="">Pick a number…</option>
                      {options.map((n) => <option key={n.number} value={n.number}>{n.name || pretty(n.number)} · {pretty(n.number)}</option>)}
                    </select>
                  </td>
                  <td className="team-actions">
                    <button className="team-link" onClick={() => { setAdSets((rows) => rows.filter((_, j) => j !== i)); setDirty(true); }}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="hero-actions" style={{ marginTop: 12 }}>
          <button className="btn btn-outline" onClick={() => { setAdSets((rows) => [...rows, { words: "", number: "" }]); setDirty(true); }}>Add an ad set</button>
        </div>
      </section>

      <section className="surface team-form">
        <div className="hero-actions">
          <button className="btn btn-teal" disabled={saving || !dirty} onClick={() => void save()}>{saving ? "Saving…" : "Save changes"}</button>
          {dirty && <span className="team-hint">Unsaved changes</span>}
        </div>
        {problems.length > 0 && (
          <div className="notice" style={{ marginTop: 12 }}>
            {problems.map((p) => <div key={p}>⚠ {p}</div>)}
          </div>
        )}
        {status && <div className="notice" style={{ marginTop: 12 }}>{status}</div>}
      </section>

      <section className="surface team-form">
        <h2>Which number would this lead get?</h2>
        <p className="team-hint">Uses the saved setup. Nothing is texted or saved.</p>
        <div className="team-grid" style={{ alignItems: "end" }}>
          <label><span>Ad set name</span><input value={test.adSet} placeholder="Chico" onChange={(e) => setTest({ ...test, adSet: e.target.value })} /></label>
          <label><span>ZIP</span><input value={test.zip} placeholder="95926" onChange={(e) => setTest({ ...test, zip: e.target.value })} /></label>
          <label><span>Their phone</span><input value={test.phone} placeholder="(530) 555-1234" onChange={(e) => setTest({ ...test, phone: e.target.value })} /></label>
          <button className="btn btn-outline" onClick={() => void runTest()}>Check</button>
        </div>
        {pick && (
          <div className="notice" style={{ marginTop: 12 }}>
            <b>{pick.name} · {pretty(pick.number)}</b> ({MATCHED[pick.matchedBy] || pick.matchedBy}: {pick.reason})
            {pick.skipped.map((s) => <div key={s}>Skipped: {s}</div>)}
          </div>
        )}
      </section>

      <section className="surface team-form">
        <h2>Hatch guard</h2>
        <p className="team-hint">
          {data ? <b>{data.hatchGuard.on ? "ON" : "OFF (SMS_HATCH_GUARD)"}</b> : "…"}. A new lead Hatch had in the last {data?.hatchGuard.days ?? 60} days gets the
          &quot;we switched&quot; text instead of the welcome, and Denny&apos;s drip waits until someone clicks <b>Stopped in Hatch</b> in the inbox.
          The Hatch copy syncs about once a day.
        </p>
        <div className="team-grid" style={{ alignItems: "end" }}>
          <label><span>Is this phone in Hatch?</span><input value={hatchPhone} placeholder="(209) 555-1234" onChange={(e) => setHatchPhone(e.target.value)} /></label>
          <button className="btn btn-outline" disabled={hatchBusy || !hatchPhone.trim()} onClick={() => void runHatchCheck()}>{hatchBusy ? "Checking…" : "Check Hatch"}</button>
        </div>
        {hatch && (
          <div className="notice" style={{ marginTop: 12 }}>
            {!hatch.ok
              ? <>⚠ Couldn&apos;t check Hatch: {hatch.error}. New leads get the normal welcome while this fails.</>
              : hatch.inHatch
                ? <>In Hatch: last activity {hatch.lastAt ? when(hatch.lastAt) : "recently"}{hatch.workspace ? ` (${hatch.workspace})` : ""}. A new lead from this phone would get the &quot;we switched&quot; text and wait for Stopped in Hatch.</>
                : <>Not in Hatch in the last {data?.hatchGuard.days ?? 60} days{hatch.lastAt ? ` (last activity ${when(hatch.lastAt)})` : ""}. A new lead from this phone gets the normal welcome.</>}
          </div>
        )}
      </section>

      <section className="surface team-list">
        <h2>Recent new leads</h2>
        {!data || data.picks.length === 0 ? <p className="team-hint">No leads have been given a number yet.</p> : (
          <div className="owner-table-wrap">
            <table className="team-table">
              <thead><tr><th>When</th><th>Lead</th><th>Number</th><th>Why</th></tr></thead>
              <tbody>
                {data.picks.map((p, i) => (
                  <tr key={i}>
                    <td>{when(p.at)}</td>
                    <td>…{p.phoneLast4}</td>
                    <td>{numbers.find((n) => n.number === p.number)?.name || ""} {pretty(p.number)}</td>
                    <td>{p.reason}{p.skipped.map((s) => <div key={s} className="team-hint">Skipped: {s}</div>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

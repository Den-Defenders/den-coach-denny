"use client";

/**
 * Session 6 PR 2: "Hatch opt-outs" box on /sms-test (owners only).
 * Scan stored Hatch texts week by week for STOP/START, review the counts,
 * then add the STOP numbers to Denny's opt-out list. Full phone numbers never
 * reach the browser (lib/sms/hatchOptOuts.ts masks the samples).
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Summary = {
  stopTexts: number;
  numbersToAdd: number;
  alreadyOptedOut: number;
  resubscribed: number;
  onAllowList: number;
  noPhone: number;
  imported: number;
  oldest: string | null;
  newest: string | null;
  byWorkspace: { workspace: string; count: number }[];
  samples: { phone: string; date: string; workspace: string | null; text: string | null }[];
};

const FIRST_DAY = "2026-05-25";

function yesterday(): string {
  const d = new Date(Date.now() - 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d);
}
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function shortDay(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
}

async function post(body: Record<string, unknown>) {
  const response = await fetch("/api/sms/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.message || `Error ${response.status}`);
  return data;
}

export default function HatchOptOuts() {
  const [start, setStart] = useState(FIRST_DAY);
  const [end, setEnd] = useState(yesterday());
  const [summary, setSummary] = useState<Summary | null>(null);
  const [progress, setProgress] = useState("");
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const stopRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const data = await post({ action: "hatch_summary" });
      setSummary(data.summary);
    } catch (error) {
      setProgress(error instanceof Error ? error.message : "Could not load the Hatch summary.");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  async function scan() {
    setBusy(true);
    stopRef.current = false;
    setNotes([]);
    const weeks: [string, string][] = [];
    for (let d = start; d <= end; d = addDays(d, 7)) {
      const last = addDays(d, 6);
      weeks.push([d, last < end ? last : end]);
    }
    let stops = 0;
    try {
      for (let i = 0; i < weeks.length; i++) {
        if (stopRef.current) { setProgress(`Stopped after week ${i} of ${weeks.length}.`); break; }
        const [s, e] = weeks[i];
        setProgress(`Scanning week ${i + 1} of ${weeks.length} (${s} to ${e})… ${stops} STOP texts so far`);
        const data = await post({ action: "hatch_scan", start: s, end: e });
        stops += data.result.stops;
        if (data.result.notes?.length) setNotes((n) => [...n, ...data.result.notes]);
        if (i === weeks.length - 1) setProgress(`Scan done: ${weeks.length} week${weeks.length === 1 ? "" : "s"}, ${stops} STOP texts found. Review the numbers below.`);
      }
    } catch (error) {
      setProgress(`Scan stopped: ${error instanceof Error ? error.message : "error"}. Click Scan again to retry (weeks already scanned are kept).`);
    }
    await refresh();
    setBusy(false);
  }

  async function importNow() {
    if (!summary?.numbersToAdd) return;
    if (!window.confirm(`Add ${summary.numbersToAdd} numbers to Denny's opt-out list? They will never get a text from Denny unless they text START.`)) return;
    setBusy(true);
    try {
      const data = await post({ action: "hatch_import" });
      setSummary(data.summary);
      setProgress(data.message);
    } catch (error) {
      setProgress(`Import failed: ${error instanceof Error ? error.message : "error"}`);
    }
    setBusy(false);
  }

  async function clearScan() {
    if (!window.confirm("Forget the scan results and start over? (Numbers already added to the opt-out list stay opted out.)")) return;
    setBusy(true);
    try {
      const data = await post({ action: "hatch_clear_scan" });
      setSummary(data.summary);
      setProgress("Scan results cleared.");
    } catch (error) {
      setProgress(error instanceof Error ? error.message : "Could not clear.");
    }
    setBusy(false);
  }

  return (
    <section className="surface team-list">
      <h2>Hatch opt-outs (before real leads get texts)</h2>
      <p className="team-hint">
        Finds everyone who texted STOP (or similar) to a Hatch number and adds them to Denny&apos;s opt-out list, so they never get a drip or AI text from the new number.
        A START after their STOP counts as resubscribed and is left alone. Pilot test numbers are skipped. Hatch history is stored from May 25, 2026; ask Claude to sync the latest Hatch days first.
      </p>
      <div className="team-grid" style={{ alignItems: "end", marginBottom: 10 }}>
        <label><span>From</span><input type="date" value={start} min={FIRST_DAY} onChange={(e) => setStart(e.target.value)} /></label>
        <label><span>To</span><input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn btn-teal" disabled={busy || !start || !end || end < start} onClick={scan}>1. Scan Hatch</button>
          {busy && <button className="btn btn-outline" onClick={() => { stopRef.current = true; }}>Stop</button>}
        </div>
      </div>
      {progress && <div className="notice" style={{ marginBottom: 10 }}>{progress}</div>}
      {notes.map((n) => <div key={n} className="team-hint">⚠ {n}</div>)}
      {summary && (
        <>
          <ul style={{ listStyle: "none", padding: 0, margin: "0 0 10px", display: "grid", gap: 4 }}>
            <li><b>{summary.numbersToAdd}</b> numbers to add (newest Hatch text was a STOP)</li>
            <li className="team-hint">{summary.stopTexts} STOP texts scanned · texts from {shortDay(summary.oldest)} to {shortDay(summary.newest)}</li>
            <li className="team-hint">{summary.alreadyOptedOut} already opted out in Denny · {summary.resubscribed} resubscribed in Hatch (START after STOP) · {summary.onAllowList} on the pilot test list (skipped) · {summary.noPhone} STOP texts with no phone in the Hatch copy</li>
            <li className="team-hint">Already added from Hatch: <b>{summary.imported}</b></li>
          </ul>
          {summary.byWorkspace.length > 0 && (
            <p className="team-hint" style={{ marginBottom: 8 }}>By Hatch number: {summary.byWorkspace.map((w) => `${w.workspace} ${w.count}`).join(" · ")}</p>
          )}
          {summary.samples.length > 0 && (
            <div className="owner-table-wrap" style={{ marginBottom: 10 }}>
              <table className="team-table">
                <thead><tr><th>Number (masked)</th><th>STOP date</th><th>Hatch number</th><th>What they texted</th></tr></thead>
                <tbody>{summary.samples.map((s) => <tr key={`${s.phone}-${s.date}`}><td>{s.phone}</td><td>{s.date}</td><td>{s.workspace || "—"}</td><td>{s.text || "—"}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-teal" disabled={busy || !summary.numbersToAdd} onClick={importNow}>2. Add {summary.numbersToAdd} to Denny&apos;s opt-out list</button>
            <button className="btn btn-outline" disabled={busy} onClick={clearScan}>Clear scan results</button>
          </div>
        </>
      )}
    </section>
  );
}

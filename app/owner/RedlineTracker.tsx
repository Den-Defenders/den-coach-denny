"use client";

import { useEffect, useMemo, useState } from "react";
import { mondaySlackUpdate, redlineMath, type RedlineSnapshot } from "@/lib/ownerRedline";

const RED = "#e0393e";
const TEAL = "#27b9ab";
const NAVY = "#062b45";
const AMBER = "#f1b84b";

const usd = (n: number | null | undefined) => n == null ? "—" : `${n < 0 ? "-" : ""}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
const k = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(2)}m` : `$${Math.round(n / 1000)}k`;
const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function Ruler({ s, projected }: { s: RedlineSnapshot; projected: number }) {
  const max = Math.max(s.backlog, projected, s.redline) * 1.2;
  const w = 1000, left = 20, right = 20, span = w - left - right;
  const x = (v: number) => left + Math.max(0, Math.min(1, v / max)) * span;
  const ticks = Array.from({ length: 5 }, (_, i) => (max / 4) * i);
  return <svg className="owner-redline-ruler" viewBox={`0 0 ${w} 150`} role="img"
    aria-label={`Ruler: backlog today ${usd(s.backlog)}, projected ${day(s.targetDate)} ${usd(projected)}, redline ${usd(s.redline)}`}>
    {ticks.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1="112" y2="120" stroke="#9fb3bf" /><text x={x(t)} y="138" textAnchor="middle" fontSize="15" fill="#688094">{k(t)}</text></g>)}
    <line x1={left} x2={w - right} y1="112" y2="112" stroke="#c9d6dc" strokeWidth="2" />
    <text x={left} y="22" fontSize="15" fill="#526b7e" fontWeight="800">TODAY · <tspan fill={NAVY}>{usd(s.backlog)}</tspan></text>
    <rect x={left} y="30" width={span} height="26" rx="6" fill="#edf3f4" />
    <rect x={left} y="30" width={x(s.backlog) - left} height="26" rx="6" fill={TEAL} />
    <text x={left} y="78" fontSize="15" fill="#526b7e" fontWeight="800">{day(s.targetDate).toUpperCase()} AT TODAY&apos;S PACE · <tspan fill={projected < s.redline ? RED : NAVY}>{usd(projected)}</tspan></text>
    <rect x={left} y="84" width={span} height="18" rx="5" fill="#edf3f4" />
    <rect x={left} y="84" width={x(projected) - left} height="18" rx="5" fill={projected < s.redline ? RED : AMBER} />
    <line x1={x(s.redline)} x2={x(s.redline)} y1="6" y2="120" stroke={RED} strokeWidth="4" />
    <text x={x(s.redline) + 7} y="14" fontSize="14" fontWeight="900" fill={RED}>REDLINE {k(s.redline)}</text>
  </svg>;
}

function BacklogChart({ s, projection }: { s: RedlineSnapshot; projection: { date: string; backlog: number }[] }) {
  const history = s.weeks.filter((w) => w.backlogAtStart !== null && w.weekStart <= s.snapshotDate)
    .map((w) => ({ date: w.weekStart, backlog: w.backlogAtStart! }));
  if (!history.length || history.at(-1)!.date !== s.snapshotDate) history.push({ date: s.snapshotDate, backlog: s.backlog });
  const all = [...history, ...projection];
  const start = all[0].date, end = s.targetDate;
  const totalDays = Math.max(1, (Date.parse(end) - Date.parse(start)) / 86400000);
  const max = Math.max(s.redline, ...all.map((p) => p.backlog)) * 1.12;
  const w = 1000, h = 300, left = 72, right = 24, top = 18, bottom = 40;
  const x = (d: string) => left + ((Date.parse(d) - Date.parse(start)) / 86400000) / totalDays * (w - left - right);
  const y = (v: number) => top + (1 - v / max) * (h - top - bottom);
  const line = (pts: { date: string; backlog: number }[]) => pts.map((p) => `${x(p.date)},${y(p.backlog)}`).join(" ");
  const monthTicks: string[] = [];
  for (let d = new Date(`${start}T12:00:00Z`); d <= new Date(`${end}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDate() === 1) monthTicks.push(d.toISOString().slice(0, 10));
  }
  return <div className="owner-chart-wrap">
    <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Backlog from ${day(start)} to today and projected to ${day(end)} against the ${usd(s.redline)} redline`}>
      {[0, .25, .5, .75, 1].map((t) => <g key={t}>
        <line x1={left} x2={w - right} y1={y(max * t)} y2={y(max * t)} stroke="#dce6e8" strokeDasharray="4 5" />
        <text x={left - 10} y={y(max * t) + 4} textAnchor="end" fill="#688094" fontSize="13">{k(max * t)}</text>
      </g>)}
      {monthTicks.map((m) => <text key={m} x={x(m)} y={h - 12} textAnchor="middle" fill="#688094" fontSize="14">{new Date(`${m}T12:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" })}</text>)}
      <rect x={left} y={y(s.redline)} width={w - left - right} height={h - bottom - y(s.redline)} fill={RED} opacity=".06" />
      <line x1={left} x2={w - right} y1={y(s.redline)} y2={y(s.redline)} stroke={RED} strokeWidth="3" />
      <text x={w - right} y={y(s.redline) - 8} textAnchor="end" fill={RED} fontSize="14" fontWeight="900">REDLINE {usd(s.redline)}</text>
      <line x1={x(s.snapshotDate)} x2={x(s.snapshotDate)} y1={top} y2={h - bottom} stroke="#9fb3bf" strokeDasharray="3 4" />
      <text x={x(s.snapshotDate) + 6} y={top + 12} fill="#526b7e" fontSize="13" fontWeight="800">TODAY</text>
      {history.length > 1 && <polyline points={line(history)} fill="none" stroke={TEAL} strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" />}
      <polyline points={line(projection)} fill="none" stroke={TEAL} strokeWidth="3" strokeDasharray="9 7" strokeLinecap="round" />
      {history.map((p) => <circle key={p.date} cx={x(p.date)} cy={y(p.backlog)} r="5" fill={TEAL}><title>{`${day(p.date)}: ${usd(p.backlog)}`}</title></circle>)}
      <circle cx={x(end)} cy={y(projection.at(-1)!.backlog)} r="7" fill={projection.at(-1)!.backlog < s.redline ? RED : TEAL} stroke="#fff" strokeWidth="2">
        <title>{`Projected ${day(end)}: ${usd(projection.at(-1)!.backlog)}`}</title>
      </circle>
    </svg>
    <div className="owner-legend"><span><i style={{ background: TEAL }} />Backlog (solid = measured Mondays)</span><span>Dashed = projected at the last 30 days&apos; pace</span><span><i style={{ background: RED }} />Redline</span></div>
  </div>;
}

export default function RedlineTracker() {
  const [snapshot, setSnapshot] = useState<RedlineSnapshot | null>(null);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [copied, setCopied] = useState(false);
  const [uploading, setUploading] = useState(false);

  async function refresh() {
    try {
      const res = await fetch("/api/owner/redline", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load the redline snapshot.");
      setSnapshot(data.snapshot); setConfigured(data.configured);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not load the redline snapshot."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  async function importFile(file: File) {
    setUploading(true); setStatus("");
    try {
      if (file.size > 200_000) throw new Error("JSON exceeds 200 KB.");
      const res = await fetch("/api/owner/redline", { method: "POST", headers: { "Content-Type": "application/json" }, body: await file.text() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed.");
      setStatus(`Imported the ${day(data.snapshotDate)} snapshot.`);
      await refresh();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Import failed."); }
    finally { setUploading(false); }
  }

  const math = useMemo(() => snapshot ? redlineMath(snapshot) : null, [snapshot]);
  const slack = useMemo(() => snapshot && math ? mondaySlackUpdate(snapshot, math) : "", [snapshot, math]);

  async function copy() {
    try { await navigator.clipboard.writeText(slack); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { setStatus("Copy didn't work in this browser. Select the text and copy it instead."); }
  }

  const importBox = <div className="owner-import owner-redline-import">
    <label htmlFor="owner-redline-file">Import Monday snapshot</label>
    <input id="owner-redline-file" type="file" accept="application/json,.json" disabled={uploading || !configured}
      onChange={(e) => { const file = e.target.files?.[0]; if (file) void importFile(file); e.currentTarget.value = ""; }} />
    <small>{configured ? "Owner only · the newest Monday is shown. Earlier snapshots stay saved." : "The private reporting database must be connected before snapshots can be saved."}</small>
  </div>;

  if (!snapshot || !math) {
    return <section className="owner-redline owner-redline-empty surface" aria-label="Feb 1 redline tracker">
      <div>
        <span className="owner-section-label">FEB 1 REDLINE · MONDAY SNAPSHOT</span>
        <h2>{loading ? "Loading the redline…" : "Redline tracker is ready for its first Monday"}</h2>
        <p>Shows sold backlog against the $350K redline, how far installs out-paced sales in the last 30 days, and the weekly install allowance that lands on the redline by Feb 1. No numbers are shown until a real ServiceTitan snapshot is imported.</p>
        {status && <p className="notice" role="status">{status}</p>}
      </div>
      {importBox}
    </section>;
  }

  const s = snapshot;
  const statusLabel = math.status === "below" ? "Below the redline" : math.status === "close" ? "Close to the redline" : "Above the redline";
  const soldPct = Math.max(s.last30.sold, s.last30.installed) > 0 ? s.last30.sold / Math.max(s.last30.sold, s.last30.installed) * 100 : 0;
  const installedPct = Math.max(s.last30.sold, s.last30.installed) > 0 ? s.last30.installed / Math.max(s.last30.sold, s.last30.installed) * 100 : 0;

  return <section className="owner-redline surface" aria-label="Feb 1 redline tracker">
    <div className="owner-chart-heading">
      <div>
        <span className="owner-section-label">FEB 1 REDLINE · MONDAY {day(s.snapshotDate).toUpperCase()} SNAPSHOT</span>
        <h2>Redline tracker</h2>
        <p>Sold Security work not yet installed (Hold not counted), measured against the {usd(s.redline)} redline for {day(s.targetDate)}.</p>
      </div>
      <b className={`owner-redline-pill ${math.status}`}>{statusLabel}</b>
    </div>
    {status && <p className="notice" role="status">{status}</p>}

    <div className="owner-redline-stats">
      <article><span>Sold backlog today</span><strong>{usd(s.backlog)}</strong><small>{math.backlogChange30 !== null ? `${math.backlogChange30 >= 0 ? "Up" : "Down"} ${usd(Math.abs(math.backlogChange30))} from ${usd(math.backlog30DaysAgo)} 30 days ago` : "30-day comparison not in this snapshot"}</small></article>
      <article><span>Projected {day(s.targetDate)}</span><strong className={math.cushion < 0 ? "bad" : ""}>{usd(math.projectedAtTarget)}</strong><small>If the last {math.windowDays} days&apos; pace keeps going</small></article>
      <article><span>Vs redline</span><strong className={math.cushion < 0 ? "bad" : "good"}>{math.cushion >= 0 ? "+" : ""}{usd(math.cushion)}</strong><small>{math.crossesRedline ? `Crosses the line the week of ${day(math.crossesRedline)}` : `Stays above through ${day(s.targetDate)}`}</small></article>
      <article><span>Install allowance</span><strong>{usd(math.allowancePerWeek)}<em>/wk</em></strong><small>Now installing {usd(math.installsPerWeek)}/wk · {math.weeksLeft.toFixed(1)} weeks left</small></article>
    </div>

    <Ruler s={s} projected={math.projectedAtTarget} />
    <BacklogChart s={s} projection={math.projection} />

    <div className="owner-redline-split">
      <div className="owner-detail">
        <span className="owner-section-label">LAST {math.windowDays} DAYS · {day(s.last30.start).toUpperCase()} – {day(s.last30.end).toUpperCase()}</span>
        <h3>Sold vs installed</h3>
        <div className="owner-redline-bars">
          <span>Sold</span><div><i style={{ width: `${soldPct}%`, background: TEAL }} /></div><b>{usd(s.last30.sold)}</b>
          <span>Installed</span><div><i style={{ width: `${installedPct}%`, background: NAVY }} /></div><b>{usd(s.last30.installed)}</b>
        </div>
        <p className={math.outpaceGap > 0 ? "owner-redline-callout bad" : "owner-redline-callout good"}>
          {math.outpaceGap > 0
            ? <>Installs out-paced sales by <strong>{usd(math.outpaceGap)}</strong>{math.outpacePct !== null && <> ({Math.round(math.outpacePct * 100)}%)</>}.</>
            : <>Sales kept up: <strong>{usd(-math.outpaceGap)}</strong> more sold than installed.</>}
          {math.ratio !== null && <> Sold-to-installed ratio <strong>{math.ratio.toFixed(2)}</strong> (1.00 is even).</>}
        </p>
      </div>
      <div className="owner-detail">
        <span className="owner-section-label">TO LAND ON THE REDLINE</span>
        <h3>What has to give</h3>
        <div className="owner-breakdown">
          <span>Install allowance per week</span><strong>{usd(math.allowancePerWeek)}</strong>
          <span>Current install pace per week</span><strong>{usd(math.installsPerWeek)}</strong>
          {math.installCutPerWeek > 0 && <><span>Bring installs down by</span><strong className="bad">{usd(math.installCutPerWeek)}/wk</strong></>}
          <span>{math.installCutPerWeek > 0 ? "…or sell per week" : "Sales needed per week"}</span><strong>{usd(math.salesNeededPerWeek)}</strong>
          <span>Current sales pace per week</span><strong>{usd(math.salesPerWeek)}</strong>
          {math.roomLeftToBook !== null && <><span>{math.roomLeftToBook >= 0 ? `Room left to book before ${day(s.targetDate)}` : `Booked past the room before ${day(s.targetDate)}`}</span><strong className={math.roomLeftToBook < 0 ? "bad" : ""}>{usd(Math.abs(math.roomLeftToBook))}</strong></>}
          {s.holdBacklog !== null && <><span>On Hold (not counted)</span><strong>{usd(s.holdBacklog)}</strong></>}
        </div>
      </div>
    </div>

    {s.regions.length > 0 && <div className="owner-table-wrap owner-redline-regions"><table>
      <thead><tr><th>Region</th><th>Backlog</th><th>Sold 30d</th><th>Installed 30d</th><th>Sold ÷ installed</th><th>Weeks out</th></tr></thead>
      <tbody>{s.regions.map((r) => {
        const ratio = r.sold30 !== null && r.installed30 ? r.sold30 / r.installed30 : null;
        return <tr key={r.name}><td>{r.name}</td><td>{usd(r.backlog)}</td><td>{usd(r.sold30)}</td><td>{usd(r.installed30)}</td>
          <td className={ratio !== null && ratio < 1 ? "bad" : ""}>{ratio === null ? "—" : ratio.toFixed(2)}</td><td>{r.weeksOut ?? "—"}</td></tr>;
      })}</tbody>
    </table></div>}

    <div className="owner-redline-slack">
      <div className="owner-redline-slack-head"><span className="owner-section-label">MONDAY UPDATE FOR MIKE</span>
        <button type="button" onClick={() => void copy()}>{copied ? "Copied" : "Copy for Slack"}</button></div>
      <pre>{slack}</pre>
    </div>

    <details className="owner-method">
      <summary>How these numbers work</summary>
      <ol>
        <li><strong>Projected {day(s.targetDate)}</strong> = backlog today + ({usd(math.salesPerWeek)} sold − {usd(math.installsPerWeek)} installed per week) × {math.weeksLeft.toFixed(1)} weeks. The paces come from the last {math.windowDays} days.</li>
        <li><strong>Install allowance</strong> = (backlog + expected sales − redline) ÷ weeks left. Installing more than this per week takes the backlog under the redline unless sales pick up.</li>
        <li><strong>Room left to book</strong> = total allowance before {day(s.targetDate)} minus install revenue already on the calendar before that date.</li>
        <li>Cancellations, price changes and Hold releases also move the backlog, so the Monday measured number can differ from last week&apos;s projection.</li>
        <li>Source: {s.source} · created {new Date(s.generatedAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT{s.notes.map((n, i) => <span key={i}><br />{n}</span>)}</li>
      </ol>
    </details>
    {importBox}
  </section>;
}

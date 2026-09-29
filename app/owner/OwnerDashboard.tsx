"use client";

import { useEffect, useState } from "react";
import type { OwnerReport, PeriodRow } from "@/lib/ownerReport";

type View = "weekly" | "daily";
type Metric = "revenuePipeline" | "cashflowPipeline" | "netCash" | "sales" | "deposits" | "installPayments";
const COLORS: Record<number, string> = { 2024: "#a4abb4", 2025: "#f1b84b", 2026: "#26b9ac", 2027: "#ed7067" };
const money = (n: number | null | undefined) => n == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
const exactMoney = (n: number | null | undefined) => n == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
const short = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(1)}m` : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`;
const dayLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const numeric = (n: number | null) => n == null ? null : n;

function Chart({ rows, metric, year, weekly, reconciled }: { rows: PeriodRow[]; metric: Metric; year: number; weekly: boolean; reconciled: boolean }) {
  const series = [2024, 2025, 2026, 2027].map((y) => ({
    year: y, points: rows.filter((r) => Number(r.date.slice(0, 4)) === y && numeric(r[metric]) !== null),
  })).filter((s) => s.points.length);
  if (!series.length) return <div className="owner-empty-chart">No measured points yet. Import a verified report to draw this chart.</div>;
  const max = Math.max(1, ...series.flatMap((s) => s.points.map((r) => Math.max(0, r[metric] || 0))));
  const w = 1000, h = 300, left = 70, right = 18, top = 20, bottom = 42;
  const x = (date: string) => {
    const month = Number(date.slice(5, 7)), day = Number(date.slice(8, 10));
    const doy = (Date.UTC(2025, month - 1, day) - Date.UTC(2025, 0, 1)) / 86400000;
    return left + Math.max(0, Math.min(1, doy / 364)) * (w - left - right);
  };
  const y = (value: number) => top + (1 - Math.max(0, value) / max) * (h - top - bottom);
  const segments = (points: PeriodRow[]) => {
    const out: PeriodRow[][] = [];
    for (const point of points) {
      const prev = out[out.length - 1];
      // A gap stays blank; it does not become an invented observation.
      const gap = prev?.length ? (Date.parse(point.date) - Date.parse(prev[prev.length - 1].date)) / 86400000 : 0;
      const limit = weekly ? 9 : 2;
      if (!prev || gap > limit || prev[prev.length - 1].quality !== point.quality) out.push([point]);
      else prev.push(point);
    }
    return out;
  };
  return <div className="owner-chart-wrap">
    <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${metric} by calendar date, comparing 2024 through 2027`}>
      {[0, .25, .5, .75, 1].map((tick) => <g key={tick}>
        <line x1={left} x2={w-right} y1={y(max*tick)} y2={y(max*tick)} stroke="#dce6e8" strokeDasharray="4 5" />
        <text x={left-10} y={y(max*tick)+4} textAnchor="end" fill="#688094" fontSize="13">{short(max*tick)}</text>
      </g>)}
      {[1, 3, 5, 7, 9, 11].map((month) => <text key={month} x={x(`2025-${String(month).padStart(2,"0")}-01`)} y={h-12} fill="#688094" fontSize="14">{new Date(Date.UTC(2025,month-1,1)).toLocaleString("en-US",{month:"short",timeZone:"UTC"})}</text>)}
      {series.map((s) => segments(s.points).map((part, i) => <g key={`${s.year}-${i}`}>
        {part.length > 1 && <polyline fill="none" stroke={COLORS[s.year]} strokeWidth={s.year === year ? 4 : 2.2}
          strokeDasharray={part[0].quality === "forecast" ? "8 6" : undefined}
          opacity={s.year === year ? 1 : .66} strokeLinejoin="round" strokeLinecap="round"
          points={part.map((p) => `${x(p.date)},${y(p[metric] || 0)}`).join(" ")} />}
        {part.filter((_, index) => part.length < 8 || index % Math.ceil(part.length / 30) === 0 || index === part.length-1).map((p) => <circle key={p.date} cx={x(p.date)} cy={y(p[metric] || 0)} r={s.year === year ? 4.2 : 3} fill={COLORS[s.year]} opacity={s.year === year ? 1 : .72}>
          <title>{`${p.date}: ${exactMoney(p[metric])} (${reconciled && p.quality === "verified" ? "reconciled base" : p.quality})`}</title>
        </circle>)}
      </g>))}
    </svg>
    <div className="owner-legend">{series.map((s) => <span key={s.year}><i style={{ background: COLORS[s.year] }} />{s.year}</span>)}<span>Dashed = forecast</span></div>
  </div>;
}

function Stat({ label, amount, detail, accent }: { label: string; amount: number | null | undefined; detail: string; accent: string }) {
  return <article className="owner-stat surface" style={{ borderTopColor: accent }}><span>{label}</span><strong>{exactMoney(amount)}</strong><small>{detail}</small></article>;
}

function VerifiedReference() {
  const points = [
    { day: "Sep 14", value: 959463.07, jobs: 154 },
    { day: "Sep 21", value: 990282.65, jobs: 157 },
    { day: "Sep 28", value: 1024752.01, jobs: 154 },
  ];
  const px = [100, 500, 900];
  const py = points.map((point) => 180 - (point.value - 940000) / 100000 * 120);
  return <section className="owner-reference surface"><div><span className="owner-section-label">VERIFIED SEPTEMBER REFERENCE</span><h2>Open install jobs grew each week</h2><p>These three points count <strong>all open qualifying RTI jobs</strong>, excluding Hold. They use a different window than the new three-month weekly chart, so they stay in their own graph.</p></div>
    <div className="owner-reference-graphic"><svg viewBox="0 0 1000 220" role="img" aria-label="Verified all-open revenue: September 14 $959,463; September 21 $990,283; September 28 $1,024,752">
      <line x1="65" x2="935" y1="181" y2="181" stroke="#bfd2d5" strokeWidth="2" />
      <polyline points={px.map((x,i) => `${x},${py[i]}`).join(" ")} fill="none" stroke="#28b9ac" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      {points.map((p,i) => <g key={p.day}><circle cx={px[i]} cy={py[i]} r="9" fill="#28b9ac" stroke="#fff" strokeWidth="3" /><text x={px[i]} y={py[i]-20} textAnchor="middle" fontWeight="800" fontSize="23" fill="#062b45">{money(p.value)}</text><text x={px[i]} y="210" textAnchor="middle" fontSize="17" fill="#526b7e">{p.day} · {p.jobs} jobs</text></g>)}
    </svg></div></section>;
}

export default function OwnerDashboard() {
  const [report, setReport] = useState<OwnerReport | null>(null);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("weekly");
  const [year, setYear] = useState(2026);
  const [status, setStatus] = useState("");
  const [uploading, setUploading] = useState(false);
  async function refresh() {
    try {
      const res = await fetch("/api/owner/report", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load report.");
      setReport(data.report); setConfigured(data.configured);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not load report."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  const allRows = view === "weekly" ? report?.weekly || [] : report?.daily || [];
  const rows = allRows.filter((r) => r.date.startsWith(String(year)));
  const actual = rows.filter((r) => r.quality !== "forecast");
  const latest = actual.at(-1);
  const forecast = rows.filter((r) => r.quality === "forecast");
  const latestForecast = forecast.at(-1);
  const activity = actual.at(-1);
  const previous = actual.at(-2);
  const delta = latest?.revenuePipeline != null && previous?.revenuePipeline != null ? latest.revenuePipeline - previous.revenuePipeline : null;
  const label = view === "weekly" ? "Monday snapshot · next 3 calendar months" : "Day-end snapshot · through Dec 31";
  const initialRebuild = report?.generatedAt === "2026-09-28T23:20:22Z";
  const correctedRebuild = report?.generatedAt === "2026-09-28T23:49:51Z";
  const reconciledExport = report?.generatedAt === "2026-09-29T00:20:54Z";

  async function importFile(file: File) {
    setUploading(true); setStatus("");
    try {
      if (file.size > 1_000_000) throw new Error("JSON exceeds 1 MB.");
      const response = await fetch("/api/owner/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: await file.text() });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Import failed.");
      setStatus(`Imported ${data.weekly} weekly and ${data.daily} daily rows.`);
      await refresh();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Import failed."); }
    finally { setUploading(false); }
  }

  return <div className="owner-dashboard">
    <section className="owner-hero">
      <div><p className="owner-kicker">DEN DEFENDERS · SECURITY INSTALLS ONLY</p><h1>Owner Growth <em>Dashboard</em></h1>
        <p>What we sold, what cash came in, and what is still on the calendar. All dollars are shown in plain English.</p></div>
      <div className="owner-hero-icon" aria-hidden="true">↗<span>2024 · 2025 · 2026 · 2027</span></div>
    </section>

    <section className="owner-controls surface" aria-label="Dashboard filters">
      <div className="owner-segment" role="group" aria-label="Time view">
        <button className={view === "weekly" ? "selected" : ""} onClick={() => setView("weekly")}>Weekly</button>
        <button className={view === "daily" ? "selected" : ""} onClick={() => setView("daily")}>Daily</button>
      </div>
      <div className="owner-segment" role="group" aria-label="Year">
        {[2024,2025,2026,2027].map((y) => <button key={y} className={year === y ? "selected" : ""} onClick={() => setYear(y)}>{y}</button>)}
      </div>
      <span className="owner-scope">{label}</span>
    </section>

    {status && <p className="notice" role="status">{status}</p>}
    {initialRebuild && <section className="owner-data-warning surface" aria-label="Data limitations">
      <strong>These are reconstructed numbers, not saved snapshots.</strong>
      <p>Claude&apos;s rebuilt all-open total for Sep 28 is <b>$1,108,153</b>; the saved snapshot is <b>$1,024,752</b>. The $83,401 gap is unresolved. The weekly chart uses a separate rolling three-month window. Daily sale dates were estimated from job IDs and may shift by a day or more. Five days of cash have blank fields because payments could not be assigned safely. The Sold Estimates follow-up list was unavailable for cross-checking.</p>
    </section>}
    {correctedRebuild && <section className="owner-data-warning surface" aria-label="Data limitations">
      <strong>Corrected reconstruction · some gaps remain.</strong>
      <p>The Sep 28 rebuilt all-open total is <b>$1,047,596</b>, compared with the saved <b>$1,024,752</b>: a $22,844 gap across four jobs still needs the saved job list. The three Hold totals now match. The weekly headline uses a separate rolling three-month window. Daily sale dates for older jobs are estimated, and older canceled jobs were not fully checked. Five days of cash have blank fields due to ambiguous payments. The Sold Estimates follow-up list remains unchecked.</p>
    </section>}
    {reconciledExport && <section className="owner-data-warning surface" aria-label="Data quality">
      <strong>The saved September job lists now match exactly.</strong>
      <p>All 586 job comparisons across Sep 14, 21 and 28 match the saved workbook. The Sep 28 three-month pipeline is <b>$1,015,541.93</b> on 152 scheduled jobs; another <b>$9,210.08</b> is outside it because that job has no future appointment. The saved list confirms the base jobs, while the three-month split and unpaid balance use reconstructed appointment and payment data. Earlier history may miss hold releases, reopenings and canceled jobs. Future cash is a forecast, not cash received.</p>
    </section>}
    {!report && <section className="owner-setup surface">
      <span className="owner-section-label">READY FOR THE DATA</span><h2>{loading ? "Loading owner numbers…" : "The dashboard is ready. Add the verified export."}</h2>
      <p>There are no invented historical or future numbers here. The charts fill when the Security installs export is imported.</p>
      {!configured && !loading && <p className="notice">The site administrator must set OWNER_DATABASE_URL to the private reporting database before imports can be saved.</p>}
    </section>}
    {!report && <VerifiedReference />}

    <div className="owner-stats">
      <Stat label="Revenue pipeline" amount={latest?.revenuePipeline} detail={`${label} · full sold value`} accent="#27b9ab" />
      <Stat label="Cashflow pipeline" amount={latest?.cashflowPipeline} detail="Unpaid balance on those same jobs" accent="#f1b84b" />
      <Stat label={view === "weekly" ? "Prior week's net cash" : "That day's net cash"} amount={activity?.netCash} detail="Deposits + install payments − refunds" accent="#ee7668" />
      <Stat label="Change from prior point" amount={delta} detail="Revenue pipeline, same view" accent="#517ba0" />
    </div>

    <div className="owner-charts">
      <section className="owner-chart-card surface"><div className="owner-chart-heading"><div><span className="owner-section-label">01 / ON THE CALENDAR</span><h2>Revenue pipeline</h2><p>Full sold value of qualifying jobs scheduled in this view&apos;s window.</p></div><b>{money(latest?.revenuePipeline)}</b></div><Chart rows={allRows} metric="revenuePipeline" year={year} weekly={view === "weekly"} reconciled={reconciledExport} /></section>
      <section className="owner-chart-card surface"><div className="owner-chart-heading"><div><span className="owner-section-label">02 / STILL TO COLLECT</span><h2>Cashflow pipeline</h2><p>Only the unpaid balance on those same scheduled jobs.</p></div><b>{money(latest?.cashflowPipeline)}</b></div><Chart rows={allRows} metric="cashflowPipeline" year={year} weekly={view === "weekly"} reconciled={reconciledExport} /></section>
      <section className="owner-chart-card surface"><div className="owner-chart-heading"><div><span className="owner-section-label">03 / CASH IN THE BANK</span><h2>Net cash received</h2><p>Deposits plus install balance payments, minus refunds.</p></div><b>{money(activity?.netCash)}</b></div><Chart rows={allRows} metric="netCash" year={year} weekly={view === "weekly"} reconciled={reconciledExport} /></section>
      <section className="owner-chart-card surface"><div className="owner-chart-heading"><div><span className="owner-section-label">04 / NEW BUSINESS</span><h2>Security sales</h2><p>Newly sold RTI value in the day or prior Monday–Sunday week.</p></div><b>{money(activity?.sales)}</b></div><Chart rows={allRows} metric="sales" year={year} weekly={view === "weekly"} reconciled={reconciledExport} /></section>
      <section className="owner-chart-card surface"><div className="owner-chart-heading"><div><span className="owner-section-label">05 / CASH FROM NEW SALES</span><h2>Deposits received</h2><p>Cash taken today or in the prior week for future security installs.</p></div><b>{money(activity?.deposits)}</b></div><Chart rows={allRows} metric="deposits" year={year} weekly={view === "weekly"} reconciled={reconciledExport} /></section>
      <section className="owner-chart-card surface"><div className="owner-chart-heading"><div><span className="owner-section-label">06 / CASH FROM INSTALLS</span><h2>Balance payments</h2><p>Cash received on installed security jobs in that period.</p></div><b>{money(activity?.installPayments)}</b></div><Chart rows={allRows} metric="installPayments" year={year} weekly={view === "weekly"} reconciled={reconciledExport} /></section>
    </div>

    <section className="owner-split">
      <div className="owner-detail surface"><span className="owner-section-label">WHAT MAKES UP CASH</span><h2>{view === "weekly" ? "Prior week's" : "Latest day's"} cash</h2>
        <p className="owner-explain">A deposit is cash received for a future installation. The install payment is money collected when the job is installed.</p>
        <div className="owner-breakdown"><span>Deposits received</span><strong>{exactMoney(activity?.deposits)}</strong><span>Install balance payments</span><strong>{exactMoney(activity?.installPayments)}</strong><span>Refunds</span><strong>− {exactMoney(activity?.refunds)}</strong><span className="owner-total">Net cash</span><strong className="owner-total">{exactMoney(activity?.netCash)}</strong></div>
      </div>
      <div className="owner-detail surface"><span className="owner-section-label">SEPARATE BUCKETS</span><h2>Not in the headline</h2>
        <p className="owner-explain">These amounts stay outside the scheduled pipeline above.</p>
        <div className="owner-breakdown"><span>On Hold · sold value</span><strong>{exactMoney(latest?.holdRevenue)}</strong><span>On Hold · unpaid balance</span><strong>{exactMoney(latest?.holdCashflow)}</strong><span>Not yet scheduled</span><strong>{exactMoney(latest?.unscheduledRevenue)}</strong><span>After this view&apos;s window</span><strong>{exactMoney(latest?.beyondWindowRevenue)}</strong></div>
      </div>
    </section>

    {reconciledExport && <section className="owner-followup surface"><span className="owner-section-label">SOLD ESTIMATE FOLLOW-UP</span><h2>20 sales need an install job check</h2><p>The 27-entry PDF contains 20 sold estimates totaling <strong>$143,946.56</strong> with no matching RTI job. Two more match only older, unrelated jobs. None is added to pipeline; the separate audit lists the addresses for operations to review.</p></section>}

    {forecast.length > 0 && <section className="owner-forecast surface"><span className="owner-section-label">ESTIMATE · NOT MONEY RECEIVED</span><h2>Looking ahead to {dayLabel(latestForecast!.date)}, {year}</h2><p>Forecast revenue pipeline: <strong>{exactMoney(latestForecast?.revenuePipeline)}</strong>. Forecast cashflow pipeline: <strong>{exactMoney(latestForecast?.cashflowPipeline)}</strong>. The dashed chart lines and forecast rows are estimates.</p></section>}

    <section className="owner-table-card surface"><div className="owner-chart-heading"><div><span className="owner-section-label">THE EXACT NUMBERS</span><h2>{view === "weekly" ? "Week by week" : "Day by day"}</h2><p>Scroll for every imported snapshot. A dash means the source could not verify it.</p></div></div>
      <div className="owner-table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Jobs</th><th>Revenue pipeline</th><th>Cashflow pipeline</th><th>Sales</th><th>Deposits</th><th>Install payments</th><th>Refunds</th><th>Net cash</th></tr></thead><tbody>
        {rows.length ? [...rows].reverse().map((r) => <tr key={r.date} className={r.quality === "forecast" ? "owner-projection-row" : ""}><td>{r.date}</td><td><span className={`owner-quality ${reconciledExport && r.quality === "verified" ? "reconciled" : r.quality}`}>{reconciledExport && r.quality === "verified" ? "reconciled base" : r.quality}</span></td><td>{r.jobCount ?? "—"}</td><td>{exactMoney(r.revenuePipeline)}</td><td>{exactMoney(r.cashflowPipeline)}</td><td>{exactMoney(r.sales)}</td><td>{exactMoney(r.deposits)}</td><td>{exactMoney(r.installPayments)}</td><td>{exactMoney(r.refunds)}</td><td>{exactMoney(r.netCash)}</td></tr>) : <tr><td colSpan={10}>No rows for {year} in this view.</td></tr>}
      </tbody></table></div>
    </section>

    <section className="owner-notes surface"><div><span className="owner-section-label">HOW TO READ THIS</span><h2>Little guide, big clarity</h2><p><strong>Revenue pipeline</strong> = the whole price of qualifying security installs on the calendar. <strong>Cashflow pipeline</strong> = what customers still owe on those same jobs. Neither is today&apos;s cash. <strong>Net cash</strong> = deposits and install payments actually received minus refunds.</p><p>Weekly looks ahead three calendar months from each Monday at 12:00 AM Pacific. Daily looks through December 31 from each day&apos;s close. Hold jobs are separate. Future points stay blank unless marked forecast.</p>
      {report && <><p className="owner-source">Source: {report.source} · export created {new Date(report.generatedAt).toLocaleString()}</p><details className="owner-method"><summary>Show all source and forecast notes</summary><ol>{report.notes.map((note, index) => <li key={index}>{note}</li>)}</ol></details></>}</div>
      <div className="owner-import"><label htmlFor="owner-file">Import updated report JSON</label><input id="owner-file" type="file" accept="application/json,.json" disabled={uploading || !configured} onChange={(e) => { const file = e.target.files?.[0]; if (file) void importFile(file); e.currentTarget.value = ""; }} /><small>Owner only · replaces the displayed report with the latest saved version. Previous imports remain in the database.</small></div>
    </section>
  </div>;
}

"use client";

import { useCallback, useEffect, useState } from "react";

type Row = { label: string; leads: number; gotTexts: number; replied: number; wantedCall: number; readyToBook: number; booked: number; notInterested: number; stop: number };
type Data = { days: number; since: string; total: Row; byInquiry: Row[]; byAdSet: Row[] };

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "–");

function Cell({ n, of }: { n: number; of: number }) {
  return <td>{n}<span className="team-hint"> · {pct(n, of)}</span></td>;
}

function ResultTable({ title, rows, total }: { title: string; rows: Row[]; total?: Row }) {
  return (
    <section className="surface team-list">
      <h2>{title}</h2>
      {rows.length === 0 ? <p className="team-hint">No form leads in this window.</p> : (
        <div className="owner-table-wrap">
          <table className="team-table">
            <thead>
              <tr>
                <th></th><th>Leads</th><th>Got texts</th><th>Replied</th><th>Wanted a call</th><th>Ready to book</th><th>Booked</th><th>Not interested</th><th>STOP</th>
              </tr>
            </thead>
            <tbody>
              {[...rows, ...(total ? [total] : [])].map((r) => (
                <tr key={r.label} style={total && r === total ? { fontWeight: 700 } : undefined}>
                  <td>{r.label}</td>
                  <td>{r.leads}</td>
                  <Cell n={r.gotTexts} of={r.leads} />
                  <Cell n={r.replied} of={r.leads} />
                  <Cell n={r.wantedCall} of={r.leads} />
                  <Cell n={r.readyToBook} of={r.leads} />
                  <Cell n={r.booked} of={r.leads} />
                  <Cell n={r.notInterested} of={r.leads} />
                  <Cell n={r.stop} of={r.leads} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function LeadResults() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async (d: number) => {
    setError("");
    const res = await fetch(`/api/sms/results?days=${d}`, { cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError(body?.error || `Couldn't load (HTTP ${res.status}).`); return; }
    setData(body as Data);
  }, []);

  useEffect(() => {
    // Load when the page opens or the window changes (same pattern as the other owner pages).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(days);
  }, [days, load]);

  return (
    <div className="team-page">
      <section className="surface team-form">
        <h2>Lead results</h2>
        <p className="team-hint">
          Form leads from the Zap, one per phone (their first lead in the window). Each number counts what happened after that lead came in;
          the % is out of that row&apos;s leads. Spam and Test chats and staff test phones are left out.
        </p>
        <ul className="team-hint" style={{ margin: "6px 0 0 18px" }}>
          <li><b>Replied</b>: they texted us back (a STOP alone doesn&apos;t count). <b>Wanted a call</b>: the AI flagged them for a call.</li>
          <li><b>Ready to book</b>: the AI flagged them to book. <b>Booked</b>: &quot;Booked in ServiceTitan&quot; clicked or filed in 📅 Booked.</li>
        </ul>
        <div className="hero-actions" style={{ marginTop: 12 }}>
          {[7, 30, 90].map((d) => (
            <button key={d} className={d === days ? "btn btn-teal" : "btn btn-outline"} onClick={() => setDays(d)}>Last {d} days</button>
          ))}
          <a className="btn btn-outline" href="/texting">Back to Texting</a>
          <a className="btn btn-outline" href="/sms-test">Texting setup &amp; test page</a>
        </div>
        {error && <div className="notice" style={{ marginTop: 12 }}>{error}</div>}
        {data && <p className="team-hint" style={{ marginTop: 8 }}>Since {new Date(data.since).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.</p>}
      </section>
      {!data ? (!error && <section className="surface team-form"><p className="team-hint">Loading…</p></section>) : (
        <>
          <ResultTable title="By form choice" rows={data.byInquiry} total={data.total} />
          <ResultTable title="By ad set" rows={data.byAdSet} total={data.total} />
        </>
      )}
    </div>
  );
}

"use client";

/**
 * Session 7 PR 4: the manager scoreboard (owners + managers only), shown on the Texting
 * page's 📊 Scoreboard tab. Numbers come from /api/sms/inbox/scoreboard (lib/sms/scoreboard.ts).
 */
import { useCallback, useEffect, useState } from "react";

type Row = {
  email: string;
  name: string;
  role: string | null;
  ownsNow: number;
  waitingNow: number;
  followUpsDue: number;
  replies: number;
  avgReplyMinutes: number | null;
  typicalReplyMinutes: number | null;
  slowReplies: number;
  textsSent: number;
  callsLogged: number;
  autoReleased: number;
  booked: number;
};

type Period = "today" | "7" | "30";
type Metric = "owns" | "waiting" | "followups" | "replies" | "slow" | "texts" | "calls" | "released" | "booked";
type Detail = { phone: string; phoneLabel: string; name: string | null; at: string; note: string };

const METRIC_LABELS: Record<Metric, string> = {
  owns: "Owns now",
  waiting: "Waiting now",
  followups: "Follow-ups due",
  replies: "Replies",
  slow: "Replies over 1 hour",
  texts: "Texts sent",
  calls: "Calls logged",
  released: "Auto-released",
  booked: "Booked",
};

function whenText(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

const PERIODS: [Period, string][] = [["today", "Today"], ["7", "Last 7 days"], ["30", "Last 30 days"]];

function minutesText(m: number | null | undefined): string {
  if (m === null || m === undefined || Number.isNaN(m)) return "–";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} hr ${rest} min` : `${h} hr`;
}

export default function Scoreboard({ onFollowUps, onBack, onOpenChat }: { onFollowUps: (email: string) => void; onBack: () => void; onOpenChat: (phone: string) => void }) {
  const [period, setPeriod] = useState<Period>("7");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  /** The number that was tapped: its list shows under the table (Steven, 2026-11-15). */
  const [picked, setPicked] = useState<{ email: string; name: string; metric: Metric } | null>(null);
  const [details, setDetails] = useState<Detail[] | null>(null);

  useEffect(() => {
    if (!picked) return;
    let stale = false;
    const params = new URLSearchParams({ period, person: picked.email, metric: picked.metric });
    fetch(`/api/sms/inbox/scoreboard?${params}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((json) => { if (!stale) setDetails(json.details || []); })
      .catch(() => { if (!stale) setDetails([]); });
    return () => { stale = true; };
  }, [picked, period]);

  function pick(r: Row, metric: Metric) {
    setDetails(null);
    setPicked((now) => (now && now.email === r.email && now.metric === metric ? null : { email: r.email, name: r.name, metric }));
  }

  /** A number that opens its list (0 stays plain). */
  function cell(r: Row, metric: Metric, value: number, shown?: string, warn = false) {
    const on = picked?.email === r.email && picked.metric === metric;
    return (
      <td className={`${warn ? "warn" : ""}${on ? " picked" : ""}`}>
        {value > 0 ? <button className="inbox-link scoreboard-num" onClick={() => pick(r, metric)} title={`See the ${METRIC_LABELS[metric].toLowerCase()} for ${r.name}`}>{shown ?? value}</button> : (shown ?? 0)}
      </td>
    );
  }

  const load = useCallback(async (p: Period) => {
    const response = await fetch(`/api/sms/inbox/scoreboard?period=${p}`, { cache: "no-store" }).catch(() => null);
    const json = response ? await response.json().catch(() => ({})) : {};
    if (response?.ok) {
      setRows(json.rows || []);
      setError("");
    } else {
      setError(json.error || "The scoreboard couldn't load. Try again in a minute.");
    }
  }, []);

  // Load now and every minute while the tab is open.
  useEffect(() => {
    const first = setTimeout(() => load(period), 0);
    const timer = setInterval(() => load(period), 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [period, load]);

  return (
    <div className="scoreboard">
      <header className="scoreboard-head">
        <button className="btn btn-outline btn-small inbox-back" onClick={onBack}>← All texts</button>
        <h3>📊 Team scoreboard</h3>
        <div className="inbox-filters" role="tablist" aria-label="Period">
          {PERIODS.map(([key, label]) => (
            <button key={key} role="tab" aria-selected={period === key} className={`inbox-filter${period === key ? " active" : ""}`} onClick={() => { setRows(null); setPeriod(key); }}>{label}</button>
          ))}
        </div>
      </header>
      {error && <div className="notice">{error}</div>}
      {!rows && !error && <p className="team-hint">Loading…</p>}
      {rows && rows.length === 0 && <p className="team-hint">Nobody on the Team page has Texting access yet.</p>}
      {rows && rows.length > 0 && (
        <div className="scoreboard-scroll">
          <table className="scoreboard-table">
            <thead>
              <tr>
                <th>Person</th>
                <th title="Inbox chats they own right now">Owns now</th>
                <th title="Owned chats where a customer is waiting for a person right now">Waiting now</th>
                <th title="Their quiet customers and follow-up dates that came up">Follow-ups due</th>
                <th title="Times a waiting customer got an answer from them">Replies</th>
                <th title="What most customers waited (the middle reply), counting only team hours (Mon–Sat 8 AM–4 PM)">Typical reply</th>
                <th title="Average wait before they answered, team hours only. One very slow reply pulls this up.">Avg reply</th>
                <th title="Replies that took more than 1 hour of team time">Over 1 hr</th>
                <th>Texts sent</th>
                <th title="Calls logged with the 📞 buttons in a chat (talked, left voicemail, no answer)">Calls logged</th>
                <th title="Chats taken back by the 1-hour rule">Auto-released</th>
                <th title="Customers they booked: Booked in ServiceTitan on a Ready-to-book card, or Move to → 📅 Booked">Booked</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.email}>
                  <td>
                    <strong>{r.name}</strong>
                    {r.role && <span className="scoreboard-role">{r.role}</span>}
                  </td>
                  {cell(r, "owns", r.ownsNow)}
                  {cell(r, "waiting", r.waitingNow, undefined, r.waitingNow > 0)}
                  {cell(r, "followups", r.followUpsDue)}
                  {cell(r, "replies", r.replies)}
                  {cell(r, "replies", r.replies, minutesText(r.typicalReplyMinutes), r.typicalReplyMinutes !== null && r.typicalReplyMinutes > 60)}
                  {cell(r, "replies", r.replies, minutesText(r.avgReplyMinutes), r.avgReplyMinutes !== null && r.avgReplyMinutes > 60)}
                  {cell(r, "slow", r.slowReplies, undefined, r.slowReplies > 0)}
                  {cell(r, "texts", r.textsSent)}
                  {cell(r, "calls", r.callsLogged ?? 0)}
                  {cell(r, "released", r.autoReleased, undefined, r.autoReleased > 0)}
                  {cell(r, "booked", r.booked)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {picked && (
        <section className="scoreboard-detail" aria-label="List behind the number">
          <header>
            <h4>{picked.name} · {METRIC_LABELS[picked.metric]} · {["owns", "waiting", "followups"].includes(picked.metric) ? "right now" : PERIODS.find(([k]) => k === period)?.[1]}</h4>
            {picked.metric === "followups" && <button className="btn btn-outline btn-small" onClick={() => onFollowUps(picked.email)}>Open their Follow-ups tab</button>}
            <button className="inbox-link" onClick={() => setPicked(null)}>Close</button>
          </header>
          {!details && <p className="team-hint">Loading…</p>}
          {details && details.length === 0 && <p className="team-hint">Nothing in this list.</p>}
          {details && details.length > 0 && (
            <ul>
              {details.map((d, i) => (
                <li key={`${d.phone}-${d.at}-${i}`}>
                  <button className="inbox-link" onClick={() => onOpenChat(d.phone)}>{d.name ? `${d.name} · ${d.phoneLabel}` : d.phoneLabel}</button>
                  <span className="scoreboard-detail-when">{whenText(d.at)}</span>
                  <span className="scoreboard-detail-note">{d.note}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <div className="team-hint scoreboard-note">
        <p><b>Reply time</b> = how long a customer waited for a person before this person answered, counting only team hours (Mon–Sat 8 AM–4 PM Pacific). A 7 PM text answered at 8:05 the next morning counts as 5 minutes.</p>
        <p>It only counts when the customer was really waiting on a person: not while the AI was answering them, not texts like &quot;ok&quot; or &quot;thanks&quot;, not after someone clicked Mark handled, and never chats in 🗑️ Spam or 🧪 Test. A text you start yourself (a follow-up) isn&apos;t a reply.</p>
        <p><b>Typical</b> is the middle reply (what most customers got); <b>Avg</b> gets pulled up by one very slow reply. Owns now, Waiting now and Follow-ups due are right now; the rest are for the period. Tap any number to see the customers behind it, then tap a customer to open the chat.</p>
      </div>
    </div>
  );
}

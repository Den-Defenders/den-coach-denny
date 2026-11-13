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
  autoReleased: number;
  booked: number;
};

type Period = "today" | "7" | "30";

const PERIODS: [Period, string][] = [["today", "Today"], ["7", "Last 7 days"], ["30", "Last 30 days"]];

function minutesText(m: number | null): string {
  if (m === null) return "–";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} hr ${rest} min` : `${h} hr`;
}

export default function Scoreboard({ onFollowUps, onBack }: { onFollowUps: (email: string) => void; onBack: () => void }) {
  const [period, setPeriod] = useState<Period>("7");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");

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
                <th title="Chats taken back by the 1-hour rule">Auto-released</th>
                <th title="Booked in ServiceTitan clicks">Booked</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.email}>
                  <td>
                    <strong>{r.name}</strong>
                    {r.role && <span className="scoreboard-role">{r.role}</span>}
                  </td>
                  <td>{r.ownsNow}</td>
                  <td className={r.waitingNow > 0 ? "warn" : ""}>{r.waitingNow}</td>
                  <td>{r.followUpsDue > 0 ? <button className="inbox-link" onClick={() => onFollowUps(r.email)}>{r.followUpsDue}</button> : 0}</td>
                  <td>{r.replies}</td>
                  <td className={r.typicalReplyMinutes !== null && r.typicalReplyMinutes > 60 ? "warn" : ""}>{minutesText(r.typicalReplyMinutes)}</td>
                  <td className={r.avgReplyMinutes !== null && r.avgReplyMinutes > 60 ? "warn" : ""}>{minutesText(r.avgReplyMinutes)}</td>
                  <td className={r.slowReplies > 0 ? "warn" : ""}>{r.slowReplies}</td>
                  <td>{r.textsSent}</td>
                  <td className={r.autoReleased > 0 ? "warn" : ""}>{r.autoReleased}</td>
                  <td>{r.booked}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="team-hint scoreboard-note">
        <p><b>Reply time</b> = how long a customer waited for a person before this person answered, counting only team hours (Mon–Sat 8 AM–4 PM Pacific). A 7 PM text answered at 8:05 the next morning counts as 5 minutes.</p>
        <p>It only counts when the customer was really waiting on a person: not while the AI was answering them, not texts like &quot;ok&quot; or &quot;thanks&quot;, not after someone clicked Mark handled, and never chats in 🗑️ Spam or 🧪 Test. A text you start yourself (a follow-up) isn&apos;t a reply.</p>
        <p><b>Typical</b> is the middle reply (what most customers got); <b>Avg</b> gets pulled up by one very slow reply. Owns now, Waiting now and Follow-ups due are right now; the rest are for the period. Tap a follow-up number to see that person&apos;s list.</p>
      </div>
    </div>
  );
}

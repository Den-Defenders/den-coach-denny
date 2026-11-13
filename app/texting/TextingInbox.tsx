"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Flag = { needsCsr: boolean; pinned: boolean; reason: string | null; waiting: boolean };

type Conversation = {
  phone: string;
  phoneLabel: string;
  firstName: string | null;
  lastName: string | null;
  botStatus: "on" | "paused";
  handoffReason: string | null;
  assignedTo: string | null;
  assignedName: string | null;
  /** Session 7: auto-released from this owner (no reply in 1 team hour). */
  releasedName: string | null;
  /** Session 7 PR 3: the folder when it isn't the inbox (search results and folder views). */
  folderLabel: string | null;
  folder: Folder;
  revisitAt: string | null;
  /** "💤 Quiet 3 days" / "🔁 Revisit due today" when it's on the follow-up list. */
  followUp: string | null;
  optedOut: boolean;
  lastDirection: "inbound" | "outbound";
  lastBody: string;
  lastMediaCount: number;
  lastSentBy: string | null;
  lastAt: string;
  bookingTime: string | null;
  flag: Flag;
};

/** Step 4a: the open time the customer picked by text, ready for a CSR to book in ServiceTitan. */
type Booking = {
  lines: string[];
  time: string;
  requestedAt: string;
  doneAt: string | null;
  doneBy: string | null;
};

type Message = {
  id: number;
  direction: "inbound" | "outbound";
  body: string;
  media: string[];
  kind: string | null;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  sentBy: string | null;
  createdAt: string;
};

type Thread = {
  phone: string;
  phoneLabel: string;
  firstName: string | null;
  lastName: string | null;
  timeZone: string;
  botStatus: "on" | "paused";
  handoffReason: string | null;
  handoffLabel: string | null;
  handoffSummary: string | null;
  handoffAt: string | null;
  handoffResolvedAt: string | null;
  handoffResolvedBy: string | null;
  leadStatus: string | null;
  assignedTo: string | null;
  assignedName: string | null;
  releasedName: string | null;
  releasedAt: string | null;
  /** "If nobody replies, this chat goes back to the shared queue at …" (owned chats with a customer waiting). */
  releaseNote: string | null;
  folder: Folder;
  folderLabel: string;
  folderAt: string | null;
  folderByName: string | null;
  revisitAt: string | null;
  customerNotes: Record<string, string>;
  booking: Booking | null;
  /** Step 5: their lead form and the drip. */
  lead: {
    at: string | null;
    count: number;
    info: Record<string, string | null> | null;
    dripStatus: string | null;
    dripLabel: string;
    stCheck: string | null;
    followUp: string;
    followUpsOff: boolean;
    canStop: boolean;
  } | null;
  optOut: { optedOutAt: string; source: string; keyword: string | null } | null;
  messages: Message[];
};

type ThreadResponse = {
  thread: Thread;
  flag: Flag;
  reply: { blockers: string[]; canSend: boolean; localTimeLabel: string };
  me: string | null;
  canAssign: boolean;
  team: { email: string; name: string }[];
};

type Filter = "all" | "needs" | "mine" | "unassigned" | "ai" | "paused" | "optout";

/** Session 7 PR 3: chat folders ("active" = the inbox) and the follow-up list. */
type Folder = "active" | "booked" | "not_interested" | "revisit" | "spam" | "test";
type View = Folder | "followups";

const MOVE_OPTIONS: [Folder, string][] = [
  ["active", "💬 Inbox"],
  ["booked", "📅 Booked"],
  ["not_interested", "🚫 Not interested"],
  ["revisit", "🔁 Revisit later…"],
  ["spam", "🗑️ Spam"],
  ["test", "🧪 Test"],
];

const EMPTY_TEXT: Record<View, string> = {
  active: "No conversations yet.",
  followups: "Nobody to follow up with right now. 👍",
  booked: "No booked chats yet.",
  not_interested: "No chats filed as not interested.",
  revisit: "No chats to revisit.",
  spam: "No spam. 🎉",
  test: "No test chats.",
};

function dayLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
}

function isoDay(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 24 * 3600_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d);
}

const MAX_CHARS = 640;

/** Plain-words names for the AI's saved notes (same as the Slack alerts). */
const NOTE_LABELS: Record<string, string> = { need: "why they're looking" };
const LIST_REFRESH_MS = 10_000;
const THREAD_REFRESH_MS = 5_000;

function displayName(c: { firstName: string | null; lastName: string | null; phoneLabel: string }) {
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ");
  return name || c.phoneLabel;
}

function shortWhen(iso: string, now: number) {
  const t = Date.parse(iso);
  if (!t) return "";
  const mins = Math.round((now - t) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function longWhen(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Who sent an outgoing text, in plain words. */
function senderLabel(sentBy: string | null) {
  if (!sentBy) return "Den Defenders";
  if (sentBy === "denny-ai" || sentBy === "denny-checking") return "AI";
  if (sentBy === "denny-followup") return "AI follow-up";
  if (sentBy === "system" || sentBy === "denny-hold") return "Automatic";
  if (sentBy === "drip") return "Drip";
  return sentBy.includes("@") ? sentBy.split("@")[0] : sentBy;
}

function statusLabel(m: Message) {
  if (m.direction === "inbound") return "";
  if (m.status === "delivered" || m.status === "read") return "Delivered";
  if (m.status === "send_failed" || m.status === "failed" || m.status === "undelivered") {
    return `Not delivered${m.errorCode ? ` (${m.errorCode})` : ""}`;
  }
  return m.status === "pending" ? "Sending…" : "Sent";
}

function segments(text: string) {
  const gsm = /^[\x0A\x0D\x20-\x7E£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¡ÄÖÑÜ§¿äöñüà€]*$/.test(text);
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  return text.length <= single ? 1 : Math.ceil(text.length / multi);
}

function matchesFilter(c: Conversation, filter: Filter, me: string | null) {
  if (filter === "needs") return c.flag.needsCsr;
  if (filter === "mine") return Boolean(me) && c.assignedTo === me;
  if (filter === "unassigned") return !c.assignedTo && !c.optedOut;
  if (filter === "ai") return c.botStatus === "on" && !c.optedOut;
  if (filter === "paused") return c.botStatus === "paused" && !c.optedOut;
  if (filter === "optout") return c.optedOut;
  return true;
}

function phoneFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("phone");
}

export default function TextingInbox() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [listError, setListError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [view, setView] = useState<View>("active");
  const [followOwner, setFollowOwner] = useState("");
  const [counts, setCounts] = useState<Partial<Record<View, number>>>({});
  const [listTeam, setListTeam] = useState<{ email: string; name: string }[]>([]);
  /** Owners and managers see everyone's follow-ups. */
  const [seesEveryone, setSeesEveryone] = useState(false);
  /** "Revisit later…" picked in Move to: show the date choices. */
  const [revisitOpen, setRevisitOpen] = useState(false);
  const [revisitDay, setRevisitDay] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [data, setData] = useState<ThreadResponse | null>(null);
  const [threadError, setThreadError] = useState("");
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [me, setMe] = useState<string | null>(null);
  /** Session 7: customers waiting on me / the most a CSR may hold (null for owners and managers). */
  const [myWaiting, setMyWaiting] = useState<{ count: number; max: number } | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastCount = useRef(0);
  const searchRef = useRef(search);
  const viewRef = useRef<View>(view);
  const ownerRef = useRef(followOwner);

  const listQuery = useCallback(() => {
    const params = new URLSearchParams();
    const q = searchRef.current.trim();
    if (q) params.set("q", q);
    if (viewRef.current !== "active") params.set("folder", viewRef.current);
    if (viewRef.current === "followups" && ownerRef.current) params.set("owner", ownerRef.current);
    return params.toString();
  }, []);

  const loadList = useCallback(async () => {
    const asked = listQuery();
    const response = await fetch(`/api/sms/inbox${asked ? `?${asked}` : ""}`, { cache: "no-store" }).catch(() => null);
    const json = response ? await response.json().catch(() => ({})) : {};
    // A slow answer for a tab or search we already left: ignore it.
    if (asked !== listQuery()) return;
    if (response?.ok) {
      setConversations(json.conversations || []);
      setCounts(json.counts || {});
      setListTeam(json.team || []);
      setSeesEveryone(Boolean(json.seesEveryone));
      setMe(json.me || null);
      setMyWaiting(json.myWaiting || null);
      setListError("");
    } else {
      setListError(json.error || "Could not load the inbox.");
    }
    setNow(Date.now());
    setLoaded(true);
  }, [listQuery]);

  const loadThread = useCallback(async (phone: string) => {
    const response = await fetch(`/api/sms/inbox?phone=${encodeURIComponent(phone)}`, { cache: "no-store" }).catch(() => null);
    const json = response ? await response.json().catch(() => ({})) : {};
    if (response?.ok && json.thread) {
      setData(json as ThreadResponse);
      setThreadError("");
    } else {
      setThreadError(json.error || "Could not load this conversation.");
    }
  }, []);

  // Open a conversation from a Slack link (?phone=...), then refresh the list every 10 seconds.
  useEffect(() => {
    const fromUrl = phoneFromUrl();
    // Read the link only in the browser (the server render has no URL), same pattern as /sms-test.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (fromUrl) setSelected(fromUrl);
    loadList();
    const timer = setInterval(() => { if (!document.hidden) loadList(); }, LIST_REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadList]);

  // Search: wait for typing to pause.
  useEffect(() => {
    searchRef.current = search;
    const timer = setTimeout(loadList, 350);
    return () => clearTimeout(timer);
  }, [search, loadList]);

  // Folder tabs and the follow-up owner filter reload the list right away.
  useEffect(() => {
    viewRef.current = view;
    ownerRef.current = followOwner;
    const timer = setTimeout(loadList, 0);
    return () => clearTimeout(timer);
  }, [view, followOwner, loadList]);

  // The open conversation refreshes every 5 seconds so new texts show up.
  useEffect(() => {
    if (!selected) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadThread(selected);
    const timer = setInterval(() => { if (!document.hidden) loadThread(selected); }, THREAD_REFRESH_MS);
    return () => clearInterval(timer);
  }, [selected, loadThread]);

  // Jump to the newest text when the conversation opens or a new text arrives.
  const messageCount = data?.thread.messages.length ?? 0;
  useEffect(() => {
    if (messageCount !== lastCount.current) {
      lastCount.current = messageCount;
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [messageCount, data?.thread.phone]);

  function open(phone: string) {
    if (phone !== selected) {
      setData(null);
      setDraft("");
      setNotice("");
      setEditingName(false);
      setRevisitOpen(false);
      lastCount.current = 0;
    }
    setSelected(phone);
    window.history.replaceState(null, "", `/texting?phone=${encodeURIComponent(phone)}`);
  }

  function close() {
    setSelected(null);
    setData(null);
    window.history.replaceState(null, "", "/texting");
  }

  async function act(action: string, extra: Record<string, unknown> = {}) {
    if (!selected) return null;
    setBusy(true);
    const response = await fetch("/api/sms/inbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, phone: selected, ...extra }),
    }).catch(() => null);
    const json = response ? await response.json().catch(() => ({})) : {};
    setBusy(false);
    setNotice(json.message || (response?.ok ? "Done." : "Something went wrong."));
    await Promise.all([loadThread(selected), loadList()]);
    return { ok: Boolean(response?.ok && json.ok !== false), json };
  }

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    const result = await act("send", { body: text });
    if (result?.ok) setDraft("");
  }

  async function copyBooking(lines: string[]) {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setNotice("Copied. Paste it into ServiceTitan.");
    } catch {
      setNotice("Couldn't copy. Select the details and copy them yourself.");
    }
  }

  async function saveName() {
    await act("set_name", { name: nameDraft });
    setEditingName(false);
  }

  async function moveTo(folder: string) {
    if (!folder) return;
    if (folder === "revisit") {
      setRevisitDay(isoDay(14));
      setRevisitOpen(true);
      return;
    }
    setRevisitOpen(false);
    await act("move", { folder });
  }

  async function saveRevisit(revisit: string) {
    const result = await act("move", { folder: "revisit", revisit });
    if (result?.ok) setRevisitOpen(false);
  }

  // The usual filters work in the inbox; folder views show everything in the folder.
  const visible = view === "active" ? conversations.filter((c) => matchesFilter(c, filter, me)) : conversations;
  const viewTabs: [View, string][] = [
    ["active", "💬 Inbox"],
    ["followups", `📋 ${seesEveryone ? "Follow-ups" : "My follow-ups"}${counts.followups ? ` (${counts.followups})` : ""}`],
    ["revisit", `🔁 Revisit${counts.revisit ? ` (${counts.revisit})` : ""}`],
    ["booked", "📅 Booked"],
    ["not_interested", "🚫 Not interested"],
    ["spam", `🗑️ Spam${counts.spam ? ` (${counts.spam})` : ""}`],
    ["test", `🧪 Test${counts.test ? ` (${counts.test})` : ""}`],
  ];
  const needsCount = conversations.filter((c) => c.flag.needsCsr).length;
  const myNeeds = conversations.filter((c) => c.flag.needsCsr && me && c.assignedTo === me).length;
  const thread = data?.thread;
  const flag = data?.flag;
  const reply = data?.reply;
  // Notes starting with "_" are code-only bookkeeping (like which photo files were sent).
  // The lead card shows the form, so its notes aren't repeated as chips.
  const notes = Object.entries(thread?.customerNotes || {}).filter(([k]) => !k.startsWith("_") && k !== "lead_form" && k !== "form_zip");
  const tooLong = draft.trim().length > MAX_CHARS;

  return (
    <div className={`inbox${selected ? " has-thread" : ""}`}>
      <section className="surface inbox-list" aria-label="Conversations">
        <div className="inbox-list-head">
          <h2>Texting {needsCount > 0 && <span className="inbox-count">{needsCount} need a person</span>}</h2>
          {myWaiting && myWaiting.count > 0 && (
            <div className={`team-hint inbox-my-waiting${myWaiting.count >= myWaiting.max ? " full" : ""}`}>
              {myWaiting.count} of {myWaiting.max} customers waiting on you{myWaiting.count >= myWaiting.max ? ". Reply to some before taking more." : ""}
            </div>
          )}
          <input
            className="inbox-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, number or text"
            aria-label="Search conversations"
          />
          <div className="inbox-filters inbox-folders" role="tablist" aria-label="Folder">
            {viewTabs.map(([key, label]) => (
              <button key={key} role="tab" aria-selected={view === key} className={`inbox-filter${view === key ? " active" : ""}`} onClick={() => setView(key)}>{label}</button>
            ))}
          </div>
          {view === "followups" && seesEveryone && listTeam.length > 0 && (
            <select className="inbox-owner-filter" aria-label="Whose follow-ups" value={followOwner} onChange={(e) => setFollowOwner(e.target.value)}>
              <option value="">Everyone&apos;s follow-ups</option>
              {listTeam.map((m) => <option key={m.email} value={m.email}>{m.name}</option>)}
            </select>
          )}
          {view === "followups" && <div className="team-hint inbox-folder-hint">Customers you own who went quiet for 1+ work day after your last text, plus Revisit dates that came up. Oldest first.</div>}
          {view === "active" && <div className="inbox-filters" role="tablist" aria-label="Filter">
            {([["all", "All"], ["needs", `Needs CSR${needsCount ? ` (${needsCount})` : ""}`], ["mine", `Mine${myNeeds ? ` (${myNeeds})` : ""}`], ["unassigned", "Unassigned"], ["ai", "AI on"], ["paused", "AI paused"], ["optout", "Opted out"]] as [Filter, string][]).map(([key, label]) => (
              <button key={key} role="tab" aria-selected={filter === key} className={`inbox-filter${filter === key ? " active" : ""}`} onClick={() => setFilter(key)}>{label}</button>
            ))}
          </div>}
        </div>
        {listError && <div className="notice">{listError}</div>}
        <ul className="inbox-items">
          {!loaded && <li className="team-hint inbox-empty">Loading…</li>}
          {loaded && visible.length === 0 && (
            <li className="team-hint inbox-empty">{search ? "No conversations match that search." : view === "active" && filter === "needs" ? "Nobody is waiting for a person. 👍" : EMPTY_TEXT[view]}</li>
          )}
          {visible.map((c) => {
            const preview = c.lastBody || (c.lastMediaCount ? "📎 Photo" : "");
            const prefix = c.lastDirection === "outbound" ? `${senderLabel(c.lastSentBy)}: ` : "";
            return (
              <li key={c.phone}>
                <button className={`inbox-item${c.phone === selected ? " active" : ""}${c.flag.pinned ? " book" : c.flag.needsCsr ? " needs" : ""}`} onClick={() => open(c.phone)}>
                  <span className="inbox-item-top">
                    <strong>{displayName(c)}</strong>
                    <span className="inbox-when">{shortWhen(c.lastAt, now)}</span>
                  </span>
                  <span className="inbox-badges">
                    {c.flag.needsCsr && <span className={`inbox-badge ${c.flag.pinned ? "green" : "red"}`}>{c.flag.pinned ? c.flag.reason : `Needs CSR · ${c.flag.reason}`}</span>}
                    {c.assignedTo && <span className={`inbox-badge ${c.assignedTo === me ? "navy" : "gray"}`}>👤 {c.assignedTo === me ? "You" : c.assignedName}</span>}
                    {!c.assignedTo && c.releasedName && <span className="inbox-badge amber">⏰ Released from {c.releasedName} (no reply in 1 hr)</span>}
                    {c.followUp && <span className="inbox-badge amber">{c.followUp}</span>}
                    {c.folderLabel && <span className="inbox-badge gray">{c.folder === "revisit" && c.revisitAt ? `🔁 Revisit ${dayLabel(c.revisitAt)}` : c.folderLabel}</span>}
                    {c.optedOut ? <span className="inbox-badge gray">Opted out</span>
                      : c.botStatus === "paused" ? <span className="inbox-badge amber">AI paused</span>
                        : <span className="inbox-badge teal">AI on</span>}
                  </span>
                  {c.flag.pinned && c.bookingTime && <span className="inbox-booking-when">{c.bookingTime}</span>}
                  <span className={`inbox-preview${c.flag.waiting ? " unread" : ""}`}>{prefix}{preview}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="surface inbox-thread" aria-label="Conversation">
        {!selected && <p className="team-hint inbox-empty">Pick a conversation on the left. Anyone marked <b>Needs CSR</b> is waiting for a person.</p>}
        {selected && !thread && <p className="team-hint inbox-empty">{threadError || "Loading…"}</p>}
        {thread && flag && reply && (
          <>
            <header className="inbox-thread-head">
              <button className="btn btn-outline btn-small inbox-back" onClick={close}>← All texts</button>
              <div className="inbox-who">
                {editingName ? (
                  <span className="inbox-name-edit">
                    <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} placeholder="First and last name" autoFocus
                      onKeyDown={(e) => { if (e.key === "Enter") saveName(); if (e.key === "Escape") setEditingName(false); }} />
                    <button className="btn btn-teal btn-small" disabled={busy} onClick={saveName}>Save</button>
                    <button className="btn btn-outline btn-small" onClick={() => setEditingName(false)}>Cancel</button>
                  </span>
                ) : (
                  <h2>
                    {displayName(thread)}
                    <button className="inbox-link" onClick={() => { setNameDraft([thread.firstName, thread.lastName].filter(Boolean).join(" ")); setEditingName(true); }}>
                      {thread.firstName ? "Edit name" : "Add name"}
                    </button>
                  </h2>
                )}
                <span className="inbox-sub">
                  <a href={`tel:${thread.phone}`}>{thread.phoneLabel}</a> · their time {reply.localTimeLabel}
                </span>
              </div>
              <div className="inbox-actions">
                {(flag.needsCsr || flag.waiting) && <button className="btn btn-teal btn-small" disabled={busy} onClick={() => act("mark_handled")}>Mark handled</button>}
                {!thread.optOut && thread.botStatus === "on" && <button className="btn btn-outline btn-small" disabled={busy} onClick={() => act("take_over")}>Pause AI (I&apos;ll answer)</button>}
                {!thread.optOut && thread.botStatus === "paused" && <button className="btn btn-outline btn-small" disabled={busy} onClick={() => act("resume_bot")}>Turn AI back on</button>}
                <select aria-label="Move to folder" className="inbox-move" value="" disabled={busy} onChange={(e) => moveTo(e.target.value)}>
                  <option value="">Move to…</option>
                  {MOVE_OPTIONS.filter(([f]) => f !== thread.folder || f === "revisit").map(([f, label]) => <option key={f} value={f}>{label}</option>)}
                </select>
              </div>
            </header>
            {revisitOpen && (
              <div className="inbox-revisit">
                <span>🔁 Revisit:</span>
                <button className="btn btn-outline btn-small" disabled={busy} onClick={() => saveRevisit("2w")}>In 2 weeks</button>
                <button className="btn btn-outline btn-small" disabled={busy} onClick={() => saveRevisit("1m")}>In 1 month</button>
                <button className="btn btn-outline btn-small" disabled={busy} onClick={() => saveRevisit("3m")}>In 3 months</button>
                <input type="date" aria-label="Revisit on" value={revisitDay} min={isoDay(0)} onChange={(e) => setRevisitDay(e.target.value)} />
                <button className="btn btn-teal btn-small" disabled={busy || !revisitDay} onClick={() => saveRevisit(revisitDay)}>Save date</button>
                <button className="inbox-link" onClick={() => setRevisitOpen(false)}>Cancel</button>
              </div>
            )}

            <div className="inbox-owner">
              <span>👤 Owner: <b>{!thread.assignedTo ? "Nobody yet (shared queue)" : thread.assignedTo === data.me ? "You" : thread.assignedName}</b></span>
              {thread.assignedTo !== data.me && (!thread.assignedTo || data.canAssign) && (
                <button className="btn btn-teal btn-small" disabled={busy} onClick={() => act("claim")}>Take it</button>
              )}
              {thread.assignedTo && (thread.assignedTo === data.me || data.canAssign) && (
                <button className="btn btn-outline btn-small" disabled={busy} onClick={() => act("release")}>Release</button>
              )}
              {!thread.assignedTo && thread.releasedName && (
                <span className="inbox-badge amber">⏰ Released from {thread.releasedName} (no reply in 1 hr){thread.releasedAt ? ` · ${longWhen(thread.releasedAt)}` : ""}</span>
              )}
              {data.canAssign && data.team.length > 0 && (
                <select aria-label="Assign to" value="" disabled={busy} onChange={(e) => { if (e.target.value) act("assign", { to: e.target.value }); }}>
                  <option value="">Assign to…</option>
                  {data.team.filter((m) => m.email !== thread.assignedTo).map((m) => <option key={m.email} value={m.email}>{m.name}</option>)}
                </select>
              )}
            </div>
            {thread.releaseNote && <div className="team-hint inbox-release-note">⏰ {thread.releaseNote}</div>}

            <div className="inbox-status">
              {flag.needsCsr && <span className={`inbox-badge ${flag.pinned ? "green" : "red"}`}>{flag.pinned ? flag.reason : `Needs CSR · ${flag.reason}`}</span>}
              {thread.optOut ? <span className="inbox-badge gray">Opted out {longWhen(thread.optOut.optedOutAt)}</span>
                : thread.botStatus === "paused" ? <span className="inbox-badge amber">AI paused: a person answers this customer</span>
                  : <span className="inbox-badge teal">AI is answering this customer</span>}
              {thread.leadStatus && <span className="inbox-badge gray">{thread.leadStatus.replace(/_/g, " ")}</span>}
              {thread.folder !== "active" && (
                <span className="inbox-badge gray">
                  {thread.folder === "revisit" && thread.revisitAt ? `🔁 Revisit on ${dayLabel(thread.revisitAt)}` : `In ${thread.folderLabel}`}
                  {thread.folderByName ? ` · filed by ${thread.folderByName}` : ""}{thread.folderAt ? ` · ${longWhen(thread.folderAt)}` : ""}
                </span>
              )}
            </div>

            {thread.booking && (
              <div className={`inbox-booking${thread.booking.doneAt ? " done" : ""}`} aria-label="Ready to book">
                <div className="inbox-booking-head">
                  <b>{thread.booking.doneAt ? "✅ Booked in ServiceTitan" : "📅 Ready to book"}</b>
                  <span>{thread.booking.doneAt ? `by ${thread.booking.doneBy || "a team member"} · ${longWhen(thread.booking.doneAt)}` : `picked ${longWhen(thread.booking.requestedAt)}`}</span>
                </div>
                <ul>
                  {thread.booking.lines.map((line) => {
                    const at = line.indexOf(": ");
                    return at > 0 && at < 20
                      ? <li key={line}><b>{line.slice(0, at)}:</b> {line.slice(at + 2)}</li>
                      : <li key={line} className="inbox-booking-check">⚠️ {line}</li>;
                  })}
                </ul>
                <div className="inbox-booking-actions">
                  <button className="btn btn-outline btn-small" onClick={() => copyBooking(thread.booking!.lines)}>Copy details</button>
                  {!thread.booking.doneAt && (
                    <button className="btn btn-teal btn-small" disabled={busy} onClick={() => act("mark_booked")}>Booked in ServiceTitan</button>
                  )}
                </div>
              </div>
            )}

            {!(thread.booking && thread.handoffReason === "ready_to_book") && (thread.handoffSummary || (thread.handoffLabel && thread.handoffReason !== "csr_took_over")) && (
              <div className={`inbox-handoff${thread.handoffResolvedAt ? " done" : ""}`}>
                <b>AI handoff: {thread.handoffLabel}</b>{thread.handoffAt ? ` · ${longWhen(thread.handoffAt)}` : ""}
                {thread.handoffSummary && <p>{thread.handoffSummary}</p>}
                {thread.handoffResolvedAt && <small>Handled by {senderLabel(thread.handoffResolvedBy)} · {longWhen(thread.handoffResolvedAt)}</small>}
              </div>
            )}

            {thread.lead && (
              <div className="inbox-lead" aria-label="Lead form and drip">
                <div className="inbox-lead-head">
                  <b>📝 Lead form{thread.lead.count > 1 ? ` (${thread.lead.count} submits)` : ""}</b>
                  {thread.lead.at && <span>{longWhen(thread.lead.at)}</span>}
                </div>
                {thread.lead.info && (
                  <ul>
                    {([
                      ["Inquiry", thread.lead.info.inquiryType], ["Book under campaign", thread.lead.info.crmCampaign],
                      ["Source", thread.lead.info.source], ["Platform", thread.lead.info.platform], ["Form", thread.lead.info.form],
                      ["Campaign", thread.lead.info.campaign], ["Ad set", thread.lead.info.adSet], ["Ad", thread.lead.info.ad],
                      ["ZIP", thread.lead.info.zip], ["Email", thread.lead.info.email],
                      ["Interested in", thread.lead.info.projectInterest], ["Best time", thread.lead.info.bestTime],
                    ] as [string, string | null | undefined][]).filter(([, v]) => v).map(([k, v]) => <li key={k}><b>{k}:</b> {v}</li>)}
                  </ul>
                )}
                {thread.lead.dripLabel && <div className="inbox-lead-drip">📨 {thread.lead.dripLabel}</div>}
                {thread.lead.followUp && <div className="inbox-lead-drip">🤖 {thread.lead.followUp}</div>}
                {thread.lead.followUpsOff && <div className="team-hint">Auto texts stopped for this customer (no drip, no AI follow-ups).</div>}
                {thread.lead.stCheck && <div className="team-hint">{thread.lead.stCheck}</div>}
                {thread.lead.canStop && (
                  <div className="inbox-booking-actions">
                    <button className="btn btn-outline btn-small" disabled={busy} onClick={() => act("stop_drip")}>Stop auto texts</button>
                  </div>
                )}
              </div>
            )}

            {notes.length > 0 && (
              <div className="inbox-notes" aria-label="What the customer told the AI">
                {notes.map(([k, v]) => <span key={k} className="inbox-note"><b>{NOTE_LABELS[k] || k.replace(/_/g, " ")}:</b> {v}</span>)}
              </div>
            )}

            <div className="inbox-messages">
              {thread.messages.map((m) => {
                const failed = ["send_failed", "failed", "undelivered"].includes(m.status);
                const who = m.direction === "inbound" ? "customer" : m.sentBy === "denny-ai" || m.sentBy === "denny-checking" || m.sentBy === "denny-followup" ? "ai" : m.sentBy === "system" || m.sentBy === "denny-hold" || m.sentBy === "drip" ? "system" : "person";
                return (
                  <div key={m.id} className={`inbox-row inbox-${who}${failed ? " failed" : ""}`}>
                    <div className="sim-who">{m.direction === "inbound" ? displayName(thread) : senderLabel(m.sentBy)} · {longWhen(m.createdAt)}</div>
                    {m.body && <div className="inbox-bubble">{m.body}</div>}
                    {m.media.length > 0 && (
                      <div className="sim-photos">
                        {m.media.map((url) => (
                          <a key={url} href={url} target="_blank" rel="noreferrer">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={url} alt={m.direction === "inbound" ? "Photo the customer texted" : "Photo we texted"} />
                          </a>
                        ))}
                      </div>
                    )}
                    {m.direction === "outbound" && <div className="inbox-delivery">{statusLabel(m)}{failed && m.errorMessage ? `: ${m.errorMessage}` : ""}</div>}
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            <div className="inbox-reply">
              {reply.blockers.length > 0 && <div className="notice inbox-blockers">{reply.blockers.map((b) => <div key={b}>⚠️ {b}</div>)}</div>}
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
                maxLength={MAX_CHARS + 50}
                disabled={!reply.canSend}
                placeholder={reply.canSend ? "Type your text… (Ctrl+Enter sends)" : "Can't text this customer."}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }}
              />
              <div className="inbox-reply-bar">
                <span className={`team-hint${tooLong ? " inbox-too-long" : ""}`}>
                  {draft.trim().length}/{MAX_CHARS} · {segments(draft.trim())} segment{segments(draft.trim()) === 1 ? "" : "s"} (≈ {(segments(draft.trim()) * 1.2).toFixed(1)}¢)
                  {thread.botStatus === "on" && !thread.optOut ? " · sending pauses the AI for this customer" : ""}
                  {!thread.assignedTo && !thread.optOut ? " · replying makes this customer yours" : ""}
                </span>
                <button className="btn btn-teal btn-small" disabled={busy || !reply.canSend || !draft.trim() || tooLong} onClick={send}>Send text</button>
              </div>
              {notice && <div className="notice inbox-notice">{notice}</div>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

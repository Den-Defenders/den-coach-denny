"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Flag = { needsCsr: boolean; reason: string | null; waiting: boolean };

type Conversation = {
  phone: string;
  phoneLabel: string;
  firstName: string | null;
  lastName: string | null;
  botStatus: "on" | "paused";
  handoffReason: string | null;
  optedOut: boolean;
  lastDirection: "inbound" | "outbound";
  lastBody: string;
  lastMediaCount: number;
  lastSentBy: string | null;
  lastAt: string;
  flag: Flag;
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
  customerNotes: Record<string, string>;
  optOut: { optedOutAt: string; source: string; keyword: string | null } | null;
  messages: Message[];
};

type ThreadResponse = { thread: Thread; flag: Flag; reply: { blockers: string[]; canSend: boolean; localTimeLabel: string } };

type Filter = "all" | "needs" | "ai" | "paused" | "optout";

const MAX_CHARS = 640;
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
  if (sentBy === "denny-ai") return "AI";
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

function matchesFilter(c: Conversation, filter: Filter) {
  if (filter === "needs") return c.flag.needsCsr;
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
  const [selected, setSelected] = useState<string | null>(null);
  const [data, setData] = useState<ThreadResponse | null>(null);
  const [threadError, setThreadError] = useState("");
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastCount = useRef(0);
  const searchRef = useRef(search);

  const loadList = useCallback(async () => {
    const q = searchRef.current.trim();
    const response = await fetch(`/api/sms/inbox${q ? `?q=${encodeURIComponent(q)}` : ""}`, { cache: "no-store" }).catch(() => null);
    const json = response ? await response.json().catch(() => ({})) : {};
    if (response?.ok) {
      setConversations(json.conversations || []);
      setListError("");
    } else {
      setListError(json.error || "Could not load the inbox.");
    }
    setNow(Date.now());
    setLoaded(true);
  }, []);

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

  async function saveName() {
    await act("set_name", { name: nameDraft });
    setEditingName(false);
  }

  const visible = conversations.filter((c) => matchesFilter(c, filter));
  const needsCount = conversations.filter((c) => c.flag.needsCsr).length;
  const thread = data?.thread;
  const flag = data?.flag;
  const reply = data?.reply;
  // Notes starting with "_" are code-only bookkeeping (like which photo files were sent).
  const notes = Object.entries(thread?.customerNotes || {}).filter(([k]) => !k.startsWith("_"));
  const tooLong = draft.trim().length > MAX_CHARS;

  return (
    <div className={`inbox${selected ? " has-thread" : ""}`}>
      <section className="surface inbox-list" aria-label="Conversations">
        <div className="inbox-list-head">
          <h2>Texting {needsCount > 0 && <span className="inbox-count">{needsCount} need a person</span>}</h2>
          <input
            className="inbox-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, number or text"
            aria-label="Search conversations"
          />
          <div className="inbox-filters" role="tablist" aria-label="Filter">
            {([["all", "All"], ["needs", `Needs CSR${needsCount ? ` (${needsCount})` : ""}`], ["ai", "AI on"], ["paused", "AI paused"], ["optout", "Opted out"]] as [Filter, string][]).map(([key, label]) => (
              <button key={key} role="tab" aria-selected={filter === key} className={`inbox-filter${filter === key ? " active" : ""}`} onClick={() => setFilter(key)}>{label}</button>
            ))}
          </div>
        </div>
        {listError && <div className="notice">{listError}</div>}
        <ul className="inbox-items">
          {!loaded && <li className="team-hint inbox-empty">Loading…</li>}
          {loaded && visible.length === 0 && (
            <li className="team-hint inbox-empty">{search ? "No conversations match that search." : filter === "needs" ? "Nobody is waiting for a person. 👍" : "No conversations yet."}</li>
          )}
          {visible.map((c) => {
            const preview = c.lastBody || (c.lastMediaCount ? "📎 Photo" : "");
            const prefix = c.lastDirection === "outbound" ? `${senderLabel(c.lastSentBy)}: ` : "";
            return (
              <li key={c.phone}>
                <button className={`inbox-item${c.phone === selected ? " active" : ""}${c.flag.needsCsr ? " needs" : ""}`} onClick={() => open(c.phone)}>
                  <span className="inbox-item-top">
                    <strong>{displayName(c)}</strong>
                    <span className="inbox-when">{shortWhen(c.lastAt, now)}</span>
                  </span>
                  <span className="inbox-badges">
                    {c.flag.needsCsr && <span className="inbox-badge red">Needs CSR · {c.flag.reason}</span>}
                    {c.optedOut ? <span className="inbox-badge gray">Opted out</span>
                      : c.botStatus === "paused" ? <span className="inbox-badge amber">AI paused</span>
                        : <span className="inbox-badge teal">AI on</span>}
                  </span>
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
              </div>
            </header>

            <div className="inbox-status">
              {flag.needsCsr && <span className="inbox-badge red">Needs CSR · {flag.reason}</span>}
              {thread.optOut ? <span className="inbox-badge gray">Opted out {longWhen(thread.optOut.optedOutAt)}</span>
                : thread.botStatus === "paused" ? <span className="inbox-badge amber">AI paused: a person answers this customer</span>
                  : <span className="inbox-badge teal">AI is answering this customer</span>}
              {thread.leadStatus && <span className="inbox-badge gray">{thread.leadStatus.replace(/_/g, " ")}</span>}
            </div>

            {(thread.handoffSummary || (thread.handoffLabel && thread.handoffReason !== "csr_took_over")) && (
              <div className={`inbox-handoff${thread.handoffResolvedAt ? " done" : ""}`}>
                <b>AI handoff: {thread.handoffLabel}</b>{thread.handoffAt ? ` · ${longWhen(thread.handoffAt)}` : ""}
                {thread.handoffSummary && <p>{thread.handoffSummary}</p>}
                {thread.handoffResolvedAt && <small>Handled by {senderLabel(thread.handoffResolvedBy)} · {longWhen(thread.handoffResolvedAt)}</small>}
              </div>
            )}

            {notes.length > 0 && (
              <div className="inbox-notes" aria-label="What the customer told the AI">
                {notes.map(([k, v]) => <span key={k} className="inbox-note"><b>{k.replace(/_/g, " ")}:</b> {v}</span>)}
              </div>
            )}

            <div className="inbox-messages">
              {thread.messages.map((m) => {
                const failed = ["send_failed", "failed", "undelivered"].includes(m.status);
                const who = m.direction === "inbound" ? "customer" : m.sentBy === "denny-ai" ? "ai" : m.sentBy === "system" || m.sentBy === "denny-hold" ? "system" : "person";
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

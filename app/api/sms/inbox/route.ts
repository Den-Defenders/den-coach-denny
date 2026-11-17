/**
 * /api/sms/inbox — the Texting inbox (step 3). Who may use it: TEXTING_INBOX_ROLES
 * in lib/access.ts (checked by proxy.ts and again below).
 *
 *   GET  ?q=<search>          -> conversation list, "Needs CSR" first
 *        &folder=<f>          -> Session 7 PR 3: active (default) | followups | booked | not_interested | revisit | spam | test
 *                                (a search looks in every folder except Spam and Test, unless you're in one of those)
 *        &owner=<email>       -> followups only: owners/managers can pick one person (default: everyone's)
 *   (CSRs: lists show only unowned chats and their own; a search shows everything it finds)
 *   GET  ?phone=<number>      -> one conversation (texts, AI notes, handoff, reply blockers)
 *   POST {action:"send", phone, body}   -> a person's reply through the ONE send helper
 *                                          (kind "manual": 8 AM–7 PM their time, opt-outs,
 *                                          consent, caps, pilot list all apply). Pauses the AI.
 *   POST {action:"take_over", phone}    -> pause the AI for this number without texting
 *   POST {action:"resume_bot", phone}   -> turn the AI back on for this number
 *   POST {action:"mark_handled", phone} -> clear "Needs CSR" (AI on/off unchanged)
 *   POST {action:"set_name", phone, name}
 *   POST {action:"claim", phone}        -> "Take it": this customer is mine (Session 7: a CSR can hold at most
 *                                          SMS_CSR_MAX_WAITING (10) chats with a customer waiting; owners/managers uncapped)
 *   POST {action:"release", phone}      -> back to the shared queue (own customer, or owner/manager)
 *   POST {action:"assign", phone, to}   -> owners/managers give the customer to a team member (email)
 *   POST {action:"mark_booked", phone}  -> "Booked in ServiceTitan" (step 4a): clears the "📅 Ready to book"
 *                                          flag; an unowned customer becomes the booker's
 *   POST {action:"stop_drip", phone}    -> step 5 "Stop auto texts": no more drip texts or AI follow-ups, for good
 *   POST {action:"move", phone, folder, revisit?} -> Session 7 PR 3: file the chat (revisit = 2w | 1m | 3m | YYYY-MM-DD)
 *   POST {action:"add_note", phone, kind, body, followUp?} -> team note (never texted); followUp files it in Follow-ups → Later
 *   POST {action:"edit_note" | "delete_note", phone, noteId, body?} -> the author, or an owner/manager
 */
import { NextResponse } from "next/server";
import { canAccessTextingInbox, canUseTextingInbox, type DennyAccess } from "@/lib/access";
import { getCurrentAccess } from "@/lib/currentAccess";
import { bookingFrom, bookingLines, shortTimeWords } from "@/lib/sms/booking";
import { dripLabel, stopDrip } from "@/lib/sms/drip";
import { followUpLabel, followUpPlanFor, stopFollowUps } from "@/lib/sms/followup";
import { stCheckSummary, type StCheck } from "@/lib/sms/stCheck";
import { READY_TO_BOOK_LABEL, handoffLabel, inboxFlag, replyBlockers, sortInbox, unansweredTexts } from "@/lib/sms/inbox";
import { FOLDER_LABELS, followUpList, moveChat, revisitDate, type FollowUpItem } from "@/lib/sms/folders";
import { NOTE_LABELS, noteText } from "@/lib/sms/notes";
import { placeForZip } from "@/lib/sms/place";
import {
  TEAM_CLOCK_TEXT,
  capMessage,
  customerWaitingSince,
  isCappedRole,
  maxWaitingPerCsr,
  pacificWhen,
  releasableFolder,
  releasePlan,
  waitingCountFor,
} from "@/lib/sms/ownership";
import { formatPhone, normalizePhone } from "@/lib/sms/rules";
import { sendSms, smsNow } from "@/lib/sms/send";
import {
  CHECKING_SENDER,
  HOLD_SENDER,
  assignConversation,
  audit,
  inboxThread,
  CHAT_FOLDERS,
  folderCounts,
  folderFrom,
  inboxRowsFor,
  chatsTakenOverBy,
  takenOverInfo,
  type TakenOver,
  listInboxConversations,
  NOTE_KINDS,
  addTeamNote,
  deleteTeamNote,
  editTeamNote,
  getTeamNote,
  latestTeamNotes,
  teamNotesFor,
  type NoteKind,
  type ChatFolder,
  markBookingDone,
  markHandoffHandled,
  resumeBot,
  setContactName,
  smsDatabaseConfigured,
  takeOverConversation,
} from "@/lib/sms/store";
import { listTeamMembers, normalizeEmail, teamDatabaseConfigured, type TeamMember } from "@/lib/teamStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: NO_STORE });
}

async function requireInboxUser() {
  const access = await getCurrentAccess();
  return canAccessTextingInbox(access) ? access : null;
}

/** Owners and managers may hand a customer to someone else; everyone can take an unowned one. */
function canAssignOthers(access: DennyAccess): boolean {
  return access.role === "owner" || access.role === "manager";
}

/** Active team members who can work the inbox (for names and the "Assign to" list). */
async function inboxTeam(): Promise<TeamMember[]> {
  if (!teamDatabaseConfigured()) return [];
  try {
    return (await listTeamMembers()).filter((m) => m.active && canUseTextingInbox(m.role));
  } catch (error) {
    console.error("SMS inbox team list failed:", error instanceof Error ? error.message : error);
    return [];
  }
}

/**
 * "👁 View as" (Steven, 2026-11-16): an owner sees the Texting page exactly as a team member
 * does (their Mine, follow-ups, waiting count, no Scoreboard). Look-only: it only changes what
 * GET shows; every POST still runs as the real person, and the page blocks actions while viewing.
 * Managers too (Steven, 2026-11-16): they can view as anyone on the inbox team, same as owners.
 */
function canViewAs(real: DennyAccess, member: { email: string }): boolean {
  return canAssignOthers(real) && member.email.toLowerCase() !== real.email;
}

async function viewAsAccess(real: DennyAccess, url: URL): Promise<{ access: DennyAccess; viewingAs: { email: string; name: string; role: string } | null }> {
  const wanted = normalizeEmail(url.searchParams.get("viewAs") || "");
  if (!wanted || wanted === real.email || !canAssignOthers(real)) return { access: real, viewingAs: null };
  const member = (await inboxTeam()).find((m) => m.email.toLowerCase() === wanted);
  if (!member || !canViewAs(real, member)) return { access: real, viewingAs: null };
  return {
    access: { email: member.email.toLowerCase(), displayName: member.displayName, role: member.role, member },
    viewingAs: { email: member.email.toLowerCase(), name: member.displayName || member.email.split("@")[0], role: member.role },
  };
}

/**
 * Session 7 PR 2: would taking this chat put a CSR over the waiting-chat cap?
 * Only a chat with a customer waiting counts; owners and managers are never capped.
 * Returns the message to show, or null when it's fine.
 */
async function capBlock(access: DennyAccess, phone: string): Promise<string | null> {
  if (!access.email || !isCappedRole(access.role)) return null;
  const full = await inboxThread(phone);
  // Booked / Not interested / Follow up later / Spam chats never count toward the cap.
  if (!full || !releasableFolder(full.folder) || !customerWaitingSince({ ...full, optedOut: Boolean(full.optOut) }, full.messages)) return null;
  const count = await waitingCountFor(access.email);
  return count >= maxWaitingPerCsr() ? capMessage(count) : null;
}

/** "3 of 10" for the list header (CSRs only; null for owners/managers or on error). */
async function myWaiting(access: DennyAccess): Promise<{ count: number; max: number } | null> {
  if (!access.email || !isCappedRole(access.role)) return null;
  try {
    return { count: await waitingCountFor(access.email), max: maxWaitingPerCsr() };
  } catch (error) {
    console.error("SMS waiting count failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

function nameFor(email: string | null, team: TeamMember[]): string | null {
  if (!email) return null;
  return team.find((m) => m.email === email)?.displayName || email.split("@")[0];
}

/** "🔁 Taken from Liz C · Nov 16" (Steven, 2026-11-16): this owner is covering someone else's customer. */
function takenLabel(t: TakenOver | undefined, team: TeamMember[]): string | null {
  if (!t) return null;
  const name = team.find((m) => m.email.toLowerCase() === t.from)?.displayName || t.from.split("@")[0];
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" }).format(new Date(t.at));
  return `🔁 ${t.how === "followups" ? "Taken from" : "Reassigned from"} ${name} · ${day}`;
}

/** Team members whose name (or email name) has the search in it: their customers match too. */
function ownersMatching(search: string | undefined, team: TeamMember[]): string[] {
  const q = (search || "").trim().toLowerCase();
  if (q.length < 2) return [];
  return team.filter((m) => (m.displayName || "").toLowerCase().includes(q) || m.email.toLowerCase().split("@")[0].includes(q)).map((m) => m.email.toLowerCase());
}

type ListView = ChatFolder | "followups";

function listView(value: string | null): ListView {
  return value === "followups" ? "followups" : folderFrom(value);
}

/** Inbound photos are Twilio links that need our Twilio login, so the page loads them through /api/sms/inbox/media. */
function viewableMedia(messageId: number, direction: "inbound" | "outbound", media: string[]): string[] {
  if (direction === "outbound") return media;
  return media.map((_, i) => `/api/sms/inbox/media?id=${messageId}&i=${i}`);
}

export async function GET(request: Request) {
  const real = await requireInboxUser();
  if (!real) return json({ error: "You don't have access to the Texting inbox." }, 403);
  if (!smsDatabaseConfigured()) return json({ error: "Texting database isn't set up." }, 500);
  const url = new URL(request.url);
  const now = smsNow();
  const { access, viewingAs } = await viewAsAccess(real, url);

  try {
    const phoneParam = url.searchParams.get("phone");
    if (phoneParam !== null) {
      const phone = normalizePhone(phoneParam);
      if (!phone) return json({ error: "That isn't a valid number." }, 400);
      const thread = await inboxThread(phone);
      if (!thread) return json({ error: "No texts with that number yet." }, 404);
      // The automatic hold text and the AI's "checking our calendar" text answer nothing,
      // so they don't count as the latest reply.
      const last = [...thread.messages].reverse()
        .find((m) => m.status !== "send_failed" && m.sentBy !== HOLD_SENDER && m.sentBy !== CHECKING_SENDER);
      const booking = bookingFrom(thread.bookingRequest);
      const flag = inboxFlag({
        botStatus: thread.botStatus,
        handoffReason: thread.handoffReason,
        handoffResolvedAt: thread.handoffResolvedAt,
        optedOut: Boolean(thread.optOut),
        lastDirection: last?.direction || "outbound",
        lastBody: last?.body || "",
        lastAt: last?.createdAt || "",
        bookingRequest: booking,
        bookingDoneAt: thread.bookingDoneAt,
        unanswered: last?.direction === "inbound" ? unansweredTexts(thread.messages, thread.handoffResolvedAt) : [],
      }, now);
      const team = await inboxTeam();
      const followUp = thread.lead.at ? await followUpPlanFor(phone) : null;
      // Session 7: an owned chat with a customer waiting goes back to the queue after 1 team hour.
      const plan = releasePlan({ ...thread, optedOut: Boolean(thread.optOut) }, thread.messages);
      return json({
        thread: {
          ...thread,
          bookingRequest: undefined,
          booking: booking
            ? {
                lines: bookingLines(booking, formatPhone(phone), thread.customerNotes),
                time: shortTimeWords(booking.chosen),
                requestedAt: booking.requestedAt,
                doneAt: thread.bookingDoneAt,
                doneBy: nameFor(thread.bookingDoneBy, team),
              }
            : null,
          assignedName: nameFor(thread.assignedTo, team),
          takenFrom: takenLabel((await takenOverInfo([{ phone, assignedTo: thread.assignedTo }])).get(phone), team),
          releasedName: !thread.assignedTo && thread.releasedFrom ? nameFor(thread.releasedFrom, team) : null,
          releaseNote: plan
            ? `Customer waiting since ${pacificWhen(plan.waitingSince)}. If nobody replies, this chat goes back to the shared queue ${plan.releaseAt.getTime() <= now.getTime() ? "within 5 minutes" : `at ${pacificWhen(plan.releaseAt)}`} (1 hour of team time, ${TEAM_CLOCK_TEXT}).`
            : null,
          phoneLabel: formatPhone(phone),
          folderLabel: FOLDER_LABELS[thread.folder],
          folderByName: thread.folderBy === "customer" ? "the customer's text" : nameFor(thread.folderBy, team),
          // Team notes (Steven, 2026-11-16): internal, shown between the texts.
          notes: (await teamNotesFor(phone)).map((n) => ({
            id: n.id,
            kind: n.kind,
            label: NOTE_LABELS[n.kind],
            body: n.body,
            byName: nameFor(n.createdBy, team) || n.createdBy,
            at: n.createdAt,
            edited: Boolean(n.updatedAt),
            canEdit: n.createdBy === access.email || canAssignOthers(access),
          })),
          lead: thread.lead.at || thread.lead.drip.status
            ? {
                at: thread.lead.at,
                count: thread.lead.count,
                info: thread.lead.info,
                dripStatus: thread.lead.drip.status,
                dripLabel: dripLabel(thread.lead.drip, thread.timeZone),
                stCheck: thread.lead.stCheck ? stCheckSummary(thread.lead.stCheck as StCheck) : null,
                followUp: followUp ? followUpLabel(followUp, thread.timeZone) : "",
                followUpsOff: Boolean(followUp && "none" in followUp && followUp.none.startsWith("Auto texts stopped")),
                canStop: thread.lead.drip.status === "active" || Boolean(followUp && !("none" in followUp)),
              }
            : null,
          handoffLabel: thread.handoffReason
            ? (thread.handoffReason === "ready_to_book" && booking ? READY_TO_BOOK_LABEL : handoffLabel(thread.handoffReason))
            : null,
          messages: thread.messages.map((m) => ({ ...m, media: viewableMedia(m.id, m.direction, m.media) })),
        },
        flag,
        reply: replyBlockers(thread, now),
        me: access.email,
        viewingAs,
        canAssign: canAssignOthers(access),
        team: canAssignOthers(access) ? team.map((m) => ({ email: m.email, name: m.displayName })) : [],
      });
    }

    // Session 7 PR 3: folders + "My follow-ups".
    const view = listView(url.searchParams.get("folder"));
    const search = url.searchParams.get("q")?.trim() || undefined;
    const seesEveryone = canAssignOthers(access);
    // Everyone sees everyone's follow-ups (Steven, 2026-11-16), with a person filter; it's the one
    // place a CSR can take over another CSR's customer. Quick filters: All / Mine / 🔁 Took over.
    const ownerParam = (url.searchParams.get("owner") || "").trim().toLowerCase();
    const tookMode = view === "followups" && ownerParam === "took";
    const followUpOwner = tookMode ? null : normalizeEmail(ownerParam) || null;
    const allFollowUps = await followUpList(null, now);
    const followUps = followUpOwner ? allFollowUps.filter((f) => (f.owner || "").toLowerCase() === followUpOwner.toLowerCase()) : allFollowUps;
    const followUpByPhone = new Map<string, FollowUpItem>(allFollowUps.map((f) => [f.phone, f]));
    const tookOver = access.email ? await chatsTakenOverBy(access.email) : [];
    const team = await inboxTeam();
    // A team member's name in the search finds their customers too ("Liz" → Liz's chats).
    const searchOwners = ownersMatching(search, team);
    let rows;
    if (view === "followups") {
      // On Follow-ups the search stays inside the list.
      const phones = tookMode ? tookOver.map((t) => t.phone) : followUps.map((f) => f.phone);
      rows = await inboxRowsFor(phones, { search, searchOwners });
    } else {
      const hidden: ChatFolder[] = ["spam", "test"];
      const folders: ChatFolder[] = view === "spam" || view === "test"
        ? [view]
        : search ? CHAT_FOLDERS.filter((f) => !hidden.includes(f)) : [view];
      rows = await listInboxConversations({ search, folders, searchOwners });
      // CSRs only see chats nobody owns plus their own (Steven, 2026-11-16): someone else's
      // customer shows up again only after it's released or reassigned. A search still finds it
      // (with the owner's badge) so a CSR can help a customer who calls in.
      if (!seesEveryone && !search) rows = rows.filter((r) => !r.assignedTo || r.assignedTo === access.email);
    }
    const taken = await takenOverInfo(rows);
    const latestNotes = await latestTeamNotes(rows.map((r) => r.phone));
    const mapped = rows.map((row) => {
      const booking = bookingFrom(row.bookingRequest);
      return {
        ...row,
        bookingRequest: undefined,
        // Shown under the "📅 Ready to book" badge so the time is visible without opening it.
        bookingTime: booking && !row.bookingDoneAt ? shortTimeWords(booking.chosen) : null,
        assignedName: nameFor(row.assignedTo, team),
        takenFrom: takenLabel(taken.get(row.phone), team),
        releasedName: !row.assignedTo && row.releasedFrom ? nameFor(row.releasedFrom, team) : null,
        phoneLabel: formatPhone(row.phone),
        // "Roseville, CA" from the ZIP on the card (Steven, 2026-11-16).
        place: placeForZip(row.zip),
        folderLabel: row.folder === "active" ? null : FOLDER_LABELS[row.folder],
        followUp: followUpByPhone.get(row.phone)?.label ?? null,
        followUpReason: followUpByPhone.get(row.phone)?.reason ?? null,
        latestNote: latestNotes.get(row.phone) ? `${nameFor(latestNotes.get(row.phone)!.createdBy, team) || "Team"}: ${noteText(latestNotes.get(row.phone)!)}`.slice(0, 140) : null,
        flag: inboxFlag({ ...row, bookingRequest: booking }, now),
      };
    });
    // Follow-ups: oldest first. Everything else: the usual inbox order.
    // Took over: newest first.
    const order = new Map((tookMode ? tookOver.map((t) => t.phone) : followUps.map((f) => f.phone)).map((p, i) => [p, i]));
    const conversations = view === "followups"
      ? mapped.sort((a, b) => (order.get(a.phone) ?? 0) - (order.get(b.phone) ?? 0))
      : sortInbox(mapped);
    const counts = await folderCounts();
    return json({
      conversations,
      view,
      counts: { ...counts, followups: allFollowUps.filter((f) => f.reason !== "scheduled").length },
      // Follow-ups quick filters: Mine = my due follow-ups; Took over = customers I'm covering.
      followUpCounts: {
        mine: access.email ? allFollowUps.filter((f) => f.reason !== "scheduled" && (f.owner || "").toLowerCase() === access.email!.toLowerCase()).length : 0,
        took: tookOver.length,
      },
      seesEveryone,
      team: seesEveryone ? team.map((m) => ({ email: m.email, name: m.displayName })) : [],
      // The Follow-ups person filter (everyone).
      followUpPeople: team.map((m) => ({ email: m.email.toLowerCase(), name: m.displayName || m.email.split("@")[0] })),
      needsCsr: conversations.filter((c) => c.flag.needsCsr).length,
      me: access.email,
      viewingAs,
      // "👁 View as": owners and managers can pick anyone on the inbox team.
      viewAsOptions: team.filter((m) => canViewAs(real, m)).map((m) => ({ email: m.email.toLowerCase(), name: m.displayName || m.email.split("@")[0], role: m.role })),
      myWaiting: await myWaiting(access),
      now: now.toISOString(),
    });
  } catch (error) {
    console.error("SMS inbox GET failed:", error instanceof Error ? error.message : error);
    return json({ error: "Could not load the Texting inbox." }, 500);
  }
}

export async function POST(request: Request) {
  const access = await requireInboxUser();
  if (!access) return json({ ok: false, message: "You don't have access to the Texting inbox." }, 403);
  if (!smsDatabaseConfigured()) return json({ ok: false, message: "Texting database isn't set up." }, 500);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ ok: false, message: "Invalid request." }, 400);
  const phone = normalizePhone(String(body.phone || ""));
  if (!phone) return json({ ok: false, message: "That isn't a valid number." }, 400);
  const who = access.email || "staff";
  const now = smsNow();

  try {
    const thread = await inboxThread(phone, 1);
    if (!thread) return json({ ok: false, message: "No texts with that number yet." }, 404);

    switch (body.action) {
      case "send": {
        const text = String(body.body || "").trim();
        if (!text) return json({ ok: false, message: "Type a message first." }, 400);
        const result = await sendSms({ to: phone, body: text, kind: "manual", purpose: "care", sentBy: who });
        if (!result.ok) return json(result, 422);
        // A person is now texting this customer: the AI stops answering this number.
        await takeOverConversation(phone, who, now);
        await audit({ phone, action: "csr_reply", reason: thread.botStatus === "on" ? "ai_paused" : null, detail: { messageId: result.messageId }, actor: who });
        return json({ ...result, message: "Sent. The AI is paused for this number." });
      }
      case "stop_drip": {
        const dripStopped = await stopDrip(phone, `stopped by ${who}`, who, now);
        const followUpsStopped = await stopFollowUps(phone, who);
        const any = dripStopped || followUpsStopped;
        return json({ ok: any, message: any ? "Auto texts stopped for this customer: no more drip texts or AI follow-ups." : "This customer has no auto texts running." });
      }
      case "take_over": {
        // Pausing the AI on an unowned chat makes it yours, so the cap applies here too.
        if (!thread.assignedTo) {
          const blocked = await capBlock(access, phone);
          if (blocked) return json({ ok: false, message: blocked }, 409);
        }
        await takeOverConversation(phone, who, now);
        await audit({ phone, action: "bot_paused", reason: "person_took_over", actor: who });
        return json({ ok: true, message: `AI paused for ${formatPhone(phone)}. You're answering this customer.` });
      }
      case "resume_bot": {
        if (thread.optOut) return json({ ok: false, message: "This customer opted out. The AI stays off." }, 422);
        await resumeBot(phone);
        await audit({ phone, action: "bot_resumed", reason: "inbox", actor: who });
        return json({ ok: true, message: `AI replies are back on for ${formatPhone(phone)}. It answers their next text.` });
      }
      case "mark_handled": {
        await markHandoffHandled(phone, who, now);
        await audit({ phone, action: "handoff_handled", reason: thread.handoffReason, actor: who });
        return json({ ok: true, message: "Marked handled." });
      }
      case "claim": {
        if (!access.email) return json({ ok: false, message: "Your login has no email, so it can't own customers." }, 400);
        // A CSR can take another CSR's customer only from the Follow-ups tab, and only while it's on
        // the follow-up list (due or Later). Anywhere else it's the owner's (Steven, 2026-11-16).
        let fromFollowUps = false;
        if (thread.assignedTo && thread.assignedTo !== access.email && !canAssignOthers(access)) {
          const onList = body.from === "followups" && (await followUpList(null, now)).some((f) => f.phone === phone);
          if (!onList) {
            return json({ ok: false, message: `${nameFor(thread.assignedTo, await inboxTeam())} already has this customer. You can take it from the Follow-ups tab when it's on the follow-up list, or ask a manager to reassign it.` }, 409);
          }
          fromFollowUps = true;
        }
        if (thread.assignedTo !== access.email) {
          const blocked = await capBlock(access, phone);
          if (blocked) {
            await audit({ phone, action: "claim_blocked", reason: "waiting_cap", detail: { max: maxWaitingPerCsr() }, actor: who });
            return json({ ok: false, message: blocked }, 409);
          }
        }
        await assignConversation(phone, access.email, now);
        await audit({ phone, action: "assigned", reason: fromFollowUps ? "taken_from_followups" : "claimed", detail: { from: thread.assignedTo }, actor: who });
        return json({ ok: true, message: fromFollowUps ? `This customer is yours now (taken from ${nameFor(thread.assignedTo, await inboxTeam())}'s follow-ups).` : "This customer is yours now." });
      }
      case "release": {
        if (!thread.assignedTo) return json({ ok: true, message: "Nobody owns this customer." });
        if (thread.assignedTo !== access.email && !canAssignOthers(access)) {
          return json({ ok: false, message: "Only the owner or a manager can release this customer." }, 403);
        }
        await assignConversation(phone, null, now);
        await audit({ phone, action: "assigned", reason: "released", detail: { from: thread.assignedTo }, actor: who });
        return json({ ok: true, message: "Back in the shared queue." });
      }
      case "assign": {
        if (!canAssignOthers(access)) return json({ ok: false, message: "Only owners and managers can assign customers." }, 403);
        const to = normalizeEmail(String(body.to || ""));
        const team = await inboxTeam();
        const member = team.find((m) => m.email === to);
        if (!member) return json({ ok: false, message: "Pick an active team member who can use the Texting inbox." }, 400);
        await assignConversation(phone, member.email, now);
        await audit({ phone, action: "assigned", reason: "assigned", detail: { from: thread.assignedTo, to: member.email }, actor: who });
        return json({ ok: true, message: `Assigned to ${member.displayName}.` });
      }
      case "mark_booked": {
        if (!bookingFrom(thread.bookingRequest)) return json({ ok: false, message: "There's no ready-to-book time for this customer." }, 400);
        if (thread.bookingDoneAt) return json({ ok: true, message: "Already marked booked." });
        await markBookingDone(phone, who, now);
        await markHandoffHandled(phone, who, now);
        // Whoever booked it follows up, unless someone already owns this customer.
        if (!thread.assignedTo && access.email) await assignConversation(phone, access.email, now);
        // Session 7 PR 3: file it in Booked (it comes back to the inbox if the customer texts).
        if (thread.folder === "active") await moveChat(phone, "booked", who, now, { from: thread.folder });
        await audit({ phone, action: "booking_marked_booked", reason: "inbox", detail: { owner: thread.assignedTo || access.email }, actor: who });
        return json({ ok: true, message: `Marked booked in ServiceTitan.${!thread.assignedTo && access.email ? " This customer is yours now." : ""} The AI stays paused; text the customer if you want to confirm.` });
      }
      case "add_note": {
        // Team notes (Steven, 2026-11-16). Never texted to the customer.
        const kind = (NOTE_KINDS as readonly string[]).includes(String(body.kind)) ? (String(body.kind) as NoteKind) : "note";
        const text = String(body.body || "").trim().slice(0, 2000);
        if (kind === "note" && !text) return json({ ok: false, message: "Write a note first." }, 400);
        let followAt: Date | null = null;
        if (body.followUp) {
          followAt = revisitDate(String(body.followUp), now);
          if (!followAt) return json({ ok: false, message: "Pick a follow-up date from today on." }, 400);
        }
        // A follow-up date on an unowned chat makes it yours (same as "Follow up later").
        let claimed = false;
        if (followAt && !thread.assignedTo && access.email) {
          const blocked = await capBlock(access, phone);
          if (blocked) return json({ ok: false, message: blocked }, 409);
          await assignConversation(phone, access.email, now);
          await audit({ phone, action: "assigned", reason: "follow_up_later", detail: { from: null }, actor: who });
          claimed = true;
        }
        const note = await addTeamNote(phone, kind, text, who, now);
        await audit({ phone, action: "note_added", reason: kind, detail: { noteId: note.id, followUp: followAt ? followAt.toISOString() : null }, actor: who });
        if (followAt) await moveChat(phone, "revisit", who, now, { revisitAt: followAt, from: thread.folder });
        const day = followAt ? new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric" }).format(followAt) : "";
        return json({ ok: true, message: `${NOTE_LABELS[kind]} saved (only your team sees it).${followAt ? ` Follow up ${day}: it's under Later in ${thread.assignedTo && thread.assignedTo !== access.email ? "the owner's" : "your"} Follow-ups.` : ""}${claimed ? " This customer is yours now." : ""}` });
      }
      case "edit_note":
      case "delete_note": {
        const note = await getTeamNote(Number(body.noteId) || 0);
        if (!note || note.phone !== phone) return json({ ok: false, message: "That note is gone." }, 404);
        if (note.createdBy !== access.email && !canAssignOthers(access)) return json({ ok: false, message: "Only the person who wrote it, or a manager, can change this note." }, 403);
        if (body.action === "delete_note") {
          await deleteTeamNote(note.id, who, now);
          await audit({ phone, action: "note_deleted", reason: note.kind, detail: { noteId: note.id }, actor: who });
          return json({ ok: true, message: "Note deleted." });
        }
        const text = String(body.body || "").trim().slice(0, 2000);
        if (note.kind === "note" && !text) return json({ ok: false, message: "A note can't be empty. Delete it instead." }, 400);
        await editTeamNote(note.id, text, who, now);
        await audit({ phone, action: "note_edited", reason: note.kind, detail: { noteId: note.id }, actor: who });
        return json({ ok: true, message: "Note updated." });
      }
      case "move": {
        const folder = String(body.folder || "");
        if (!(CHAT_FOLDERS as readonly string[]).includes(folder)) return json({ ok: false, message: "Pick a folder." }, 400);
        const to = folder as ChatFolder;
        let revisitAt: Date | null = null;
        if (to === "revisit") {
          revisitAt = revisitDate(String(body.revisit || ""), now);
          if (!revisitAt) return json({ ok: false, message: "Pick when to follow up (a date from today on)." }, 400);
        }
        if (to === thread.folder && to !== "revisit") return json({ ok: true, message: `Already in ${FOLDER_LABELS[to]}.` });
        // "Follow up later" makes an unowned chat yours, so it lands on YOUR follow-up list (Steven, 2026-11-13).
        let claimed = false;
        if (to === "revisit" && !thread.assignedTo && access.email) {
          const blocked = await capBlock(access, phone);
          if (blocked) return json({ ok: false, message: blocked }, 409);
          await assignConversation(phone, access.email, now);
          await audit({ phone, action: "assigned", reason: "follow_up_later", detail: { from: null }, actor: who });
          claimed = true;
        }
        await moveChat(phone, to, who, now, { revisitAt, from: thread.folder });
        const messages: Record<ChatFolder, string> = {
          active: "Back in the inbox.",
          booked: "Moved to 📅 Booked. No more automatic texts, and it's never auto-released. If the customer texts, the owner is tagged in Slack (with the AI on, the AI answers too).",
          not_interested: "Moved to 🚫 Not interested. No more automatic texts. It comes back to the inbox if the customer texts.",
          revisit: `Follow up ${revisitAt ? new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric" }).format(revisitAt) : "on that date"}: it's under Later in ${thread.assignedTo && thread.assignedTo !== access.email ? "the owner's" : "your"} Follow-ups and moves up to Due that day (back to the inbox sooner if the customer texts).${claimed ? " This customer is yours now." : ""}`,
          spam: "Moved to 🗑️ Spam. The AI, alerts and automatic texts are off for this number, even if it texts again.",
          test: "Moved to 🧪 Test. Hidden from the inbox; the AI and alerts still work.",
        };
        return json({ ok: true, message: messages[to] });
      }
      case "set_name": {
        const name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 120);
        const [first, ...rest] = name ? name.split(" ") : [];
        await setContactName(phone, first || null, rest.join(" ") || null);
        return json({ ok: true, message: name ? `Saved name: ${name}.` : "Name cleared." });
      }
      default:
        return json({ ok: false, message: "Unknown action." }, 400);
    }
  } catch (error) {
    console.error("SMS inbox POST failed:", error instanceof Error ? error.message : error);
    return json({ ok: false, message: "Something went wrong. Try again." }, 500);
  }
}

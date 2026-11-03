/**
 * /api/sms/inbox — the Texting inbox (step 3). Who may use it: TEXTING_INBOX_ROLES
 * in lib/access.ts (checked by proxy.ts and again below).
 *
 *   GET  ?q=<search>          -> conversation list, "Needs CSR" first
 *   GET  ?phone=<number>      -> one conversation (texts, AI notes, handoff, reply blockers)
 *   POST {action:"send", phone, body}   -> a person's reply through the ONE send helper
 *                                          (kind "manual": 8 AM–7 PM their time, opt-outs,
 *                                          consent, caps, pilot list all apply). Pauses the AI.
 *   POST {action:"take_over", phone}    -> pause the AI for this number without texting
 *   POST {action:"resume_bot", phone}   -> turn the AI back on for this number
 *   POST {action:"mark_handled", phone} -> clear "Needs CSR" (AI on/off unchanged)
 *   POST {action:"set_name", phone, name}
 *   POST {action:"claim", phone}        -> "Take it": this customer is mine
 *   POST {action:"release", phone}      -> back to the shared queue (own customer, or owner/manager)
 *   POST {action:"assign", phone, to}   -> owners/managers give the customer to a team member (email)
 *   POST {action:"mark_booked", phone}  -> "Booked in ServiceTitan" (step 4a): clears the "📅 Ready to book"
 *                                          flag; an unowned customer becomes the booker's
 *   POST {action:"stop_drip", phone}    -> step 5: stop this lead's drip for good
 */
import { NextResponse } from "next/server";
import { canUseTextingInbox, type DennyAccess } from "@/lib/access";
import { getCurrentAccess } from "@/lib/currentAccess";
import { bookingFrom, bookingLines, shortTimeWords } from "@/lib/sms/booking";
import { dripLabel, stopDrip } from "@/lib/sms/drip";
import { stCheckSummary, type StCheck } from "@/lib/sms/stCheck";
import { READY_TO_BOOK_LABEL, handoffLabel, inboxFlag, replyBlockers, sortInbox } from "@/lib/sms/inbox";
import { formatPhone, normalizePhone } from "@/lib/sms/rules";
import { sendSms, smsNow } from "@/lib/sms/send";
import {
  CHECKING_SENDER,
  HOLD_SENDER,
  assignConversation,
  audit,
  inboxThread,
  listInboxConversations,
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
  return access && canUseTextingInbox(access.role) ? access : null;
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

function nameFor(email: string | null, team: TeamMember[]): string | null {
  if (!email) return null;
  return team.find((m) => m.email === email)?.displayName || email.split("@")[0];
}

/** Inbound photos are Twilio links that need our Twilio login, so the page loads them through /api/sms/inbox/media. */
function viewableMedia(messageId: number, direction: "inbound" | "outbound", media: string[]): string[] {
  if (direction === "outbound") return media;
  return media.map((_, i) => `/api/sms/inbox/media?id=${messageId}&i=${i}`);
}

export async function GET(request: Request) {
  const access = await requireInboxUser();
  if (!access) return json({ error: "You don't have access to the Texting inbox." }, 403);
  if (!smsDatabaseConfigured()) return json({ error: "Texting database isn't set up." }, 500);
  const url = new URL(request.url);
  const now = smsNow();

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
      }, now);
      const team = await inboxTeam();
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
          phoneLabel: formatPhone(phone),
          lead: thread.lead.at || thread.lead.drip.status
            ? {
                at: thread.lead.at,
                count: thread.lead.count,
                info: thread.lead.info,
                dripStatus: thread.lead.drip.status,
                dripLabel: dripLabel(thread.lead.drip, thread.timeZone),
                stCheck: thread.lead.stCheck ? stCheckSummary(thread.lead.stCheck as StCheck) : null,
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
        canAssign: canAssignOthers(access),
        team: canAssignOthers(access) ? team.map((m) => ({ email: m.email, name: m.displayName })) : [],
      });
    }

    const rows = await listInboxConversations({ search: url.searchParams.get("q") || undefined });
    const team = await inboxTeam();
    const conversations = sortInbox(rows.map((row) => {
      const booking = bookingFrom(row.bookingRequest);
      return {
        ...row,
        bookingRequest: undefined,
        // Shown under the "📅 Ready to book" badge so the time is visible without opening it.
        bookingTime: booking && !row.bookingDoneAt ? shortTimeWords(booking.chosen) : null,
        assignedName: nameFor(row.assignedTo, team),
        phoneLabel: formatPhone(row.phone),
        flag: inboxFlag({ ...row, bookingRequest: booking }, now),
      };
    }));
    return json({
      conversations,
      needsCsr: conversations.filter((c) => c.flag.needsCsr).length,
      me: access.email,
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
        const stopped = await stopDrip(phone, `stopped by ${who}`, who, now);
        return json({ ok: stopped, message: stopped ? "Drip stopped for this customer. No more automated texts." : "This customer has no running drip." });
      }
      case "take_over": {
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
        if (thread.assignedTo && thread.assignedTo !== access.email && !canAssignOthers(access)) {
          return json({ ok: false, message: `${nameFor(thread.assignedTo, await inboxTeam())} already has this customer. Ask a manager to reassign it.` }, 409);
        }
        await assignConversation(phone, access.email, now);
        await audit({ phone, action: "assigned", reason: "claimed", detail: { from: thread.assignedTo }, actor: who });
        return json({ ok: true, message: "This customer is yours now." });
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
        await audit({ phone, action: "booking_marked_booked", reason: "inbox", detail: { owner: thread.assignedTo || access.email }, actor: who });
        return json({ ok: true, message: `Marked booked in ServiceTitan.${!thread.assignedTo && access.email ? " This customer is yours now." : ""} The AI stays paused; text the customer if you want to confirm.` });
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

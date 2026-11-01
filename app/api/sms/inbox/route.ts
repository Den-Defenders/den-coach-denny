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
 */
import { NextResponse } from "next/server";
import { canUseTextingInbox } from "@/lib/access";
import { getCurrentAccess } from "@/lib/currentAccess";
import { handoffLabel, inboxFlag, replyBlockers, sortInbox } from "@/lib/sms/inbox";
import { formatPhone, normalizePhone } from "@/lib/sms/rules";
import { sendSms, smsNow } from "@/lib/sms/send";
import {
  HOLD_SENDER,
  audit,
  inboxThread,
  listInboxConversations,
  markHandoffHandled,
  resumeBot,
  setContactName,
  smsDatabaseConfigured,
  takeOverConversation,
} from "@/lib/sms/store";

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

/** Inbound photos are Twilio links that need our Twilio login, so the page loads them through /api/sms/inbox/media. */
function viewableMedia(messageId: number, direction: "inbound" | "outbound", media: string[]): string[] {
  if (direction === "outbound") return media;
  return media.map((_, i) => `/api/sms/inbox/media?id=${messageId}&i=${i}`);
}

export async function GET(request: Request) {
  if (!await requireInboxUser()) return json({ error: "You don't have access to the Texting inbox." }, 403);
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
      // The automatic hold text answers nothing, so it doesn't count as the latest reply.
      const last = [...thread.messages].reverse().find((m) => m.status !== "send_failed" && m.sentBy !== HOLD_SENDER);
      const flag = inboxFlag({
        botStatus: thread.botStatus,
        handoffReason: thread.handoffReason,
        handoffResolvedAt: thread.handoffResolvedAt,
        optedOut: Boolean(thread.optOut),
        lastDirection: last?.direction || "outbound",
        lastBody: last?.body || "",
        lastAt: last?.createdAt || "",
      }, now);
      return json({
        thread: {
          ...thread,
          phoneLabel: formatPhone(phone),
          handoffLabel: thread.handoffReason ? handoffLabel(thread.handoffReason) : null,
          messages: thread.messages.map((m) => ({ ...m, media: viewableMedia(m.id, m.direction, m.media) })),
        },
        flag,
        reply: replyBlockers(thread, now),
      });
    }

    const rows = await listInboxConversations({ search: url.searchParams.get("q") || undefined });
    const conversations = sortInbox(rows.map((row) => ({
      ...row,
      phoneLabel: formatPhone(row.phone),
      flag: inboxFlag(row, now),
    })));
    return json({
      conversations,
      needsCsr: conversations.filter((c) => c.flag.needsCsr).length,
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

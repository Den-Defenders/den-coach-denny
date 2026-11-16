/**
 * lib/sms/notes.ts
 *
 * Team notes (Steven, 2026-11-16): CSRs add internal notes to a chat, mostly about calls
 * ("📞 Called, talked: wants to talk to his wife first, call back Thursday after 5").
 * Notes are NEVER texted to the customer.
 *   - Quick call buttons: 📞 Called, talked / 📞 Left voicemail / 📞 No answer (+ optional detail).
 *   - Optional "Follow up on" date: files the chat in Follow-ups → Later for that day.
 *   - They show in the chat as yellow bubbles between the texts, the latest one in the list,
 *     on the 📅 Ready-to-book card and in Slack alerts. Search finds them.
 *   - The AI reads the latest notes for context (never quotes or mentions them).
 *   - The scoreboard counts calls logged per person.
 *   - The author can edit/delete their note; owners and managers can edit/delete any.
 */
import { latestTeamNotes, teamNotesFor, type NoteKind, type TeamNote } from "@/lib/sms/store";

export const NOTE_LABELS: Record<NoteKind, string> = {
  note: "📝 Note",
  call_talked: "📞 Called, talked",
  call_voicemail: "📞 Left voicemail",
  call_no_answer: "📞 No answer",
};

function pacific(at: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(at));
}

/** "📞 Left voicemail: call back after 5" (label only when there's no text). */
export function noteText(note: Pick<TeamNote, "kind" | "body">): string {
  const body = note.body.replace(/\s+/g, " ").trim();
  if (note.kind === "note") return body;
  return body ? `${NOTE_LABELS[note.kind]}: ${body}` : NOTE_LABELS[note.kind];
}

/** One line for Slack alerts: "📝 Latest team note (Liz, Mon, Nov 16, 10:15 AM): …". */
export async function latestNoteLine(phone: string, nameFor?: (email: string) => Promise<string>): Promise<string> {
  try {
    const note = (await latestTeamNotes([phone])).get(phone);
    if (!note) return "";
    const who = nameFor ? await nameFor(note.createdBy) : note.createdBy.split("@")[0];
    const text = noteText(note);
    return `:memo: *Latest team note* (${who}, ${pacific(note.createdAt)}): ${text.length > 300 ? `${text.slice(0, 297)}...` : text}`;
  } catch (error) {
    console.error("SMS latest note lookup failed:", error instanceof Error ? error.message : error);
    return "";
  }
}

/** For the AI: the newest few notes, oldest first, as plain lines. Internal context only. */
export async function notesForAi(phone: string, limit = 6): Promise<string[]> {
  try {
    const notes = await teamNotesFor(phone, limit);
    return notes.map((n) => `${pacific(n.createdAt)}: ${noteText(n)}`.slice(0, 400));
  } catch (error) {
    console.error("SMS notes for AI failed:", error instanceof Error ? error.message : error);
    return [];
  }
}

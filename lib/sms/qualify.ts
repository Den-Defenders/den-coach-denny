/**
 * lib/sms/qualify.ts
 *
 * Session 6 PR 4b (Steven, 2026-11-05): before a picked time goes to the team,
 * ask whether they'd like a quick call from a rep or to keep texting. By text,
 * Denny asks the qualifying questions one at a time, skipping any the customer
 * already answered, then passes the "📅 Ready to book" request with the answers.
 *
 * The questions and the "answered" checks live here; lib/sms/bot.ts runs them
 * (code sends the questions and saves the answers, so no AI cost per answer).
 */

// Wording fix 2026-11-15 (Steven, Ben Tabingo's chat): sounded like paperwork.
export const FOLLOW_UP_QUESTION =
  "Just a few quick questions so our rep comes prepared. Would you rather answer them by text, or have one of our reps give you a quick call?";
/** The old wording: conversations already in the middle of it still count. */
const OLD_FOLLOW_UP_QUESTION = "There are a few more questions I need to clarify before booking. Would you prefer a phone call";

/** This text of ours is the call-or-text question (new or old wording). */
export function isFollowUpQuestion(text: string): boolean {
  return (text || "").includes(FOLLOW_UP_QUESTION.slice(0, 60)) || (text || "").includes(OLD_FOLLOW_UP_QUESTION);
}

/** Code-only notes. */
export const FOLLOW_UP_KEY = "_follow_up";
export const BOOKING_NAME_KEY = "_booking_name";
export const BOOKING_ADDRESS_KEY = "_booking_address";

export type Qualifier = { key: string; ask: string };

const DM_REQUIREMENT = /decision.?makers? to be (at|on site)/i;
const PRIORITY_WORDS = /\b(secur|safe|protect|break.?in|look|appear|style|curb|pretty|value|last|durab|quality|invest)/i;

/** Steven's 7 questions (2026-11-05), in order. Wording lightly cleaned for SMS (no dashes). */
export const QUALIFIERS: Qualifier[] = [
  { key: "need", ask: "What had you looking into our products? Was there a specific concern, or are you just looking to upgrade?" },
  { key: "priority", ask: "What's most important to you in a solution like this: security, appearance, or long-term value?" },
  { key: "other_options", ask: "Have you looked at other options yet, or are you just starting the process?" },
  { key: "timing", ask: "Are you looking to handle this fairly soon, or just gathering options for now?" },
  { key: "entry_points", ask: "Which entry points are you most focused on: front door, side, or back?" },
  { key: "decision_makers", ask: "We do require all decision makers to be at the appointment. Are you the only decision-maker, or is this something you're reviewing with someone else in the home?" },
  { key: "access_notes", ask: "Any special parking or other instructions for our rep, like a gate code or parking in the driveway?" },
];
/** When they told us who decides before we said everyone must be there. */
export const DM_REMINDER = "Just so you know, we do require all decision makers to be at the appointment. Will everyone who's deciding be able to be there?";

/**
 * Wording fix 2026-11-15 (Ben: "Me and the wife" got no follow-up): when someone else decides
 * too, confirm they'll be at the appointment.
 */
const DM_CONFIRM_MARK = "be able to be at the appointment too?";
const JUST_ME = /^\W*(just me|only me|me only|me alone|myself|i am|i'm the only|i do|i decide|me)\W*$/i;
export function otherDecider(answer: string): string | null {
  const t = (answer || "").toLowerCase();
  if (!t.trim() || JUST_ME.test(t)) return null;
  const who = /\b(wife|husband|spouse|partner|fianc[eé]e?|girlfriend|boyfriend|mom|mother|dad|father|parents|son|daughter|landlord|roommate|brother|sister)\b/.exec(t);
  if (who) return `your ${who[1]}`;
  if (/\b(we|us|both|and (my|the|our)|with (my|the|our)|together|family|someone|somebody|others?|co-?owner)\b/.test(t)) return "everyone who's deciding";
  return null;
}
export function dmConfirmQuestion(who: string): string {
  return who === "everyone who's deciding" ? `Will ${who} ${DM_CONFIRM_MARK}`.replace(" too?", "?") : `Will ${who} ${DM_CONFIRM_MARK}`;
}
function askedDmConfirm(ourTexts: string[]): boolean {
  return ourTexts.some((t) => t.includes(DM_CONFIRM_MARK) || t.includes("be able to be at the appointment?"));
}

/**
 * A short, human reaction before the next question, when their answer deserves one
 * (Ben: "Just gathering options, different quotes from different companies" got none). Once per chat.
 */
export const COMPARING_ACK = "Totally fair, most people compare. Our rep will measure and give you an exact written quote at the visit, no pressure.";
export function qualifierAck(answer: string, ourTexts: string[]): string {
  if (ourTexts.some((t) => t.includes(COMPARING_ACK.slice(0, 40)))) return "";
  return /\b(quotes?|compar\w*|shopping|shop around|other compan\w*|different compan\w*|estimates?|gathering options|looking around)\b/i.test(answer || "") ? COMPARING_ACK : "";
}

function has(notes: Record<string, string>, key: string): boolean {
  return Boolean((notes[key] || "").trim());
}

/** The next question to ask by text, or null when everything is answered. */
export function nextQualifier(notes: Record<string, string>, ourTexts: string[]): Qualifier | null {
  const toldRequirement = ourTexts.some((t) => DM_REQUIREMENT.test(t));
  for (const q of QUALIFIERS) {
    if (q.key === "priority" && (has(notes, "priority") || PRIORITY_WORDS.test(notes.need || ""))) continue;
    if (q.key === "entry_points" && (has(notes, "entry_points") || has(notes, "product") || has(notes, "door_count"))) continue;
    if (q.key === "decision_makers") {
      if (!has(notes, "decision_makers")) return q;
      if (!toldRequirement) return { key: "decision_makers", ask: DM_REMINDER };
      const who = otherDecider(notes.decision_makers);
      if (who && !askedDmConfirm(ourTexts)) return { key: "decision_makers", ask: dmConfirmQuestion(who) };
      continue;
    }
    if (!has(notes, q.key)) return q;
  }
  return null;
}

/** The qualifier our last text asked (exact wording), if any. */
export function pendingQualifier(lastOurs: string): Qualifier | null {
  if (!lastOurs) return null;
  if (lastOurs.includes(DM_REMINDER.slice(0, 60))) return { key: "decision_makers", ask: DM_REMINDER };
  if (askedDmConfirm([lastOurs])) return { key: "decision_makers", ask: lastOurs };
  return QUALIFIERS.find((q) => lastOurs.includes(q.ask.slice(0, 50))) || null;
}

export function askedFollowUp(ourTexts: string[]): boolean {
  return ourTexts.some(isFollowUpQuestion);
}

/** "Call me" / "phone" -> call; "text" / "keep texting" -> text; otherwise null. */
export function followUpFromText(text: string): "call" | "text" | null {
  const t = (text || "").toLowerCase();
  const call = /\b(call|phone|ring|talk|speak)\b/.test(t);
  const txt = /\b(text|texting|txt|message|messaging|keep going|here is fine|this is fine)\b/.test(t);
  if (call && !txt) return "call";
  if (txt && !call) return "text";
  if (call && txt) return /\b(call me|phone call|rather (talk|call)|prefer (a )?(call|phone))\b/.test(t) ? "call" : /\b(keep texting|prefer text|rather text|text is (fine|better|good))\b/.test(t) ? "text" : null;
  return null;
}

/** Their reply looks like an answer, not a question or a change of plans. */
export function looksLikeAnswer(text: string): boolean {
  const t = (text || "").trim();
  return Boolean(t) && !/\?\s*$/.test(t) && !/\?/.test(t.slice(-40));
}

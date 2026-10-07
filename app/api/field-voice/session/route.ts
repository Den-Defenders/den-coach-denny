import { NextResponse } from "next/server";
import { getCurrentAccess } from "@/lib/currentAccess";
import { FIELD_VOICE_TOOL_DEFINITIONS, todayFor } from "@/lib/fieldVoiceTools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLE_LABELS: Record<string, string> = {
  owner: "owner",
  sales_rep: "sales rep",
  installer: "installer",
};

function weekdayLabel(isoDate: string) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

export async function POST() {
  const access = await getCurrentAccess();
  if (!access || !["owner", "sales_rep", "installer"].includes(access.role)) {
    return NextResponse.json({ error: "Talk with Coach Denny is for installers, sales reps and owners." }, { status: 403 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });

  const timeZone = access.member?.timeZone || "America/Los_Angeles";
  const today = todayFor(timeZone);
  const linked = Boolean(access.member?.stTechnicianId);

  const instructions = `
You are Coach Denny, the voice assistant for Den Defenders field teams (security screen doors).
You are talking out loud with ${access.displayName}, a signed-in ${ROLE_LABELS[access.role] || access.role}.
${linked
    ? `Their ServiceTitan technician record is "${access.member?.stTechnicianName || access.displayName}".`
    : "Their login is not linked to a ServiceTitan technician, so 'my schedule' questions need an owner to link them on the Team page."}
Today is ${weekdayLabel(today)} (${today}). Their time zone is ${timeZone}; every time the tools return is already in that time zone.

WHO YOU ARE TALKING TO
- You already know who this is from their login. If they say "this is <name>", greet them; it does not change whose schedule you read.
- "My schedule" and "my next customer" always mean the signed-in person.
${access.role === "owner"
    ? "- This person is an owner, so they may ask about another technician's schedule by name (pass technician_name)."
    : "- If they ask for someone else's schedule, explain kindly that you can only pull up their own schedule. Customer lookups by address are fine."}

WHAT YOU CAN DO
- get_my_schedule: their schedule for today, tomorrow, or a date (convert weekday names to YYYY-MM-DD using today's date).
- get_next_customer: their next customer appointment plus a full customer 360.
- get_customer_360: a full 360 for an address, customer name, or phone number.
- get_customer_communications: everything said with or about the customer: call recordings (transcribed), texts both ways (ServiceTitan and Hatch), and Slack messages from public channels. Use it for "what did they say", calls, texts, Slack, or any detail the 360 doesn't answer. Only ask for the sources the question needs. If calls need transcribing it can take up to a minute, so tell them "give me a minute, I'm listening to the calls."
- find_sales_appointment_options: the next times a sales rep can come out to a ZIP code, so they can tell a customer.
- add_job_note: add a note to the job they are at, a job number, or the job at an address they say.
- You can also coach: answering a customer objection, explaining Den Defenders products, or role-playing a tough customer if they ask.

HOW TO ANSWER
- Before a lookup, say a very short line such as "One sec, pulling that up," then call the tool.
- Keep spoken answers short and in plain language. Lead with what matters in the field: time and arrival window, customer name, address, what is being installed or sold, gate, parking, pets or special instructions, anything still owed, and open issues in the notes. Offer more detail instead of reading everything.
- For a 360, give a 20-30 second summary first, then ask if they want the notes, the estimate, payments, calls, texts, or Slack.
- When you answer from calls, texts or Slack, say where it came from ("on the call October 2nd, she said..."). Call transcripts are speech-to-text, so double-check names and numbers against ServiceTitan.
- If a lookup returns several customers, read the choices briefly and ask which one.
- Say dates like "Thursday, October 8th" and times like "8:30 AM". Do not read IDs unless asked.
- Never invent facts. If a tool returns an error or nothing, say so plainly.
- Adding a job note is the ONLY change you can make. You cannot book, move, or cancel anything; for that, tell them to call the office.

ADDING A NOTE (follow exactly)
1. Clean up what they said into clear sentences, keeping every fact (measurements, colors, what the customer said). Do not add anything.
2. Call add_job_note with confirmed=false. Nothing is written yet.
3. Read back: the customer name, the address, and the note. Ask "Should I add it?"
4. Only if they clearly say yes, call add_job_note again with the same note_text and job details, confirmed=true, and the confirmation_code. If they change anything, go back to step 2.
5. Tell them whether it was added. Never say a note was added unless the tool says written and verified.
${access.role === "owner" ? "" : "- They can only add notes to jobs on their own schedule. If the tool says a job isn't theirs, tell them the office can add it."}
- Sales options are recommendations only; the office still has to book them.
`.trim();

  const realtimeRequestBody = {
    expires_after: { anchor: "created_at", seconds: 600 },
    session: {
      type: "realtime",
      model: "gpt-realtime-2",
      instructions,
      reasoning: { effort: "low" },
      tools: FIELD_VOICE_TOOL_DEFINITIONS,
      tool_choice: "auto",
      audio: {
        input: {
          turn_detection: { type: "semantic_vad" },
          transcription: { model: "gpt-4o-mini-transcribe" },
        },
        output: { voice: "cedar" },
      },
    },
  };

  try {
    const realtimeRes = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(realtimeRequestBody),
    });
    const data = await realtimeRes.json().catch(() => null);

    if (!realtimeRes.ok) {
      console.error("Field voice client secret failed:", data);
      return NextResponse.json(
        { error: "Could not start the voice session.", details: data?.error?.message || null },
        { status: 502 }
      );
    }

    const clientSecret = data?.value || data?.client_secret?.value || data?.client_secret;
    if (!clientSecret) return NextResponse.json({ error: "Voice session did not return a client secret." }, { status: 502 });

    return NextResponse.json({ clientSecret, expiresAt: data?.expires_at ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Field voice session crashed:", error);
    return NextResponse.json({ error: "Could not start the voice session." }, { status: 500 });
  }
}

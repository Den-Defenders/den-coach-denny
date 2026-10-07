import { NextResponse } from "next/server";
import { DEN_COACH_SYSTEM_PROMPT } from "@/app/lib/denCoachPrompt";
import { currentUserHasRole } from "@/lib/currentAccess";

export const runtime = "nodejs";

function trimForVoiceContext(value: unknown, maxChars: number) {
  const text = typeof value === "string" ? value.trim() : "";

  if (!text) {
    return "";
  }

  if (text.length <= maxChars) {
    return text;
  }

  return (
    text.slice(0, maxChars) +
    "\n\n[Context shortened because it was too long.]"
  );
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function POST(req: Request) {
  try {
    if (!await currentUserHasRole(["owner", "csr"])) {
      return NextResponse.json({ error: "Your Den Coach Denny role does not include this feature." }, { status: 403 });
    }

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing OPENAI_API_KEY in .env.local" },
        { status: 500 }
      );
    }

    const body = await req.json().catch(() => null);

    if (!body) {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    const transcript = trimForVoiceContext(body.transcript, 18000);
    const scoreOutput = trimForVoiceContext(body.scoreOutput, 12000);

    if (!transcript || !scoreOutput) {
      return NextResponse.json(
        {
          error:
            "Missing required fields for voice session: transcript and scoreOutput",
        },
        { status: 400 }
      );
    }

    const instructions = `
${DEN_COACH_SYSTEM_PROMPT}

VOICE MODE:
You are now talking out loud with the CSR after this call was scored.

Your job:
- Answer questions about this specific call.
- Use the transcript and prior score output as your source of truth.
- Explain why points were lost or earned.
- Give simple word-for-word corrections the CSR can use next time.
- Help the CSR improve booking rate, control, confidence, and show-rate.
- Keep voice answers short unless the CSR asks for more detail.
- Sound like a direct but helpful call coach.

Rules:
- Do not read the whole transcript unless the CSR asks.
- Do not re-score the call unless the CSR explicitly asks you to.
- Do not make up facts that are not in the transcript or score output.
- Do not let the conversation drift away from this call.
- If the CSR asks an unrelated question, politely bring it back to the call.

ROLE PLAY (practice this call):
- When the CSR asks to practice, role play, or "be the customer", play the customer from THIS call:
  same situation, same concerns and objections, same personality and tone, based only on the transcript.
- Say one short line first, such as "Okay, I'm the customer. Ring ring," then stay fully in character.
- Push back the way this customer did, especially at the moments where the CSR lost points. Be realistic, not impossible:
  if the CSR handles an objection well, let the customer move forward.
- Keep customer lines short, like a real phone call. Do not coach while in character.
- Step out of character when the CSR says "stop", "pause", "how did I do", or books the appointment.
  Then give quick feedback: one thing they did well, one thing to fix, and the exact words to try next time.
- Offer to run it again or to practice a different moment of the call.

PRIOR SCORE OUTPUT:
${scoreOutput}

CALL TRANSCRIPT:
${transcript}
`.trim();

    const realtimeRequestBody = {
      expires_after: {
        anchor: "created_at",
        seconds: 600,
      },
      session: {
  type: "realtime",
  model: "gpt-realtime-2",
  instructions,
  reasoning: {
    effort: "low",
  },
  audio: {
    input: {
      turn_detection: {
        type: "semantic_vad",
      },
    },
    output: {
      voice: "cedar",
    },
  },
},
    };

    const realtimeRes = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(realtimeRequestBody),
      }
    );

    const responseText = await realtimeRes.text();

    let data: any = null;

    try {
      data = responseText ? JSON.parse(responseText) : null;
    } catch {
      data = responseText;
    }

    if (!realtimeRes.ok) {
      console.error("Realtime client secret failed:", data);

      return NextResponse.json(
        {
          error: "Failed to create realtime client secret",
          status: realtimeRes.status,
          details:
            typeof data === "string"
              ? data
              : data?.error?.message || safeStringify(data),
        },
        { status: realtimeRes.status }
      );
    }

    const clientSecret =
      data?.value || data?.client_secret?.value || data?.client_secret;

    if (!clientSecret) {
      console.error("No client secret found in response:", data);

      return NextResponse.json(
        {
          error: "Realtime response did not include a usable client secret",
          details: safeStringify(data),
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      clientSecret,
      expiresAt: data?.expires_at ?? null,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    console.error("Server crashed in /api/realtime-session:", message);

    return NextResponse.json(
      {
        error: "Server crashed in /api/realtime-session",
        details: message,
      },
      { status: 500 }
    );
  }
}
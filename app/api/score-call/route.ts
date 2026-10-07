import OpenAI from "openai";
import { NextResponse } from "next/server";
import { toFile } from "openai/uploads";
import { DEN_COACH_SYSTEM_PROMPT } from "@/app/lib/denCoachPrompt";
import { currentUserHasRole } from "@/lib/currentAccess";

export const runtime = "nodejs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(req: Request) {
  try {
    if (!await currentUserHasRole(["owner", "csr"])) {
      return NextResponse.json({ error: "Your Den Coach Denny role does not include this feature." }, { status: 403 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing OPENAI_API_KEY" },
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

    const mode = body.mode ?? "score";

    /* ============================
       FOLLOW-UP MODE (NO RE-SCORE)
       ============================ */
    if (mode === "followup") {
      const { csrQuestion, transcript, scoreOutput } = body;

      if (!csrQuestion || !transcript || !scoreOutput) {
        return NextResponse.json(
          {
            error:
              "Missing required fields for followup: csrQuestion, transcript, scoreOutput",
          },
          { status: 400 }
        );
      }

      const followupPrompt = `
You already scored this call.
Do NOT re-score unless explicitly asked.

Use the transcript and prior score output as context.
Answer the CSR's question directly.
Tie your answer to booking rate, control, and show-rate.
Provide a short word-for-word script correction.

CSR Question:
${csrQuestion}

Transcript:
${transcript}

Prior Score Output:
${scoreOutput}
`.trim();

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: DEN_COACH_SYSTEM_PROMPT },
          { role: "user", content: followupPrompt },
        ],
      });

      const answer =
        completion.choices[0]?.message?.content?.trim() || "";

      return NextResponse.json({ answer });
    }

    /* ============================
       SCORE MODE (TRANSCRIBE + COACH)
       ============================ */

    const blobUrl = typeof body.blobUrl === "string" ? body.blobUrl : undefined;
    if (!blobUrl) {
      return NextResponse.json(
        { error: "Missing blobUrl" },
        { status: 400 }
      );
    }

    const callTypeText =
      typeof body.callType === "string" && body.callType.trim()
        ? body.callType.trim()
        : "Unknown";

    const goalText =
      typeof body.goal === "string" && body.goal.trim()
        ? body.goal.trim()
        : "Unknown";

    // Download audio from Blob
    const audioRes = await fetch(blobUrl);
    if (!audioRes.ok) {
      return NextResponse.json(
        { error: "Failed to download audio from Blob" },
        { status: 500 }
      );
    }

    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    const contentType =
      audioRes.headers.get("content-type") || "audio/mpeg";

    const audioFile = await toFile(audioBuffer, "call-audio", {
      type: contentType,
    });

    // Transcribe
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "gpt-4o-mini-transcribe",
    });

    const transcriptText = transcription.text?.trim();
    if (!transcriptText) {
      return NextResponse.json(
        { error: "Empty transcription result" },
        { status: 500 }
      );
    }

    // Coaching + Scoring
    const scoringPrompt = `
Call Type: ${callTypeText}
Goal: ${goalText}

Transcript:
${transcriptText}

Instructions:
- Score strictly using the rubric.
- Follow the OUTPUT FORMAT exactly.
- Be brutally honest and improvement-focused.
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: DEN_COACH_SYSTEM_PROMPT },
        { role: "user", content: scoringPrompt },
      ],
    });

    const feedback =
      completion.choices[0]?.message?.content?.trim() || "";

    return NextResponse.json({
      transcript: transcriptText,
      feedback,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || String(err) },
      { status: 500 }
    );
  }
}

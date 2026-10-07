"use client";

import { useEffect, useRef, useState } from "react";

type Status = "idle" | "connecting" | "connected" | "error";
type LogLine = { id: number; who: "you" | "denny" | "lookup"; text: string };

const LOOKUP_LABELS: Record<string, string> = {
  get_my_schedule: "Checking your ServiceTitan schedule…",
  get_next_customer: "Finding your next customer and building the 360…",
  get_customer_360: "Building the customer 360 in ServiceTitan…",
  get_customer_communications: "Reading calls, texts and Slack for this customer (can take up to a minute)…",
  find_sales_appointment_options: "Checking sales rep availability…",
  add_job_note: "Working on the job note…",
};

export default function FieldVoiceDenny() {
  const [status, setStatus] = useState<Status>("idle");
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState("");
  const [log, setLog] = useState<LogLine[]>([]);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const logIdRef = useRef(0);

  // Function-call bookkeeping: answer every tool call, then ask the model to
  // speak once all of this turn's lookups are back.
  const pendingCallsRef = useRef(0);
  const needsResponseRef = useRef(false);
  const responseDoneRef = useRef(true);
  // Bumped on every start/stop so a lookup from an old session is ignored.
  const sessionIdRef = useRef(0);
  // Safety for notes: the person must actually speak after Denny reads the
  // note back. A "confirmed" note request with no human turn in between
  // (for example, text inside a customer note telling the model to do it)
  // is refused here before it reaches the server.
  const notePreviewAtRef = useRef(0);
  const lastUserSpeechAtRef = useRef(0);
  const handledCallsRef = useRef(new Set<string>());

  function addLog(who: LogLine["who"], text: string) {
    const clean = text.trim();
    if (!clean) return;
    logIdRef.current += 1;
    const id = logIdRef.current;
    setLog((current) => [...current.slice(-60), { id, who, text: clean }]);
  }

  function send(event: unknown) {
    const channel = dcRef.current;
    if (channel?.readyState === "open") channel.send(JSON.stringify(event));
  }

  function maybeAskForAnswer() {
    if (pendingCallsRef.current === 0 && needsResponseRef.current && responseDoneRef.current) {
      needsResponseRef.current = false;
      send({ type: "response.create" });
    }
  }

  function wantsNoteWrite(name: string, args: string) {
    if (name !== "add_job_note") return false;
    try { return JSON.parse(args || "{}")?.confirmed === true; } catch { return false; }
  }

  async function runTool(callId: string, name: string, args: string) {
    if (handledCallsRef.current.has(callId)) return;
    handledCallsRef.current.add(callId);
    const sessionId = sessionIdRef.current;

    pendingCallsRef.current += 1;
    needsResponseRef.current = true;
    addLog("lookup", LOOKUP_LABELS[name] || "Looking that up…");
    setStatusText(LOOKUP_LABELS[name] || "Looking that up…");

    let output: unknown;
    if (wantsNoteWrite(name, args) && !(notePreviewAtRef.current > 0 && lastUserSpeechAtRef.current > notePreviewAtRef.current)) {
      output = { error: "Not written: read the note back and wait for them to say yes out loud first." };
    } else {
      try {
        const response = await fetch("/api/field-voice/tool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, arguments: args }),
        });
        const data = await response.json().catch(() => null);
        output = response.ok ? data?.output : { error: data?.error || `Lookup failed (HTTP ${response.status}).` };
      } catch {
        output = { error: "The lookup could not reach the server." };
      }
    }

    // The person pressed Stop (or restarted) while this was running: drop it.
    if (sessionId !== sessionIdRef.current) return;

    if (name === "add_job_note") {
      const result = output as { preview?: boolean; written?: boolean } | null;
      if (result?.preview) notePreviewAtRef.current = Date.now();
      if (wantsNoteWrite(name, args)) notePreviewAtRef.current = 0; // each yes is used once
      if (result?.written) addLog("lookup", "Note added to the job in ServiceTitan.");
    }

    send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output ?? { error: "No result." }) },
    });
    pendingCallsRef.current = Math.max(0, pendingCallsRef.current - 1);
    maybeAskForAnswer();
  }

  function cleanUp() {
    sessionIdRef.current += 1;
    handledCallsRef.current = new Set();
    notePreviewAtRef.current = 0;
    lastUserSpeechAtRef.current = 0;
    try { dcRef.current?.close(); } catch { /* ignore */ }
    try { pcRef.current?.close(); } catch { /* ignore */ }
    try { streamRef.current?.getTracks().forEach((track) => track.stop()); } catch { /* ignore */ }
    if (audioRef.current) audioRef.current.srcObject = null;
    dcRef.current = null;
    pcRef.current = null;
    streamRef.current = null;
    pendingCallsRef.current = 0;
    needsResponseRef.current = false;
    responseDoneRef.current = true;
  }

  useEffect(() => cleanUp, []);

  async function start() {
    setStatus("connecting");
    setStatusText("Starting Coach Denny…");
    setError("");
    cleanUp();

    try {
      const sessionResponse = await fetch("/api/field-voice/session", { method: "POST" });
      const sessionData = await sessionResponse.json().catch(() => null);
      if (!sessionResponse.ok || !sessionData?.clientSecret) {
        throw new Error(sessionData?.error || `Could not start voice (HTTP ${sessionResponse.status}).`);
      }

      setStatusText("Asking for microphone permission…");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      pc.ontrack = (event) => {
        if (audioRef.current) {
          audioRef.current.srcObject = event.streams[0];
          audioRef.current.play().catch(() => undefined);
        }
      };
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.onopen = () => {
        setStatus("connected");
        setStatusText("Live. Ask Denny about your schedule, your next customer, or an address.");
      };
      dc.onclose = () => setStatusText("Voice chat disconnected.");
      dc.onerror = () => setError("The voice connection had an error.");
      dc.onmessage = (event) => {
        let message: Record<string, unknown>;
        try { message = JSON.parse(event.data); } catch { return; }
        const type = String(message.type || "");

        if (type === "response.created") responseDoneRef.current = false;
        if (type === "response.done") {
          responseDoneRef.current = true;
          maybeAskForAnswer();
          if (pendingCallsRef.current === 0) setStatusText("Live. Ask another question or stop when you're done.");
        }
        // A finished function call (not one cut off when the person talked over Denny).
        if (type === "response.output_item.done") {
          const item = message.item as { type?: string; status?: string; call_id?: string; name?: string; arguments?: string } | undefined;
          if (item?.type === "function_call" && item.status === "completed" && item.call_id && item.name) {
            void runTool(item.call_id, item.name, item.arguments || "{}");
          }
        }
        if (type === "input_audio_buffer.speech_started") {
          lastUserSpeechAtRef.current = Date.now();
          setStatusText("Denny is listening…");
        }
        if (type === "conversation.item.input_audio_transcription.completed") addLog("you", String(message.transcript || ""));
        if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
          addLog("denny", String(message.transcript || ""));
        }
        if (type === "error") {
          const detail = (message.error as { message?: string } | undefined)?.message;
          setError(detail || "Coach Denny's voice session returned an error.");
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!offer.sdp) throw new Error("Could not create the voice connection.");

      const answer = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionData.clientSecret}`, "Content-Type": "application/sdp" },
        body: offer.sdp,
      });
      const answerSdp = await answer.text();
      if (!answer.ok) throw new Error(answerSdp || `Voice connection failed (HTTP ${answer.status}).`);
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      setStatusText("Finishing connection…");
    } catch (startError: unknown) {
      cleanUp();
      setStatus("error");
      setStatusText("Coach Denny voice chat could not start.");
      setError(startError instanceof Error ? startError.message : String(startError));
    }
  }

  function stop() {
    cleanUp();
    setStatus("idle");
    setStatusText("Voice chat stopped.");
  }

  const live = status === "connected";

  return (
    <section className="surface talk-panel">
      <div className="talk-examples" aria-label="Things you can ask">
        <span>“What does my schedule look like tomorrow?”</span>
        <span>“Give me a 360 of my next customer.”</span>
        <span>“What’s the 360 of 123 Main Street?”</span>
        <span>“When can a sales rep come out to 95610?”</span>
        <span>“Add a note to the job I’m at: …”</span>
      </div>

      <div className="voice-actions">
        {!live ? (
          <button type="button" className="btn btn-teal" disabled={status === "connecting"} onClick={start}>
            {status === "connecting" ? "Connecting…" : "Start talking to Denny"}
          </button>
        ) : (
          <button type="button" className="btn btn-coral" onClick={stop}>Stop</button>
        )}
        <span className="talk-status">{live ? "● Live" : "Not live"}</span>
      </div>

      {statusText && <p style={{ margin: 0 }}>{statusText}</p>}
      {error && <pre className="talk-error">{error}</pre>}

      {log.length > 0 && (
        <div className="talk-log" aria-live="polite">
          {log.map((line) => (
            <div key={line.id} className={`talk-line talk-line-${line.who}`}>
              {line.who === "you" ? "You: " : line.who === "denny" ? "Denny: " : ""}{line.text}
            </div>
          ))}
        </div>
      )}

      <audio ref={audioRef} autoPlay />
    </section>
  );
}

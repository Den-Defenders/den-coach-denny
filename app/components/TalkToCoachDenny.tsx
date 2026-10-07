"use client";

import { useRef, useState } from "react";

type TalkToCoachDennyProps = {
  transcript: string;
  scoreOutput: string;
};

type VoiceStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "stopping"
  | "error";

export default function TalkToCoachDenny({
  transcript,
  scoreOutput,
}: TalkToCoachDennyProps) {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [statusText, setStatusText] = useState("");
  const [lastError, setLastError] = useState("");

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  const isConnected = status === "connected";
  const isWorking = status === "connecting" || status === "stopping";

  function cleanUpConnection() {
    try {
      dataChannelRef.current?.close();
    } catch {
      // ignore
    }

    try {
      peerConnectionRef.current?.close();
    } catch {
      // ignore
    }

    try {
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
    } catch {
      // ignore
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }

    dataChannelRef.current = null;
    peerConnectionRef.current = null;
    localStreamRef.current = null;
  }

  function getReadableErrorText(value: unknown) {
    if (value instanceof Error) {
      return value.message;
    }

    if (typeof value === "string") {
      return value;
    }

    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  async function startVoiceChat() {
    if (!transcript || !scoreOutput) {
      setStatus("error");
      setStatusText("Run a score first so Coach Denny has the call context.");
      setLastError("Missing transcript or coaching feedback.");
      return;
    }

    setStatus("connecting");
    setStatusText("Starting Coach Denny voice chat...");
    setLastError("");

    try {
      cleanUpConnection();

      const sessionResponse = await fetch("/api/realtime-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          transcript,
          scoreOutput,
        }),
      });

      const sessionData = await sessionResponse.json().catch(() => null);

      if (!sessionResponse.ok) {
        throw new Error(
          sessionData?.error ||
            sessionData?.details ||
            `Failed to create realtime session. HTTP ${sessionResponse.status}`
        );
      }

      const clientSecret = sessionData?.clientSecret;

      if (!clientSecret) {
        throw new Error("No realtime client secret returned.");
      }

      setStatusText("Asking for microphone permission...");

      const localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      localStreamRef.current = localStream;

      setStatusText("Connecting to Coach Denny...");

      const peerConnection = new RTCPeerConnection();
      peerConnectionRef.current = peerConnection;

      peerConnection.ontrack = (event) => {
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = event.streams[0];

          remoteAudioRef.current.play().catch(() => {
            // This started from a button click, so most browsers allow it.
          });
        }
      };

      localStream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, localStream);
      });

      const dataChannel = peerConnection.createDataChannel("oai-events");
      dataChannelRef.current = dataChannel;

      dataChannel.onopen = () => {
        setStatus("connected");
        setStatusText(
          "Connected. Ask Coach Denny a question out loud about this call."
        );
      };

      dataChannel.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);

          if (message?.type === "error") {
            setLastError(
              message?.error?.message ||
                "Coach Denny voice session returned an error."
            );
          }

          if (message?.type === "input_audio_buffer.speech_started") {
            setStatusText("Coach Denny is listening...");
          }

          if (
            message?.type === "response.audio.delta" ||
            message?.type === "response.output_audio.delta"
          ) {
            setStatusText("Coach Denny is answering...");
          }

          if (message?.type === "response.done") {
            setStatusText(
              "Connected. Ask another question or stop the voice chat."
            );
          }
        } catch {
          // Ignore messages that are not JSON.
        }
      };

      dataChannel.onerror = () => {
        setLastError("The voice data channel had an error.");
      };

      dataChannel.onclose = () => {
        setStatusText("Voice chat disconnected.");
      };

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      if (!offer.sdp) {
        throw new Error("Could not create WebRTC offer.");
      }

      const realtimeResponse = await fetch(
        "https://api.openai.com/v1/realtime/calls",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${clientSecret}`,
            "Content-Type": "application/sdp",
          },
          body: offer.sdp,
        }
      );

      const answerSdp = await realtimeResponse.text();

      if (!realtimeResponse.ok) {
        throw new Error(
          answerSdp ||
            `Realtime connection failed. HTTP ${realtimeResponse.status}`
        );
      }

      await peerConnection.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      });

      setStatusText("Finishing connection...");
    } catch (err: unknown) {
      cleanUpConnection();

      setStatus("error");
      setStatusText("Coach Denny voice chat failed.");
      setLastError(getReadableErrorText(err));
    }
  }

  function stopVoiceChat() {
    setStatus("stopping");
    setStatusText("Stopping Coach Denny voice chat...");
    cleanUpConnection();
    setStatus("idle");
    setStatusText("Voice chat stopped.");
  }

  return (
    <div className="voice-card">
      <h3 style={{ marginTop: 0, marginBottom: 8 }}>
        Talk to Coach Denny
      </h3>

      <p style={{ marginTop: 0, opacity: 0.85 }}>
        Ask Coach Denny questions out loud about this scored call, or say
        &ldquo;let&rsquo;s role play&rdquo; and he will play this customer so you can
        practice. Say &ldquo;how did I do?&rdquo; to get feedback.
      </p>

      <div className="voice-actions">
        {!isConnected ? (
          <button
            type="button"
            disabled={isWorking}
            onClick={startVoiceChat}
            className="btn btn-teal"
            style={{
              cursor: isWorking ? "not-allowed" : "pointer",
              opacity: isWorking ? 0.7 : 1,
            }}
          >
            {status === "connecting" ? "Connecting..." : "Start Voice Chat"}
          </button>
        ) : (
          <button
            type="button"
            onClick={stopVoiceChat}
            className="btn btn-coral"
            style={{
              cursor: "pointer",
            }}
          >
            Stop Voice Chat
          </button>
        )}

        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          {isConnected ? "Live" : "Not live"}
        </span>
      </div>

      {statusText && (
        <p style={{ marginTop: 10, marginBottom: 0 }}>{statusText}</p>
      )}

      {lastError && (
        <pre
          style={{
            marginTop: 10,
            whiteSpace: "pre-wrap",
            color: "#8a0000",
          }}
        >
          {lastError}
        </pre>
      )}

      <audio ref={remoteAudioRef} autoPlay />
    </div>
  );
}

/**
 * useTranscribeDictation — live speech-to-text for the chat input via Amazon
 * Transcribe streaming.
 *
 * The browser's Web Speech API was removed because it streams microphone audio
 * to Google's servers, which the OSD network blocks. Instead we:
 *   1. ask the backend for a short-lived presigned Transcribe WebSocket URL
 *      (no AWS credentials ever reach the browser),
 *   2. capture mic audio, downsample it to 16 kHz signed 16-bit PCM,
 *   3. wrap each chunk in AWS's event-stream binary framing and send it,
 *   4. decode TranscriptEvent frames and emit the running transcript.
 *
 * Audio goes browser → Transcribe directly; the backend only signs the URL.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { EventStreamMarshaller } from "@aws-sdk/eventstream-marshaller";
import { toUtf8, fromUtf8 } from "@aws-sdk/util-utf8";

const marshaller = new EventStreamMarshaller(toUtf8, fromUtf8);

export interface TranscribePresign {
  url: string;
  sampleRate: number;
  languageCode: string;
}

interface UseTranscribeDictationOptions {
  /** Fetches a fresh presigned Transcribe WebSocket URL from the backend. */
  getPresignedUrl: () => Promise<TranscribePresign>;
  /** Called with the full running transcript (finalized + in-flight partial). */
  onTranscript: (text: string) => void;
  /** Called with a user-facing message when dictation can't start or fails. */
  onError?: (message: string) => void;
}

/** Dictation works in any browser with mic capture + WebSockets (no Web Speech API needed). */
export function transcribeDictationSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof WebSocket !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    !!(window.AudioContext || (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext)
  );
}

/** Average-downsample a Float32 PCM buffer from inputRate to outputRate. */
function downsampleBuffer(
  buffer: Float32Array,
  inputRate: number,
  outputRate: number
): Float32Array {
  if (outputRate >= inputRate) return buffer;
  const ratio = inputRate / outputRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffset = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffset && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffset;
  }
  return result;
}

/** Float32 [-1,1] → signed 16-bit little-endian PCM (what Transcribe expects). */
function pcmEncode(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

/** Wrap a PCM chunk in an AWS event-stream AudioEvent frame. */
function encodeAudioEvent(pcm: ArrayBuffer): Uint8Array {
  return marshaller.marshall({
    headers: {
      ":message-type": { type: "string", value: "event" },
      ":event-type": { type: "string", value: "AudioEvent" },
      ":content-type": { type: "string", value: "application/octet-stream" },
    },
    body: new Uint8Array(pcm),
  });
}

export function useTranscribeDictation({
  getPresignedUrl,
  onTranscript,
  onError,
}: UseTranscribeDictationOptions) {
  const [listening, setListening] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const finalTextRef = useRef("");

  const cleanup = useCallback(() => {
    try { processorRef.current?.disconnect(); } catch { /* noop */ }
    try { sourceRef.current?.disconnect(); } catch { /* noop */ }
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    try {
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        audioContextRef.current.close();
      }
    } catch { /* noop */ }
    try {
      const ws = wsRef.current;
      if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
    } catch { /* noop */ }
    processorRef.current = null;
    sourceRef.current = null;
    streamRef.current = null;
    audioContextRef.current = null;
    wsRef.current = null;
    setListening(false);
  }, []);

  const stop = useCallback(() => {
    const ws = wsRef.current;
    // Empty audio frame signals end-of-stream so Transcribe finalizes cleanly.
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encodeAudioEvent(new ArrayBuffer(0)));
      }
    } catch { /* noop */ }
    cleanup();
  }, [cleanup]);

  const start = useCallback(async () => {
    if (wsRef.current) return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      onError?.(
        "Microphone access is blocked. Enable it for this site in your browser settings."
      );
      return;
    }

    let presign: TranscribePresign;
    try {
      presign = await getPresignedUrl();
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      onError?.("Couldn't start dictation. Please try again.");
      return;
    }

    finalTextRef.current = "";
    streamRef.current = stream;

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const audioContext = new AudioCtx();
    audioContextRef.current = audioContext;
    const source = audioContext.createMediaStreamSource(stream);
    sourceRef.current = source;
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;

    const ws = new WebSocket(presign.url);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      setListening(true);
      source.connect(processor);
      // Output stays silent (we never write outputBuffer); connecting to
      // destination is only needed so onaudioprocess fires reliably.
      processor.connect(audioContext.destination);
      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        const downsampled = downsampleBuffer(
          input,
          audioContext.sampleRate,
          presign.sampleRate
        );
        try {
          ws.send(encodeAudioEvent(pcmEncode(downsampled)));
        } catch { /* socket closing */ }
      };
    };

    ws.onmessage = (event) => {
      try {
        const wrapper = marshaller.unmarshall(new Uint8Array(event.data as ArrayBuffer));
        const messageType = wrapper.headers[":message-type"]?.value as string | undefined;
        const body = JSON.parse(toUtf8(wrapper.body as Uint8Array));
        if (messageType === "exception") {
          onError?.(body?.Message || "Dictation service error.");
          stop();
          return;
        }
        const results = body?.Transcript?.Results ?? [];
        let partial = "";
        for (const result of results) {
          const text: string = result?.Alternatives?.[0]?.Transcript ?? "";
          if (!text) continue;
          if (result.IsPartial) {
            partial = text;
          } else {
            finalTextRef.current =
              (finalTextRef.current ? finalTextRef.current + " " : "") + text;
          }
        }
        onTranscript((finalTextRef.current + " " + partial).trim());
      } catch {
        // Ignore frames we can't parse.
      }
    };

    ws.onerror = () => {
      onError?.("Dictation connection failed. Please try again.");
      cleanup();
    };
    ws.onclose = () => {
      cleanup();
    };
  }, [getPresignedUrl, onTranscript, onError, stop, cleanup]);

  const toggle = useCallback(() => {
    if (wsRef.current) stop();
    else void start();
  }, [start, stop]);

  // Tear everything down if the component unmounts mid-dictation.
  useEffect(() => cleanup, [cleanup]);

  return { listening, start, stop, toggle };
}

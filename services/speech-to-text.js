// services/speech-to-text.js

const WebSocket = require("ws");

function readTurnSetting(name, fallback, min, max, integer = false) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}`);
  }
  return String(value);
}

function createSpeechToTextStream({ onTranscript, onOpen, onClose, onError, keyterms = [] } = {}) {
  const apiKey = process.env.DEEPGRAM_API_KEY;

  if (!apiKey) {
    throw new Error("DEEPGRAM_API_KEY is missing from .env");
  }

  const params = new URLSearchParams({
    encoding: "mulaw",
    sample_rate: "8000",
    model: "flux-general-en",
    eot_threshold: readTurnSetting("DEEPGRAM_EOT_THRESHOLD", "0.7", 0.5, 1),
    eot_timeout_ms: readTurnSetting("DEEPGRAM_EOT_TIMEOUT_MS", "5000", 500, 60000, true),
  });

  const recognitionHints = [
    "website", "years", "months", "weeks", "postcode",
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    "today", "tomorrow", "morning", "afternoon",
    ...keyterms,
    ...(process.env.DEEPGRAM_KEYTERMS || "").split(","),
  ];
  const seenHints = new Set();
  for (const hint of recognitionHints) {
    const term = String(hint || "").replace(/\s+/g, " ").trim();
    if (term && !seenHints.has(term.toLowerCase())) {
      params.append("keyterm", term);
      seenHints.add(term.toLowerCase());
    }
  }

  const deepgramUrl = `wss://api.deepgram.com/v2/listen?${params.toString()}`;

  const deepgramSocket = new WebSocket(deepgramUrl, {
    headers: {
      Authorization: `Token ${apiKey}`,
    },
  });

  let isOpen = false;
  let isClosed = false;
  let lastCompletedTurnIndex = -1;
  const pendingAudio = [];
  let pendingAudioBytes = 0;
  let warnedAboutDroppedAudio = false;
  const maxPendingAudioBytes = 8000 * 5;
  // Flux recommends 80 ms frames: 640 bytes of Twilio's 8 kHz mono mu-law.
  const audioChunkBytes = 640;
  let audioRemainder = Buffer.alloc(0);

  function sendAudioChunks(audioBuffer) {
    const audio = Buffer.concat([audioRemainder, audioBuffer]);
    let offset = 0;
    while (offset + audioChunkBytes <= audio.length) {
      deepgramSocket.send(audio.subarray(offset, offset + audioChunkBytes));
      offset += audioChunkBytes;
    }
    audioRemainder = Buffer.from(audio.subarray(offset));
  }

  deepgramSocket.on("open", () => {
    if (isClosed) {
      deepgramSocket.close();
      return;
    }
    isOpen = true;
    console.log("Deepgram Flux speech-to-text connected");

    // Keep the start of an answer while the WebSocket handshake completes.
    for (const audioBuffer of pendingAudio) {
      sendAudioChunks(audioBuffer);
    }
    pendingAudio.length = 0;
    pendingAudioBytes = 0;

    if (onOpen) {
      onOpen();
    }
  });

  deepgramSocket.on("message", (message) => {
    if (isClosed) return;
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "Error") {
        const error = new Error(data.description || "Deepgram Flux returned an error");
        error.code = data.code;
        console.error("Deepgram Flux error:", error.code, error.message);
        if (onError) onError(error);
        return;
      }

      if (data.type !== "TurnInfo") return;

      const transcript = typeof data.transcript === "string" ? data.transcript : "";
      const speechFinal = data.event === "EndOfTurn";
      if (!transcript && !speechFinal && data.event !== "StartOfTurn") return;

      // Flux sends the entire turn on each update, not separate final segments.
      // EagerEndOfTurn and TurnResumed remain interim until EndOfTurn arrives.
      if (Number.isInteger(data.turn_index)) {
        if (data.turn_index <= lastCompletedTurnIndex) return;
        if (speechFinal) lastCompletedTurnIndex = data.turn_index;
      }

      if (onTranscript) {
        onTranscript({
          transcript,
          isFinal: speechFinal,
          speechFinal,
          utteranceEnd: speechFinal,
          raw: data,
        });
      }
    } catch (error) {
      console.error("Error reading Deepgram message:", error.message);
    }
  });

  deepgramSocket.on("error", (error) => {
    console.error("Deepgram WebSocket error:", error.message);

    if (onError) {
      onError(error);
    }
  });

  deepgramSocket.on("close", () => {
    isOpen = false;
    isClosed = true;
    pendingAudio.length = 0;
    pendingAudioBytes = 0;
    audioRemainder = Buffer.alloc(0);
    console.log("Deepgram Flux speech-to-text disconnected");

    if (onClose) {
      onClose();
    }
  });

  function sendAudio(audioBuffer) {
    if (isClosed) return;
    if (deepgramSocket.readyState === WebSocket.CONNECTING) {
      pendingAudio.push(audioBuffer);
      pendingAudioBytes += audioBuffer.length;
      while (pendingAudioBytes > maxPendingAudioBytes) {
        pendingAudioBytes -= pendingAudio.shift().length;
        if (!warnedAboutDroppedAudio) {
          warnedAboutDroppedAudio = true;
          console.warn("Deepgram connection delayed: startup audio buffer exceeded five seconds");
        }
      }
      return;
    }

    if (!isOpen) {
      return;
    }

    if (deepgramSocket.readyState !== WebSocket.OPEN) {
      return;
    }

    sendAudioChunks(audioBuffer);
  }

  function close() {
    if (isClosed) return;
    isClosed = true;
    isOpen = false;
    pendingAudio.length = 0;
    pendingAudioBytes = 0;
    if (deepgramSocket.readyState === WebSocket.OPEN && audioRemainder.length) {
      deepgramSocket.send(audioRemainder);
    }
    audioRemainder = Buffer.alloc(0);
    if (
      deepgramSocket.readyState === WebSocket.OPEN ||
      deepgramSocket.readyState === WebSocket.CONNECTING
    ) {
      deepgramSocket.close();
    }
  }

  return {
    sendAudio,
    close,
  };
}

module.exports = {
  createSpeechToTextStream,
};

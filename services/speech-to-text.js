// services/speech-to-text.js

const WebSocket = require("ws");

function createSpeechToTextStream({ onTranscript, onOpen, onClose, onError, keyterms = [] } = {}) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  const endpointingMs = String(process.env.DEEPGRAM_ENDPOINTING_MS || "600");
  const utteranceEndMs = String(process.env.DEEPGRAM_UTTERANCE_END_MS || "1000");

  if (!apiKey) {
    throw new Error("DEEPGRAM_API_KEY is missing from .env");
  }

  const params = new URLSearchParams({
    encoding: "mulaw",
    sample_rate: "8000",
    channels: "1",
    model: "nova-3",
    language: "en-GB",
    interim_results: "true",
    punctuate: "true",
    endpointing: endpointingMs,
    utterance_end_ms: utteranceEndMs,
  });

  const recognitionHints = [
    "website", "years", "months", "weeks", "postcode",
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

  const deepgramUrl = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

  const deepgramSocket = new WebSocket(deepgramUrl, {
    headers: {
      Authorization: `Token ${apiKey}`,
    },
  });

  let isOpen = false;
  const pendingAudio = [];
  let pendingAudioBytes = 0;
  let warnedAboutDroppedAudio = false;
  const maxPendingAudioBytes = 8000 * 5;

  deepgramSocket.on("open", () => {
    isOpen = true;
    console.log("Deepgram speech-to-text connected");

    // Keep the start of an answer while the WebSocket handshake completes.
    for (const audioBuffer of pendingAudio) {
      deepgramSocket.send(audioBuffer);
    }
    pendingAudio.length = 0;
    pendingAudioBytes = 0;

    if (onOpen) {
      onOpen();
    }
  });

  deepgramSocket.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "UtteranceEnd") {
        if (onTranscript) {
          onTranscript({
            transcript: "",
            isFinal: true,
            speechFinal: true,
            utteranceEnd: true,
            raw: data,
          });
        }

        return;
      }

      const transcript = data.channel?.alternatives?.[0]?.transcript || "";

      if (!transcript && data.speech_final !== true) {
        return;
      }

      const isFinal = data.is_final === true;
      const speechFinal = data.speech_final === true;

      if (onTranscript) {
        onTranscript({
          transcript,
          isFinal,
          speechFinal,
          utteranceEnd: false,
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
    pendingAudio.length = 0;
    pendingAudioBytes = 0;
    console.log("Deepgram speech-to-text disconnected");

    if (onClose) {
      onClose();
    }
  });

  function sendAudio(audioBuffer) {
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

    deepgramSocket.send(audioBuffer);
  }

  function close() {
    pendingAudio.length = 0;
    pendingAudioBytes = 0;
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

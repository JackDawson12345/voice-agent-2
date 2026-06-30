// services/speech-to-text.js

const WebSocket = require("ws");

function createSpeechToTextStream({ onTranscript, onOpen, onClose, onError } = {}) {
  const apiKey = process.env.DEEPGRAM_API_KEY;

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
    endpointing: "200",
    utterance_end_ms: "1000",
  });

  const deepgramUrl = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

  const deepgramSocket = new WebSocket(deepgramUrl, {
    headers: {
      Authorization: `Token ${apiKey}`,
    },
  });

  let isOpen = false;

  deepgramSocket.on("open", () => {
    isOpen = true;
    console.log("Deepgram speech-to-text connected");

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

      if (!transcript) {
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
    console.log("Deepgram speech-to-text disconnected");

    if (onClose) {
      onClose();
    }
  });

  function sendAudio(audioBuffer) {
    if (!isOpen) {
      return;
    }

    if (deepgramSocket.readyState !== WebSocket.OPEN) {
      return;
    }

    deepgramSocket.send(audioBuffer);
  }

  function close() {
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

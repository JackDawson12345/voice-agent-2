// server.js

// Load values from .env.
require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const {
  startOutboundCall,
  endOutboundCall,
} = require("./services/twilio");
const { createSpeechToTextStream } = require("./services/speech-to-text");
const { getAIResponse } = require("./services/ai-response");
const { textToSpeech } = require("./services/text-to-speech");

const {
  createSessionMemory,
  updateSessionMemoryFromTranscript,
  formatSessionMemoryForLog,
} = require("./services/session-memory");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const INTRO_MESSAGE =
  "Hello, this is Jack from Unitel Direct. I was just calling to ask a quick question about your website and online enquiries. Is now an okay time?";

app.get("/", (req, res) => {
  res.send("AI caller backend is running");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Backend is running",
  });
});

// Starts an outbound call.
// Example body:
// {
//   "to": "+447123456789"
// }
app.post("/start-call", async (req, res) => {
  try {
    const { to } = req.body;

    const call = await startOutboundCall(to);

    res.json({
      success: true,
      message: "Call started",
      callSid: call.sid,
    });
  } catch (error) {
    console.error("Call error:", error.message);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Twilio calls this when the customer answers.
// We do not use <Say> because the app handles the 2-second intro delay.
app.all("/voice", (req, res) => {
  const host = req.headers.host;

  const twiml = `
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>
  `.trim();

  res.type("text/xml");
  res.send(twiml);
});

// Sends generated mulaw/8000 audio back into the Twilio call.
function sendAudioToTwilio(ws, streamSid, audioBuffer, markName) {
  if (!streamSid) {
    console.log("Cannot send audio because streamSid is missing");
    return null;
  }

  if (!audioBuffer || !audioBuffer.length) {
    console.log("Cannot send audio because the audio buffer is empty");
    return null;
  }

  if (ws.readyState !== WebSocket.OPEN) {
    console.log("Cannot send audio because Twilio WebSocket is not open");
    return null;
  }

  const finalMarkName = markName || `ai-audio-${Date.now()}`;
  const payload = audioBuffer.toString("base64");

  ws.send(
    JSON.stringify({
      event: "media",
      streamSid,
      media: {
        payload,
      },
    })
  );

  ws.send(
    JSON.stringify({
      event: "mark",
      streamSid,
      mark: {
        name: finalMarkName,
      },
    })
  );

  console.log("AI audio sent to caller:", finalMarkName);

  return finalMarkName;
}

// Clears any audio Twilio has buffered, used when the customer interrupts.
function clearTwilioAudio(ws, streamSid) {
  if (!streamSid) {
    console.log("Cannot clear audio because streamSid is missing");
    return;
  }

  if (ws.readyState !== WebSocket.OPEN) {
    console.log("Cannot clear audio because Twilio WebSocket is not open");
    return;
  }

  ws.send(
    JSON.stringify({
      event: "clear",
      streamSid,
    })
  );

  console.log("Twilio audio buffer cleared");
}

const server = http.createServer(app);

const wss = new WebSocket.Server({
  server,
  path: "/media-stream",
});

wss.on("connection", (ws) => {
  console.log("Twilio media stream connected");

  let audioPacketCount = 0;

  let currentCallSid = null;
  let currentStreamSid = null;

  const conversationHistory = [];
  const sessionMemory = createSessionMemory();

  let aiIsThinking = false;
  let lastFinalTranscript = "";

  let customerHasSpoken = false;
  let introHasPlayed = false;
  let introTimer = null;

  // Barge-in state.
  let aiIsSpeaking = false;
  let activeAudioMark = null;
  let responseGenerationId = 0;
  let interruptionHappened = false;

  let pendingHangupAfterMark = null;
  let callIsEnding = false;

  // Barge-in debounce.
  // This prevents tiny bits of background noise from cutting the AI off.
  let pendingBargeInTimer = null;
  let pendingBargeInTranscript = "";

  function startIntroTimer() {
    if (introTimer) {
      return;
    }

    introTimer = setTimeout(async () => {
      try {
        introTimer = null;

        if (customerHasSpoken || introHasPlayed) {
          return;
        }

        if (!currentStreamSid) {
          console.log("Intro skipped because streamSid is missing");
          return;
        }

        if (ws.readyState !== WebSocket.OPEN) {
          console.log("Intro skipped because Twilio WebSocket is not open");
          return;
        }

        introHasPlayed = true;

        console.log("AI intro:", INTRO_MESSAGE);

        const thisResponseId = ++responseGenerationId;
        const introAudio = await textToSpeech(INTRO_MESSAGE);

        if (customerHasSpoken || thisResponseId !== responseGenerationId) {
          console.log("Intro cancelled before playback");
          return;
        }

        const introMarkName = `intro-audio-${Date.now()}`;

        activeAudioMark = introMarkName;
        aiIsSpeaking = true;
        interruptionHappened = false;

        sendAudioToTwilio(ws, currentStreamSid, introAudio, introMarkName);

        conversationHistory.push({
          role: "assistant",
          content: INTRO_MESSAGE,
        });
      } catch (error) {
        console.error("Intro speech error:", error.message);
      }
    }, 2000);
  }

  function clearIntroTimer() {
    if (introTimer) {
      clearTimeout(introTimer);
      introTimer = null;
    }
  }

  function transcriptSuggestsGoodbye(text) {
  const lower = String(text || "").toLowerCase();

  return (
    lower.includes("bye") ||
    lower.includes("goodbye") ||
    lower.includes("thanks bye") ||
    lower.includes("thank you bye") ||
    lower.includes("that is all") ||
    lower.includes("that's all") ||
    lower.includes("speak soon") ||
    lower.includes("talk soon")
  );
}

function isLeadComplete(memory) {
  return Boolean(
    memory.isInterested === "yes" &&
      memory.wantsCallback &&
      memory.callbackPhone &&
      memory.callbackTime
  );
}

function shouldEndCallAfterReply({ cleanTranscript, sessionMemory, aiReply }) {
  const lowerReply = String(aiReply || "").toLowerCase();

  if (sessionMemory.doNotCall) {
    return true;
  }

  if (transcriptSuggestsGoodbye(cleanTranscript)) {
    return true;
  }

  if (sessionMemory.isInterested === "no" && !sessionMemory.wantsCallback) {
    return true;
  }

  if (isLeadComplete(sessionMemory)) {
    const replySoundsFinal =
      lowerReply.includes("we'll call") ||
      lowerReply.includes("we will call") ||
      lowerReply.includes("call you") ||
      lowerReply.includes("thanks") ||
      lowerReply.includes("thank you") ||
      lowerReply.includes("goodbye") ||
      lowerReply.includes("bye");

    if (replySoundsFinal) {
      return true;
    }
  }

  return false;
}

async function endCallNow(reason) {
  try {
    if (callIsEnding) {
      return;
    }

    callIsEnding = true;

    console.log("Ending call:", reason);

    if (!currentCallSid) {
      console.log("Cannot end call because callSid is missing");
      return;
    }

    await endOutboundCall(currentCallSid);

    console.log("Call ended successfully");
  } catch (error) {
    console.error("Error ending call:", error.message);
  }
}

  async function createAndPlayAIReply(cleanTranscript) {
    if (aiIsThinking && !interruptionHappened) {
      console.log("AI is already responding, skipping overlapping transcript.");
      return;
    }

    if (aiIsThinking && interruptionHappened) {
      console.log("Customer interrupted, allowing new response after clearing audio.");
      aiIsThinking = false;
    }

    aiIsThinking = true;

    const thisResponseId = ++responseGenerationId;

    try {
      const aiReply = await getAIResponse({
        transcript: cleanTranscript,
        conversationHistory,
        sessionMemory,
      });

      if (!aiReply) {
        aiIsThinking = false;
        return;
      }

      if (thisResponseId !== responseGenerationId) {
        console.log("AI reply discarded because customer interrupted.");
        aiIsThinking = false;
        return;
      }

      console.log("AI replied:", aiReply);

      const aiAudio = await textToSpeech(aiReply);

      if (thisResponseId !== responseGenerationId) {
        console.log("AI audio discarded because customer interrupted.");
        aiIsThinking = false;
        return;
      }

      const markName = `ai-audio-${Date.now()}`;

      activeAudioMark = markName;
      aiIsSpeaking = true;
      interruptionHappened = false;

      const shouldHangUp = shouldEndCallAfterReply({
        cleanTranscript,
        sessionMemory,
        aiReply,
      });

      if (shouldHangUp) {
        pendingHangupAfterMark = markName;
        console.log("Call will end after AI finishes speaking:", markName);
      }

      sendAudioToTwilio(ws, currentStreamSid, aiAudio, markName);

      conversationHistory.push({
        role: "user",
        content: cleanTranscript,
      });

      conversationHistory.push({
        role: "assistant",
        content: aiReply,
      });

      if (conversationHistory.length > 10) {
        conversationHistory.splice(0, conversationHistory.length - 10);
      }

      aiIsThinking = false;
    } catch (error) {
      aiIsThinking = false;
      console.error("AI or text-to-speech error:", error.message);
    }
  }

  function clearPendingBargeInTimer() {
  if (pendingBargeInTimer) {
    clearTimeout(pendingBargeInTimer);
    pendingBargeInTimer = null;
  }

  pendingBargeInTranscript = "";
}

function looksLikeRealInterruption(text) {
  const cleanText = String(text || "").trim();

  if (!cleanText) {
    return false;
  }

  const words = cleanText.split(/\s+/).filter(Boolean);

  // Ignore very short noise-like fragments.
  const ignoredFragments = [
    "uh",
    "um",
    "er",
    "ah",
    "mm",
    "hm",
    "hmm",
    "noise",
  ];

  if (ignoredFragments.includes(cleanText.toLowerCase())) {
    return false;
  }

  // Strong interruptions.
  const strongPhrases = [
    "hello",
    "wait",
    "stop",
    "sorry",
    "actually",
    "no",
    "yes",
    "what",
    "how",
    "can",
    "could",
  ];

  if (strongPhrases.some((phrase) => cleanText.toLowerCase().startsWith(phrase))) {
    return true;
  }

  // Two or more words is likely intentional speech.
  if (words.length >= 2) {
    return true;
  }

  // One word can still be valid, but avoid very tiny fragments.
  if (cleanText.length >= 5) {
    return true;
  }

  return false;
}

function scheduleBargeIn(cleanTranscript) {
  if (!aiIsSpeaking) {
    return;
  }

  if (!looksLikeRealInterruption(cleanTranscript)) {
    return;
  }

  pendingBargeInTranscript = cleanTranscript;

  if (pendingBargeInTimer) {
    return;
  }

  // Wait briefly before clearing audio.
  // This makes interruption feel less harsh and filters out quick false starts.
  pendingBargeInTimer = setTimeout(() => {
    if (!aiIsSpeaking) {
      clearPendingBargeInTimer();
      return;
    }

    console.log("Customer interrupted AI:", pendingBargeInTranscript);

    interruptionHappened = true;
    aiIsSpeaking = false;
    activeAudioMark = null;

    // Invalidate current AI/TTS work.
    responseGenerationId++;

    clearTwilioAudio(ws, currentStreamSid);

    clearPendingBargeInTimer();
  }, 250);
}

  const speechToText = createSpeechToTextStream({
    onTranscript: async ({ transcript, isFinal, utteranceEnd }) => {
      try {
        if (utteranceEnd) {
          return;
        }

        const cleanTranscript = transcript.trim();

        // Barge-in: stop AI audio as soon as the customer starts speaking.
        if (cleanTranscript && aiIsSpeaking) {
          scheduleBargeIn(cleanTranscript);
        }

        if (cleanTranscript) {
          customerHasSpoken = true;
          clearIntroTimer();
        }

        if (!isFinal) {
          return;
        }

        if (!cleanTranscript) {
          return;
        }

        if (cleanTranscript === lastFinalTranscript) {
          return;
        }

        lastFinalTranscript = cleanTranscript;

        console.log("Customer said:", cleanTranscript);

        const memoryUpdate = updateSessionMemoryFromTranscript(
          sessionMemory,
          cleanTranscript
        );

        if (memoryUpdate.changedFields.length) {
          console.log("Session memory updated:", {
            changedFields: memoryUpdate.changedFields,
            memory: formatSessionMemoryForLog(sessionMemory),
          });
        }

        if (sessionMemory.doNotCall) {
          const doNotCallReply =
            "I understand. Sorry for disturbing you, we will not call again. Thank you, goodbye.";

          console.log("AI replied:", doNotCallReply);

          const doNotCallAudio = await textToSpeech(doNotCallReply);
          const markName = `ai-audio-${Date.now()}`;

          activeAudioMark = markName;
          aiIsSpeaking = true;
          pendingHangupAfterMark = markName;

          console.log("Call will end after do-not-call message:", markName);

          sendAudioToTwilio(ws, currentStreamSid, doNotCallAudio, markName);

          conversationHistory.push({
            role: "user",
            content: cleanTranscript,
          });

          conversationHistory.push({
            role: "assistant",
            content: doNotCallReply,
          });

          return;
        }

        await createAndPlayAIReply(cleanTranscript);
      } catch (error) {
        aiIsThinking = false;
        console.error("Transcript handling error:", error.message);
      }
    },
  });

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);

      if (data.event === "connected") {
        console.log("Media stream connected event received");
      }

      if (data.event === "start") {
        currentCallSid = data.start.callSid;
        currentStreamSid = data.start.streamSid;

        console.log("Media stream started:", {
          callSid: currentCallSid,
          streamSid: currentStreamSid,
        });

        startIntroTimer();
      }

      if (data.event === "mark") {
        const finishedMarkName = data.mark?.name;

        console.log("Twilio finished playing:", finishedMarkName);

        if (finishedMarkName && finishedMarkName === activeAudioMark) {
          aiIsSpeaking = false;
          activeAudioMark = null;
          clearPendingBargeInTimer();
        }

        if (finishedMarkName && finishedMarkName === pendingHangupAfterMark) {
          pendingHangupAfterMark = null;
          endCallNow("Final AI message finished playing");
        }
      }

      if (data.event === "media") {
        audioPacketCount++;

        const audioBuffer = Buffer.from(data.media.payload, "base64");

        speechToText.sendAudio(audioBuffer);
      }

      if (data.event === "stop") {
        clearIntroTimer();
        clearPendingBargeInTimer();
        speechToText.close();

        console.log("Final session memory:", formatSessionMemoryForLog(sessionMemory));

        console.log("Media stream stopped:", {
          callSid: currentCallSid,
          streamSid: currentStreamSid,
          totalAudioPackets: audioPacketCount,
        });
      }
    } catch (error) {
      console.error("Error reading media stream message:", error.message);
    }
  });

  ws.on("close", () => {
    clearIntroTimer();
    clearPendingBargeInTimer();
    speechToText.close();

    console.log("Twilio media stream disconnected", {
      callSid: currentCallSid,
      streamSid: currentStreamSid,
      totalAudioPackets: audioPacketCount,
    });
  });

  ws.on("error", (error) => {
    clearIntroTimer();
    clearPendingBargeInTimer();
    speechToText.close();

    console.error("WebSocket error:", error.message);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

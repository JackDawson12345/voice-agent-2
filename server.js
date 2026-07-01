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

const DEFAULT_RAILS_PUBLIC_URL =
  "https://riverboat-canyon-expensive.ngrok-free.dev";

const RAILS_PUBLIC_URL = (
  process.env.RAILS_PUBLIC_URL || DEFAULT_RAILS_PUBLIC_URL
).replace(/\/$/, "");

const DEFAULT_RAILS_CALLBACK_URL = `${RAILS_PUBLIC_URL}/node-call-results`;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const INTRO_MESSAGE =
  "Hello, this is Lily from Unitel Direct. I was just calling to ask a quick question about your website and online enquiries. Is now an okay time?";

// Stores Rails/Ruby context against the Twilio callSid.
// This lets the WebSocket part know which Rails phone_number record to update
// when Twilio later connects the media stream.
const callContexts = new Map();

async function postCallResultToRails(callbackUrl, payload) {
  if (!callbackUrl) {
    console.log("No Rails callback URL provided, skipping call result save.");
    return;
  }

  try {
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Callback-Secret": process.env.CALLBACK_SECRET || "",
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error("Rails callback failed:", {
        status: response.status,
        response: responseText,
      });
      return;
    }

    console.log("Rails callback successful:", responseText);
  } catch (error) {
    console.error("Rails callback error:", error.message);
  }
}

app.get("/", (req, res) => {
  res.send("AI caller backend is running");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Backend is running",
    railsCallbackUrl: DEFAULT_RAILS_CALLBACK_URL,
  });
});

// Starts an outbound call.
// Example body:
// {
//   "to": "+447123456789",
//   "phone_number_id": 1,
//   "callback_url": "https://your-rails-app-url/node-call-results"
// }
app.post("/start-call", async (req, res) => {
  try {
    const {
      to,
      phone_number_id,
      phoneNumberId,
      callback_url,
      callbackUrl,
    } = req.body;

    if (!to) {
      return res.status(400).json({
        success: false,
        error: "Missing phone number",
      });
    }

    const resolvedPhoneNumberId = phone_number_id || phoneNumberId || null;
    const resolvedCallbackUrl =
      callback_url || callbackUrl || DEFAULT_RAILS_CALLBACK_URL;

    const call = await startOutboundCall(to);

    callContexts.set(call.sid, {
      phoneNumberId: resolvedPhoneNumberId,
      callbackUrl: resolvedCallbackUrl,
      to,
      startedAt: new Date().toISOString(),
    });

    console.log("Call context stored:", {
      callSid: call.sid,
      phoneNumberId: resolvedPhoneNumberId,
      callbackUrl: resolvedCallbackUrl,
      to,
    });

    res.json({
      success: true,
      message: "Call started",
      callSid: call.sid,
      callbackUrl: resolvedCallbackUrl,
      phoneNumberId: resolvedPhoneNumberId,
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
  const fullTranscript = [];
  const sessionMemory = createSessionMemory();

  let callContext = null;
  let callResultSent = false;

  let aiIsThinking = false;
  let lastFinalTranscript = "";

  let customerHasSpoken = false;
  let introHasPlayed = false;
  let introTimer = null;

  // iPhone call screening state.
  let callScreeningReplySent = false;

  // Voicemail / answer machine state.
  let voicemailHandled = false;
  let pendingVoicemailTimer = null;

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

  function addTranscriptLine(role, content) {
    if (!content) {
      return;
    }

    fullTranscript.push({
      role,
      content,
      at: new Date().toISOString(),
    });
  }

  async function sendCallResultToRails(reason) {
    if (callResultSent) {
      return;
    }

    if (!currentCallSid) {
      console.log("Cannot send call result because callSid is missing");
      return;
    }

    callResultSent = true;

    const context = callContext || callContexts.get(currentCallSid);

    if (!context) {
      console.log("No call context found for call result:", currentCallSid);
      return;
    }

    const payload = {
      phone_number_id: context.phoneNumberId,
      to: context.to,
      call_sid: currentCallSid,
      stream_sid: currentStreamSid,
      reason,
      started_at: context.startedAt,
      ended_at: new Date().toISOString(),
      total_audio_packets: audioPacketCount,
      memory: sessionMemory,
      memory_log: formatSessionMemoryForLog(sessionMemory),
      transcript: fullTranscript,
      conversation_history: conversationHistory,
    };

    console.log("Sending call result to Rails:", {
      callbackUrl: context.callbackUrl,
      phoneNumberId: context.phoneNumberId,
      callSid: currentCallSid,
      transcriptLines: fullTranscript.length,
      reason,
    });

    await postCallResultToRails(context.callbackUrl, payload);

    callContexts.delete(currentCallSid);
  }

  function startIntroTimer() {
    if (introTimer) {
      return;
    }

    introTimer = setTimeout(async () => {
      try {
        introTimer = null;

        if (customerHasSpoken || introHasPlayed || voicemailHandled) {
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

        if (
          customerHasSpoken ||
          voicemailHandled ||
          thisResponseId !== responseGenerationId
        ) {
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

        addTranscriptLine("assistant", INTRO_MESSAGE);
      } catch (error) {
        console.error("Intro speech error:", error.message);
        addTranscriptLine("system", `Intro speech error: ${error.message}`);
        await endCallNow("Intro speech error");
      }
    }, 2000);
  }

  function clearIntroTimer() {
    if (introTimer) {
      clearTimeout(introTimer);
      introTimer = null;
    }
  }

  function isIphoneCallScreeningPrompt(text) {
    const lower = String(text || "").toLowerCase();

    return (
      lower.includes("record your name and reason") ||
      lower.includes("if you record your name") ||
      lower.includes("reason for calling") ||
      lower.includes("i'll see if this person is available") ||
      lower.includes("i will see if this person is available") ||
      lower.includes("see if this person is available")
    );
  }

  async function answerIphoneCallScreeningPrompt() {
    if (callScreeningReplySent) {
      return;
    }

    if (!currentStreamSid) {
      console.log("Cannot answer call screening because streamSid is missing");
      return;
    }

    callScreeningReplySent = true;
    customerHasSpoken = true;

    clearIntroTimer();

    const screeningReply =
      "Hi, this is Lily from Unitel Direct. I’m calling regarding a website package for local businesses.";

    console.log("AI replied to iPhone call screening:", screeningReply);

    addTranscriptLine("system", "iPhone call screening prompt detected");
    addTranscriptLine("assistant", screeningReply);

    const thisResponseId = ++responseGenerationId;
    const screeningAudio = await textToSpeech(screeningReply);

    if (thisResponseId !== responseGenerationId) {
      console.log("Call screening reply cancelled");
      return;
    }

    const markName = `call-screening-audio-${Date.now()}`;

    activeAudioMark = markName;
    aiIsSpeaking = true;
    interruptionHappened = false;

    sendAudioToTwilio(ws, currentStreamSid, screeningAudio, markName);

    conversationHistory.push({
      role: "assistant",
      content: screeningReply,
    });
  }

  function isVoicemailOrAnswerMachine(text) {
    const lower = String(text || "").toLowerCase();

    // Do not treat iPhone call screening as voicemail.
    if (isIphoneCallScreeningPrompt(lower)) {
      return false;
    }

    const voicemailPhrases = [
      "please leave a message",
      "leave a message after the tone",
      "leave your message after the tone",
      "after the tone",
      "after the beep",
      "record your message",
      "you have reached the voicemail",
      "you've reached the voicemail",
      "you have reached",
      "you've reached",
      "i am unable to take your call",
      "i'm unable to take your call",
      "i can't take your call",
      "i cannot take your call",
      "sorry i missed your call",
      "sorry we missed your call",
      "no one is available",
      "no one available",
      "the person you are calling is unavailable",
      "the person you're calling is unavailable",
      "is not available right now",
      "please leave your name and number",
      "leave your name and number",
      "mailbox",
      "voicemail box",
    ];

    return voicemailPhrases.some((phrase) => lower.includes(phrase));
  }

  function clearPendingVoicemailTimer() {
    if (pendingVoicemailTimer) {
      clearTimeout(pendingVoicemailTimer);
      pendingVoicemailTimer = null;
    }
  }

  async function leaveVoicemailAndHangUp(detectedTranscript) {
    if (voicemailHandled) {
      return;
    }

    if (!currentStreamSid) {
      console.log("Cannot leave voicemail because streamSid is missing");
      return;
    }

    voicemailHandled = true;
    customerHasSpoken = true;

    clearIntroTimer();
    clearPendingBargeInTimer();

    // If Lily's intro has already started playing, stop it.
    if (aiIsSpeaking) {
      clearTwilioAudio(ws, currentStreamSid);
      aiIsSpeaking = false;
      activeAudioMark = null;
    }

    // Invalidate any AI/TTS response currently being generated.
    responseGenerationId++;

    addTranscriptLine("system", `Voicemail detected: ${detectedTranscript}`);

    const voicemailMessage =
      "Hi, this is Lily from Unitel Direct. I was calling regarding a website and SEO package for local businesses. Please feel free to call Unitel Direct back when convenient. Thank you.";

    console.log("Leaving voicemail message:", voicemailMessage);

    addTranscriptLine("assistant", voicemailMessage);

    conversationHistory.push({
      role: "assistant",
      content: voicemailMessage,
    });

    const thisResponseId = ++responseGenerationId;

    // Small delay so Lily does not speak over the voicemail tone.
    pendingVoicemailTimer = setTimeout(async () => {
      try {
        pendingVoicemailTimer = null;

        if (thisResponseId !== responseGenerationId) {
          console.log("Voicemail message cancelled");
          return;
        }

        const voicemailAudio = await textToSpeech(voicemailMessage);

        if (thisResponseId !== responseGenerationId) {
          console.log("Voicemail audio cancelled");
          return;
        }

        const markName = `voicemail-audio-${Date.now()}`;

        activeAudioMark = markName;
        aiIsSpeaking = true;
        pendingHangupAfterMark = markName;

        console.log("Call will end after voicemail message:", markName);

        sendAudioToTwilio(ws, currentStreamSid, voicemailAudio, markName);
      } catch (error) {
        console.error("Voicemail handling error:", error.message);
        addTranscriptLine("system", `Voicemail handling error: ${error.message}`);
        await endCallNow("Voicemail handling error");
      }
    }, 1200);
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

      clearIntroTimer();
      clearPendingBargeInTimer();
      clearPendingVoicemailTimer();

      await endOutboundCall(currentCallSid);

      console.log("Call ended successfully");

      await sendCallResultToRails(reason);
    } catch (error) {
      console.error("Error ending call:", error.message);
      addTranscriptLine("system", `Error ending call: ${error.message}`);
      await sendCallResultToRails("Error ending call");
    }
  }

  async function createAndPlayAIReply(cleanTranscript) {
    if (voicemailHandled) {
      console.log("Skipping AI reply because voicemail has already been handled.");
      return;
    }

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

      if (voicemailHandled) {
        console.log("AI reply discarded because voicemail has been handled.");
        aiIsThinking = false;
        return;
      }

      console.log("AI replied:", aiReply);
      addTranscriptLine("assistant", aiReply);

      const aiAudio = await textToSpeech(aiReply);

      if (thisResponseId !== responseGenerationId) {
        console.log("AI audio discarded because customer interrupted.");
        aiIsThinking = false;
        return;
      }

      if (voicemailHandled) {
        console.log("AI audio discarded because voicemail has been handled.");
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
      addTranscriptLine("system", `AI or text-to-speech error: ${error.message}`);
      await endCallNow("AI or text-to-speech error");
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

    if (
      strongPhrases.some((phrase) =>
        cleanText.toLowerCase().startsWith(phrase)
      )
    ) {
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

    if (voicemailHandled) {
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

      if (voicemailHandled) {
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

        if (!cleanTranscript) {
          return;
        }

        // 1. iPhone call screening comes first.
        // This must not be treated as voicemail.
        if (isIphoneCallScreeningPrompt(cleanTranscript)) {
          await answerIphoneCallScreeningPrompt();
          return;
        }

        // 2. Voicemail / answer machine comes second.
        // This leaves one message, then hangs up.
        if (isVoicemailOrAnswerMachine(cleanTranscript)) {
          await leaveVoicemailAndHangUp(cleanTranscript);
          return;
        }

        // If voicemail is already being handled, ignore further speech.
        if (voicemailHandled) {
          return;
        }

        // 3. Normal barge-in behaviour.
        if (aiIsSpeaking) {
          scheduleBargeIn(cleanTranscript);
        }

        customerHasSpoken = true;
        clearIntroTimer();

        if (!isFinal) {
          return;
        }

        if (cleanTranscript === lastFinalTranscript) {
          return;
        }

        lastFinalTranscript = cleanTranscript;

        console.log("Customer said:", cleanTranscript);
        addTranscriptLine("customer", cleanTranscript);

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
          addTranscriptLine("assistant", doNotCallReply);

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
        addTranscriptLine("system", `Transcript handling error: ${error.message}`);
        await endCallNow("Transcript handling error");
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
        callContext = callContexts.get(currentCallSid) || null;

        console.log("Media stream started:", {
          callSid: currentCallSid,
          streamSid: currentStreamSid,
          hasCallContext: Boolean(callContext),
          phoneNumberId: callContext?.phoneNumberId || null,
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

          if (voicemailHandled) {
            endCallNow("Voicemail message finished playing");
          } else {
            endCallNow("Final AI message finished playing");
          }
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
        clearPendingVoicemailTimer();
        speechToText.close();

        console.log("Final session memory:", formatSessionMemoryForLog(sessionMemory));

        console.log("Media stream stopped:", {
          callSid: currentCallSid,
          streamSid: currentStreamSid,
          totalAudioPackets: audioPacketCount,
        });

        sendCallResultToRails("Twilio media stream stopped");
      }
    } catch (error) {
      console.error("Error reading media stream message:", error.message);
      addTranscriptLine("system", `Error reading media stream message: ${error.message}`);
      sendCallResultToRails("Error reading media stream message");
    }
  });

  ws.on("close", () => {
    clearIntroTimer();
    clearPendingBargeInTimer();
    clearPendingVoicemailTimer();
    speechToText.close();

    console.log("Twilio media stream disconnected", {
      callSid: currentCallSid,
      streamSid: currentStreamSid,
      totalAudioPackets: audioPacketCount,
    });

    sendCallResultToRails("Twilio media stream disconnected");
  });

  ws.on("error", (error) => {
    clearIntroTimer();
    clearPendingBargeInTimer();
    clearPendingVoicemailTimer();
    speechToText.close();

    console.error("WebSocket error:", error.message);
    addTranscriptLine("system", `WebSocket error: ${error.message}`);
    sendCallResultToRails("WebSocket error");
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
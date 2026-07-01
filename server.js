// server.js

require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const twilio = require("twilio");

const twilioService = require("./services/twilio");
const { createSpeechToTextStream } = require("./services/speech-to-text");
const { textToSpeech } = require("./services/text-to-speech");
const { getAIResponse } = require("./services/ai-response");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/media-stream" });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  APP_PUBLIC_URL,
  RAILS_CALLBACK_URL,
} = process.env;

const twilioClient =
  typeof twilioService.getTwilioClient === "function"
    ? twilioService.getTwilioClient()
    : twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const startOutboundCall =
  twilioService.startOutboundCall ||
  twilioService.startCall ||
  null;

const endTwilioCall =
  twilioService.endCall ||
  async function fallbackEndCall(callSid) {
    if (!callSid) return;

    await twilioClient.calls(callSid).update({
      status: "completed",
    });
  };

// Timings
const INTRO_DELAY_MS = Number(process.env.INTRO_DELAY_MS || 2000);
const SILENCE_TIMEOUT_MS = Number(process.env.SILENCE_TIMEOUT_MS || 8000);
const MAX_SILENCE_CHECKS = Number(process.env.MAX_SILENCE_CHECKS || 1);

// Voice messages
const INTRO_MESSAGE =
  process.env.INTRO_MESSAGE ||
  "Hello, this is Lily from Unitel Direct. I am calling about a quick website package that helps local businesses get found online and generate more enquiries.";

const SILENCE_CHECK_MESSAGE =
  process.env.SILENCE_CHECK_MESSAGE ||
  "Hello, are you still there?";

const IPHONE_SCREENING_MESSAGE =
  process.env.IPHONE_SCREENING_MESSAGE ||
  "Hi, this is Lily from Unitel Direct calling regarding a website package.";

const VOICEMAIL_MESSAGE =
  process.env.VOICEMAIL_MESSAGE ||
  "Hi, this is Lily from Unitel Direct. I was just calling about a website package that helps local businesses get found online and generate more enquiries. We will try again another time. Thank you.";

const sessions = new Map();

function normaliseText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getPublicHost(req) {
  if (APP_PUBLIC_URL) {
    return APP_PUBLIC_URL.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  return req.headers.host;
}

function isOpenSocket(ws) {
  return ws && ws.readyState === WebSocket.OPEN;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function createSession(ws) {
  return {
    ws,

    callSid: null,
    streamSid: null,
    phoneNumberId: null,

    sttStream: null,

    introTimer: null,
    silenceTimer: null,

    silenceChecks: 0,
    hasPlayedIntro: false,
    hasCustomerSpoken: false,
    hasHandledIphoneScreening: false,
    hasHandledVoicemail: false,

    isAiSpeaking: false,
    isCustomerSpeaking: false,
    isProcessingAi: false,
    callEnded: false,

    markCounter: 0,
    activeMarkName: null,
    markActions: new Map(),

    pendingTranscript: "",

    transcript: [],
    memory: {},
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
  };
}

function clearIntroTimer(session) {
  if (session.introTimer) {
    clearTimeout(session.introTimer);
    session.introTimer = null;
  }
}

function clearSilenceTimer(session) {
  if (session.silenceTimer) {
    clearTimeout(session.silenceTimer);
    session.silenceTimer = null;
  }
}

function clearAllTimers(session) {
  clearIntroTimer(session);
  clearSilenceTimer(session);
}

function sendTwilioClear(session) {
  if (!isOpenSocket(session.ws)) return;
  if (!session.streamSid) return;

  session.ws.send(
    JSON.stringify({
      event: "clear",
      streamSid: session.streamSid,
    })
  );
}

function stopAiAudioForBargeIn(session) {
  if (!session.isAiSpeaking) return;

  console.log("Customer interrupted Lily. Clearing current audio.");

  sendTwilioClear(session);

  session.isAiSpeaking = false;
  session.activeMarkName = null;
  session.markActions.clear();
}

function startIntroTimer(session) {
  clearIntroTimer(session);

  session.introTimer = setTimeout(async () => {
    if (session.callEnded) return;
    if (session.hasCustomerSpoken) return;
    if (session.hasPlayedIntro) return;
    if (!session.streamSid) return;

    session.hasPlayedIntro = true;

    await speakToCustomer(session, INTRO_MESSAGE, {
      reason: "intro",
      startSilenceAfter: true,
    });
  }, INTRO_DELAY_MS);
}

function startSilenceTimer(session) {
  clearSilenceTimer(session);

  if (session.callEnded) return;
  if (session.isAiSpeaking) return;
  if (!session.streamSid) return;

  session.silenceTimer = setTimeout(async () => {
    await handleSilenceTimeout(session);
  }, SILENCE_TIMEOUT_MS);
}

async function handleSilenceTimeout(session) {
  if (session.callEnded) return;
  if (session.isAiSpeaking) return;

  session.silenceChecks += 1;

  if (session.silenceChecks <= MAX_SILENCE_CHECKS) {
    await speakToCustomer(session, SILENCE_CHECK_MESSAGE, {
      reason: "silence_check",
      startSilenceAfter: true,
    });

    return;
  }

  await endCall(session, "Customer silent after check-in");
}

function extractTranscriptFromDeepgram(data) {
  if (!data) {
    return {
      transcript: "",
      isFinal: false,
      speechFinal: false,
      type: "",
    };
  }

  if (typeof data === "string") {
    return {
      transcript: data,
      isFinal: true,
      speechFinal: true,
      type: "",
    };
  }

  const transcript =
    data.transcript ||
    data.channel?.alternatives?.[0]?.transcript ||
    "";

  return {
    transcript,
    isFinal: Boolean(data.is_final || data.isFinal),
    speechFinal: Boolean(data.speech_final || data.speechFinal),
    type: data.type || "",
  };
}

function isIphoneScreeningPrompt(transcript) {
  const text = normaliseText(transcript);

  if (!text) return false;

  return (
    text.includes("record your name") ||
    text.includes("reason for calling") ||
    text.includes("i'll see if") ||
    text.includes("ill see if") ||
    text.includes("this person is available") ||
    text.includes("the person you are calling may")
  );
}

function isVoicemailPrompt(transcript) {
  const text = normaliseText(transcript);

  if (!text) return false;

  // Important: do not treat iPhone call screening as voicemail.
  if (isIphoneScreeningPrompt(transcript)) return false;

  return (
    text.includes("leave a message") ||
    text.includes("leave your message") ||
    text.includes("after the tone") ||
    text.includes("after the beep") ||
    text.includes("mailbox") ||
    text.includes("voicemail") ||
    text.includes("not available") ||
    text.includes("unable to take your call") ||
    text.includes("can't take your call") ||
    text.includes("cant take your call") ||
    text.includes("please leave") ||
    text.includes("record your message")
  );
}

function shouldEndAfterAiText(text) {
  const value = normaliseText(text);

  if (!value) return false;

  return (
    value.includes("goodbye") ||
    value.includes("bye for now") ||
    value.includes("have a good day") ||
    value.includes("have a lovely day") ||
    value.includes("thanks for your time") ||
    value.includes("thank you for your time") ||
    value.includes("we will call you back") ||
    value.includes("someone from the team will call you back")
  );
}

function normaliseAiResponse(response) {
  if (!response) {
    return {
      text: "",
      shouldEndCall: false,
    };
  }

  if (typeof response === "string") {
    return {
      text: response,
      shouldEndCall: shouldEndAfterAiText(response),
    };
  }

  const text =
    response.text ||
    response.reply ||
    response.message ||
    response.content ||
    "";

  return {
    text,
    shouldEndCall: Boolean(response.shouldEndCall || response.endCall),
  };
}

function addTranscript(session, speaker, text) {
  const cleanText = String(text || "").trim();

  if (!cleanText) return;

  session.transcript.push({
    speaker,
    text: cleanText,
    at: new Date().toISOString(),
  });
}

async function speakToCustomer(session, text, options = {}) {
  if (session.callEnded) return;
  if (!text || !String(text).trim()) return;
  if (!isOpenSocket(session.ws)) return;
  if (!session.streamSid) return;

  clearSilenceTimer(session);

  const {
    reason = "ai",
    endAfter = false,
    startSilenceAfter = true,
  } = options;

  session.isAiSpeaking = true;
  session.markCounter += 1;

  const markName = `${reason}_${session.markCounter}`;

  session.activeMarkName = markName;
  session.markActions.set(markName, {
    endAfter,
    startSilenceAfter,
  });

  addTranscript(session, "Lily", text);

  console.log("AI replied:", text);

  let audioPayload;

  try {
    audioPayload = await textToSpeech(text);
  } catch (error) {
    console.error("Text-to-speech error:", error.message);
    await endCall(session, "Text-to-speech failed");
    return;
  }

  if (session.callEnded) return;
  if (!isOpenSocket(session.ws)) return;

  session.ws.send(
    JSON.stringify({
      event: "media",
      streamSid: session.streamSid,
      media: {
        payload: audioPayload,
      },
    })
  );

  session.ws.send(
    JSON.stringify({
      event: "mark",
      streamSid: session.streamSid,
      mark: {
        name: markName,
      },
    })
  );
}

async function endCall(session, reason = "Call ended") {
  if (!session || session.callEnded) return;

  session.callEnded = true;
  session.endedAt = new Date().toISOString();
  session.endReason = reason;

  clearAllTimers(session);

  console.log("Ending call:", reason);

  try {
    if (session.sttStream && typeof session.sttStream.close === "function") {
      session.sttStream.close();
    } else if (session.sttStream && typeof session.sttStream.finish === "function") {
      session.sttStream.finish();
    }
  } catch (error) {
    console.error("Failed to close speech-to-text stream:", error.message);
  }

  try {
    if (session.callSid) {
      await endTwilioCall(session.callSid);
    }
  } catch (error) {
    console.error("Failed to end Twilio call:", error.message);
  }

  await sendResultToRails(session);
}

async function sendResultToRails(session) {
  if (!RAILS_CALLBACK_URL) return;

  try {
    const payload = {
      call_sid: session.callSid,
      phone_number_id: session.phoneNumberId,
      started_at: session.startedAt,
      ended_at: session.endedAt,
      end_reason: session.endReason,
      transcript: session.transcript,
      memory: session.memory,
      call_result: {
        transcript: session.transcript,
        end_reason: session.endReason,
      },
    };

    const response = await fetch(RAILS_CALLBACK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error("Rails callback failed:", response.status, body);
      return;
    }

    console.log("Call result sent to Rails");
  } catch (error) {
    console.error("Rails callback error:", error.message);
  }
}

async function handleCustomerStartedSpeaking(session) {
  if (session.callEnded) return;

  session.hasCustomerSpoken = true;
  session.isCustomerSpeaking = true;

  clearIntroTimer(session);
  clearSilenceTimer(session);

  stopAiAudioForBargeIn(session);
}

async function handleCustomerTranscript(session, transcript, rawData = null) {
  const cleanTranscript = String(transcript || "").trim();

  if (!cleanTranscript) return;
  if (session.callEnded) return;

  await handleCustomerStartedSpeaking(session);

  session.isCustomerSpeaking = false;
  session.silenceChecks = 0;

  addTranscript(session, "Customer", cleanTranscript);

  console.log("Customer said:", cleanTranscript);

  if (isIphoneScreeningPrompt(cleanTranscript) && !session.hasHandledIphoneScreening) {
    session.hasHandledIphoneScreening = true;
    session.hasPlayedIntro = true;

    await speakToCustomer(session, IPHONE_SCREENING_MESSAGE, {
      reason: "iphone_screening",
      startSilenceAfter: true,
    });

    return;
  }

  if (isVoicemailPrompt(cleanTranscript) && !session.hasHandledVoicemail) {
    session.hasHandledVoicemail = true;

    await speakToCustomer(session, VOICEMAIL_MESSAGE, {
      reason: "voicemail",
      endAfter: true,
      startSilenceAfter: false,
    });

    return;
  }

  if (!session.hasPlayedIntro) {
    session.hasPlayedIntro = true;

    await speakToCustomer(session, INTRO_MESSAGE, {
      reason: "intro_after_customer",
      startSilenceAfter: true,
    });

    return;
  }

  await processAIResponse(session, cleanTranscript, rawData);
}

async function processAIResponse(session, transcript, rawData = null) {
  if (session.callEnded) return;

  if (session.isProcessingAi) {
    session.pendingTranscript = session.pendingTranscript
      ? `${session.pendingTranscript} ${transcript}`
      : transcript;

    return;
  }

  session.isProcessingAi = true;

  try {
    const response = await getAIResponse(transcript, {
      callSid: session.callSid,
      phoneNumberId: session.phoneNumberId,
      transcript: session.transcript,
      memory: session.memory,
      rawData,
    });

    const ai = normaliseAiResponse(response);

    if (!ai.text) {
      await speakToCustomer(session, "Sorry, I did not quite catch that.", {
        reason: "fallback",
        startSilenceAfter: true,
      });

      return;
    }

    await speakToCustomer(session, ai.text, {
      reason: "ai",
      endAfter: ai.shouldEndCall || shouldEndAfterAiText(ai.text),
      startSilenceAfter: true,
    });
  } catch (error) {
    console.error("AI response error:", error.message);

    await speakToCustomer(
      session,
      "Sorry, I am having a little trouble hearing you clearly. We can try again another time.",
      {
        reason: "ai_error",
        endAfter: true,
        startSilenceAfter: false,
      }
    );
  } finally {
    session.isProcessingAi = false;

    if (session.pendingTranscript && !session.callEnded) {
      const nextTranscript = session.pendingTranscript;
      session.pendingTranscript = "";

      await processAIResponse(session, nextTranscript);
    }
  }
}

function createSpeechStreamForSession(session) {
  try {
    const sttStream = createSpeechToTextStream({
      onOpen: () => {
        console.log("Deepgram speech-to-text connected");
      },

      onSpeechStarted: async () => {
        await handleCustomerStartedSpeaking(session);
      },

      onTranscript: async (message) => {
        const parsed = extractTranscriptFromDeepgram(message);

        if (parsed.type === "SpeechStarted") {
          await handleCustomerStartedSpeaking(session);
          return;
        }

        if (!parsed.transcript) return;

        if (parsed.isFinal || parsed.speechFinal) {
          await handleCustomerTranscript(session, parsed.transcript, message);
        }
      },

      onError: (error) => {
        console.error("Speech-to-text error:", error.message || error);
      },

      onClose: () => {
        console.log("Deepgram speech-to-text closed");
      },
    });

    return sttStream;
  } catch (error) {
    console.error("Failed to create speech-to-text stream:", error.message);
    return null;
  }
}

function sendAudioToSpeechStream(session, payload) {
  if (!session.sttStream) return;
  if (!payload) return;

  const audioBuffer = Buffer.from(payload, "base64");

  try {
    if (typeof session.sttStream.send === "function") {
      session.sttStream.send(audioBuffer);
      return;
    }

    if (typeof session.sttStream.write === "function") {
      session.sttStream.write(audioBuffer);
      return;
    }

    if (typeof session.sttStream.sendAudio === "function") {
      session.sttStream.sendAudio(audioBuffer);
      return;
    }

    console.error("Speech-to-text stream does not support send, write or sendAudio");
  } catch (error) {
    console.error("Failed to send audio to speech-to-text:", error.message);
  }
}

// Health check
app.get("/", (req, res) => {
  res.status(200).send("Voice agent server running");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "voice-agent",
  });
});

// Rails can call this route to start a call.
app.post("/start-call", async (req, res) => {
  try {
    const to =
      req.body.to ||
      req.body.phone_number ||
      req.body.phoneNumber ||
      req.body.number;

    const phoneNumberId =
      req.body.phone_number_id ||
      req.body.phoneNumberId ||
      req.body.id ||
      null;

    if (!to) {
      return res.status(400).json({
        ok: false,
        error: "Missing phone number",
      });
    }

    if (!startOutboundCall) {
      return res.status(500).json({
        ok: false,
        error: "No outbound call function found in services/twilio.js",
      });
    }

    const call = await startOutboundCall(to, {
      phoneNumberId,
    });

    res.status(200).json({
      ok: true,
      call_sid: call.sid,
      phone_number_id: phoneNumberId,
    });
  } catch (error) {
    console.error("Start call error:", error.message);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

// Twilio webhook for the live call.
app.post("/voice", (req, res) => {
  const host = getPublicHost(req);
  const streamUrl = `wss://${host}/media-stream`;

  const response = new twilio.twiml.VoiceResponse();

  const connect = response.connect();
  connect.stream({
    url: streamUrl,
  });

  res.type("text/xml");
  res.send(response.toString());
});

// Optional Twilio status callback endpoint.
app.post("/call-status", (req, res) => {
  console.log("Twilio call status:", req.body);

  res.status(200).json({
    ok: true,
  });
});

wss.on("connection", (ws) => {
  console.log("Twilio media stream connected");

  const session = createSession(ws);

  ws.on("message", async (rawMessage) => {
    const data = safeJsonParse(rawMessage);

    if (!data) {
      console.error("Invalid WebSocket message");
      return;
    }

    if (session.callEnded) return;

    switch (data.event) {
      case "connected": {
        console.log("Media stream connected event received");
        break;
      }

      case "start": {
        session.callSid = data.start?.callSid || null;
        session.streamSid = data.start?.streamSid || null;

        const customParameters = data.start?.customParameters || {};

        session.phoneNumberId =
          customParameters.phone_number_id ||
          customParameters.phoneNumberId ||
          null;

        if (session.callSid) {
          sessions.set(session.callSid, session);
        }

        console.log("Media stream started:", {
          callSid: session.callSid,
          streamSid: session.streamSid,
          phoneNumberId: session.phoneNumberId,
        });

        session.sttStream = createSpeechStreamForSession(session);

        startIntroTimer(session);

        break;
      }

      case "media": {
        const payload = data.media?.payload;

        if (!payload) return;

        sendAudioToSpeechStream(session, payload);

        break;
      }

      case "mark": {
        const markName = data.mark?.name;

        if (!markName) return;

        const action = session.markActions.get(markName);

        if (!action) {
          return;
        }

        session.markActions.delete(markName);

        if (session.activeMarkName === markName) {
          session.activeMarkName = null;
        }

        session.isAiSpeaking = false;

        console.log("Twilio mark received:", markName);

        if (action.endAfter) {
          await endCall(session, `Ended after ${markName}`);
          return;
        }

        if (action.startSilenceAfter) {
          startSilenceTimer(session);
        }

        break;
      }

      case "stop": {
        console.log("Twilio media stream stopped");

        await endCall(session, "Twilio stream stopped");

        break;
      }

      default: {
        break;
      }
    }
  });

  ws.on("close", async () => {
    console.log("Twilio media stream closed");

    if (!session.callEnded) {
      await endCall(session, "WebSocket closed");
    }

    if (session.callSid) {
      sessions.delete(session.callSid);
    }
  });

  ws.on("error", async (error) => {
    console.error("WebSocket error:", error.message);

    if (!session.callEnded) {
      await endCall(session, "WebSocket error");
    }

    if (session.callSid) {
      sessions.delete(session.callSid);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
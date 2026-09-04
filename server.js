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
  buildCallbackConfirmationMessage,
  buildFinancialAuthorityClarifier,
  buildIntroMessage,
  callbackConsentQuestion,
  formatCustomerAddress,
  getScriptedNextQuestion,
  hasCallbackSlot,
  hasSurveyAnswers,
  normaliseCallProfile,
} = require("./services/survey-script");

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

const AGENT_NAME = process.env.AGENT_NAME || "Lily";
const CLIENT_COMPANY_NAME = process.env.CLIENT_COMPANY_NAME || "118 Online";

const INTRO_MESSAGE =
  process.env.INTRO_MESSAGE ||
  buildIntroMessage({
    agentName: AGENT_NAME,
    companyName: CLIENT_COMPANY_NAME,
  });

const SILENCE_CHECK_MESSAGE =
  process.env.SILENCE_CHECK_MESSAGE || "Hello, are you still there?";

const INTRO_DELAY_MS = Number(process.env.INTRO_DELAY_MS || 700);
const SILENCE_TIMEOUT_MS = Number(process.env.SILENCE_TIMEOUT_MS || 8000);
const MAX_SILENCE_CHECKS = Number(process.env.MAX_SILENCE_CHECKS || 1);
const BARGE_IN_DEBOUNCE_MS = Number(process.env.BARGE_IN_DEBOUNCE_MS || 250);

// Safety net for final messages (do-not-call, voicemail, callback
// confirmation). If Twilio's "mark" event for that audio never arrives -
// which happens if the customer barges in and the buffer gets cleared -
// this makes sure the call still ends instead of hanging open indefinitely.
const HANGUP_FALLBACK_DELAY_MS = Number(process.env.HANGUP_FALLBACK_DELAY_MS || 6000);

// Live transfer removed. Callback flow only.
const ENABLE_CALLBACK_FLOW = true;
const CALL_SCREENING_MESSAGE =
  process.env.CALL_SCREENING_MESSAGE ||
  `Hi, my name is ${AGENT_NAME} calling on behalf of ${CLIENT_COMPANY_NAME} regarding the business and online visibility.`;
const VOICEMAIL_MESSAGE =
  process.env.VOICEMAIL_MESSAGE ||
  `Hi, my name is ${AGENT_NAME} calling on behalf of ${CLIENT_COMPANY_NAME} regarding your business and online visibility. Please give us a call back when convenient. Thank you.`;

function xmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normaliseCallbackUrl(url) {
  return String(url || "").replace(/([^:]\/)\/+/g, "$1");
}

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
    silenceTimeoutMs: SILENCE_TIMEOUT_MS,
    callbackFlowEnabled: ENABLE_CALLBACK_FLOW,
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
    const { to, callback_url, callbackUrl } = req.body;

    if (!to) {
      return res.status(400).json({
        success: false,
        error: "Missing phone number",
      });
    }

    const callProfile = normaliseCallProfile(req.body);
    const resolvedPhoneNumberId = callProfile.phoneNumberId || null;
    const resolvedCallbackUrl = normaliseCallbackUrl(
      callback_url || callbackUrl || DEFAULT_RAILS_CALLBACK_URL
    );

    const call = await startOutboundCall(to);

    callContexts.set(call.sid, {
      phoneNumberId: resolvedPhoneNumberId,
      callbackUrl: resolvedCallbackUrl,
      to,
      startedAt: new Date().toISOString(),
      callProfile,
    });

    console.log("Call context stored:", {
      callSid: call.sid,
      phoneNumberId: resolvedPhoneNumberId,
      callbackUrl: resolvedCallbackUrl,
      to,
      businessName: callProfile.customer.businessName || null,
    });

    res.json({
      success: true,
      message: "Call started",
      callSid: call.sid,
      callbackUrl: resolvedCallbackUrl,
      phoneNumberId: resolvedPhoneNumberId,
      callProfile,
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
// We do not use <Say> because the app handles the intro delay.
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
  let lastFinalTranscriptAt = 0;

  let customerHasSpoken = false;
  let introHasPlayed = false;
  let introTimer = null;

  // Silence timeout state.
  let silenceTimer = null;
  let silenceCheckCount = 0;
  const silenceWatchMarks = new Set();

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
  let pendingHangupFallbackTimer = null;
  let callEndReason = null;
  let callIsEnding = false;

  // Barge-in debounce.
  // This prevents tiny bits of background noise from cutting the AI off.
  let pendingBargeInTimer = null;
  let pendingBargeInTranscript = "";
  const pendingCustomerSegments = [];

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

  function normaliseTranscriptText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function resetPendingCustomerUtterance() {
    pendingCustomerSegments.length = 0;
  }

  function storePendingCustomerSegment(transcript, raw) {
    const cleanTranscript = normaliseTranscriptText(transcript);

    if (!cleanTranscript) {
      return;
    }

    const start = Number(raw?.start);
    const duration = Number(raw?.duration);
    const segmentKey = Number.isFinite(start)
      ? start.toFixed(3)
      : `segment-${pendingCustomerSegments.length}`;
    const segment = {
      key: segmentKey,
      start: Number.isFinite(start) ? start : pendingCustomerSegments.length,
      end:
        Number.isFinite(start) && Number.isFinite(duration)
          ? start + duration
          : null,
      transcript: cleanTranscript,
    };

    const existingIndex = pendingCustomerSegments.findIndex(
      (entry) => entry.key === segmentKey
    );

    if (existingIndex >= 0) {
      pendingCustomerSegments[existingIndex] = segment;
      return;
    }

    pendingCustomerSegments.push(segment);
  }

  function takePendingCustomerUtterance(fallbackTranscript = "") {
    const joinedTranscript = pendingCustomerSegments
      .slice()
      .sort((left, right) => left.start - right.start)
      .map((segment) => segment.transcript)
      .filter(Boolean)
      .join(" ");

    const combinedTranscript = normaliseTranscriptText(joinedTranscript);
    const fallback = normaliseTranscriptText(fallbackTranscript);

    resetPendingCustomerUtterance();

    if (!combinedTranscript) {
      return fallback;
    }

    if (!fallback) {
      return combinedTranscript;
    }

    const combinedLower = combinedTranscript.toLowerCase();
    const fallbackLower = fallback.toLowerCase();

    if (
      combinedLower === fallbackLower ||
      combinedLower.includes(fallbackLower) ||
      combinedLower.endsWith(` ${fallbackLower}`)
    ) {
      return combinedTranscript;
    }

    return normaliseTranscriptText(`${combinedTranscript} ${fallback}`);
  }

  function getCurrentCallProfile() {
    if (callContext?.callProfile) {
      return callContext.callProfile;
    }

    return normaliseCallProfile({
      phoneNumberId: callContext?.phoneNumberId || null,
      to: callContext?.to || "",
    });
  }

  function qualificationReadyForConsent(memory) {
    return Boolean(
      memory.isDecisionMaker === "yes" &&
        memory.addressConfirmed &&
        memory.businessDetailsConfirmed &&
        memory.contactName &&
        hasSurveyAnswers(memory)
    );
  }

  function determineCallOutcome(reason) {
    if (sessionMemory.doNotCall) {
      return "Do not call";
    }

    if (sessionMemory.callbackConfirmed || hasCallbackSlot(sessionMemory)) {
      return "Callback booked";
    }

    if (sessionMemory.notInterested) {
      return "Not interested";
    }

    if (sessionMemory.wrongNumber || sessionMemory.correctBusinessConfirmed === "no") {
      return "Wrong number";
    }

    if (sessionMemory.isDecisionMaker === "yes" && hasSurveyAnswers(sessionMemory)) {
      return "Survey completed";
    }

    if (sessionMemory.isDecisionMaker === "no") {
      return "Decision maker unavailable";
    }

    if (
      voicemailHandled ||
      !customerHasSpoken ||
      /voicemail|disconnected|stopped/i.test(String(reason || ""))
    ) {
      return "Unable to contact";
    }

    return "Unable to contact";
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
    const outcome = determineCallOutcome(reason);

    if (!context) {
      console.log("No call context found for call result:", currentCallSid);
      return;
    }

    const profile = context.callProfile || getCurrentCallProfile();
    const profileCustomer = profile.customer || {};
    const finalCustomerAddress = sessionMemory.businessAddress || formatCustomerAddress(profileCustomer);
    const finalPostcode = sessionMemory.postcode || profileCustomer.postcode || null;
    const finalBusinessName = sessionMemory.businessName || profileCustomer.businessName || null;
    const finalPhoneNumber =
      sessionMemory.phoneNumber || profileCustomer.phoneNumber || context.to;
    const finalContactName = sessionMemory.contactName || profileCustomer.name || null;
    const finalContactTitle =
      sessionMemory.contactTitle || profileCustomer.title || null;

    const payload = {
      phone_number_id: context.phoneNumberId,
      to: context.to,
      call_sid: currentCallSid,
      stream_sid: currentStreamSid,
      reason,
      outcome,
      started_at: context.startedAt,
      ended_at: new Date().toISOString(),
      total_audio_packets: audioPacketCount,
      customer: {
        title: finalContactTitle,
        name: finalContactName,
        business_name: finalBusinessName,
        phone_number: finalPhoneNumber,
        address: sessionMemory.businessAddress || profileCustomer.address || null,
        town: profileCustomer.town || null,
        county: profileCustomer.county || null,
        postcode: finalPostcode,
      },
      survey: {
        owner: sessionMemory.isBusinessOwner,
        authorised_decision_maker: sessionMemory.authorisedDecisionMaker,
        decision_maker: sessionMemory.isDecisionMaker,
        address_confirmed: sessionMemory.addressConfirmed,
        business_details_confirmed: sessionMemory.businessDetailsConfirmed,
        current_website: sessionMemory.websiteStatus,
        website_age: sessionMemory.websiteAge,
        considered_website: sessionMemory.websiteInterestLevel,
        gets_online_enquiries: sessionMemory.onlineEnquiryStatus,
        wants_more_enquiries: sessionMemory.interestInMoreEnquiries,
        classification: sessionMemory.industry,
        callback_consent: sessionMemory.callbackConsent,
        callback_requested: sessionMemory.callbackRequested,
        callback_date: sessionMemory.callbackDate,
        callback_time: sessionMemory.callbackTime,
        notes: sessionMemory.notes,
        outcome,
      },
      lead: {
        contact_name: finalContactName,
        contact_title: finalContactTitle,
        business_name: finalBusinessName,
        business_address: finalCustomerAddress || null,
        postcode: finalPostcode,
        business_details_confirmed: sessionMemory.businessDetailsConfirmed,
        address_confirmed: sessionMemory.addressConfirmed,
        business_owner_status: sessionMemory.isBusinessOwner,
        authorised_decision_maker: sessionMemory.authorisedDecisionMaker,
        decision_maker_name: sessionMemory.decisionMakerName,
        decision_maker_role: sessionMemory.decisionMakerRole,
        phone_number: finalPhoneNumber,
        website_status: sessionMemory.websiteStatus,
        website_age: sessionMemory.websiteAge,
        website_interest_level: sessionMemory.websiteInterestLevel,
        online_enquiry_status: sessionMemory.onlineEnquiryStatus,
        interest_in_more_enquiries: sessionMemory.interestInMoreEnquiries,
        industry: sessionMemory.industry,
        callback_consent: sessionMemory.callbackConsent,
        callback_date: sessionMemory.callbackDate,
        callback_time: sessionMemory.callbackTime,
        notes: sessionMemory.notes,
        outcome,
      },
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

  function clearIntroTimer() {
    if (introTimer) {
      clearTimeout(introTimer);
      introTimer = null;
    }
  }

  function clearSilenceTimer() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  function clearPendingVoicemailTimer() {
    if (pendingVoicemailTimer) {
      clearTimeout(pendingVoicemailTimer);
      pendingVoicemailTimer = null;
    }
  }

  function clearPendingBargeInTimer() {
    if (pendingBargeInTimer) {
      clearTimeout(pendingBargeInTimer);
      pendingBargeInTimer = null;
    }

    pendingBargeInTranscript = "";
  }

  function clearPendingHangupFallbackTimer() {
    if (pendingHangupFallbackTimer) {
      clearTimeout(pendingHangupFallbackTimer);
      pendingHangupFallbackTimer = null;
    }
  }

  // Registers the mark Twilio should report back once a final message has
  // finished playing, so the call can be ended right after. If the customer
  // barges in on that audio, Twilio clears its buffer and will never send
  // that mark event back - so this also arms a fallback timer that ends the
  // call anyway if the mark never arrives.
  function scheduleHangupAfterMark(markName, reason) {
    pendingHangupAfterMark = markName;
    callEndReason = reason;

    clearPendingHangupFallbackTimer();

    pendingHangupFallbackTimer = setTimeout(() => {
      pendingHangupFallbackTimer = null;

      if (callIsEnding) {
        return;
      }

      if (pendingHangupAfterMark !== markName) {
        return;
      }

      console.log("Hangup fallback triggered because Twilio mark was not received:", markName);

      pendingHangupAfterMark = null;
      endCallNow(reason);
    }, HANGUP_FALLBACK_DELAY_MS);
  }

  function cancelActiveAudioTracking() {
    if (activeAudioMark) {
      silenceWatchMarks.delete(activeAudioMark);
    }

    activeAudioMark = null;
    aiIsSpeaking = false;
  }

  function markShouldStartSilenceTimer(markName) {
    if (!markName) {
      return;
    }

    silenceWatchMarks.add(markName);
  }

  function getCurrentSilenceTimeoutMs() {
    return SILENCE_TIMEOUT_MS;
  }

  function startSilenceTimer() {
    clearSilenceTimer();

    if (callIsEnding) {
      return;
    }

    if (voicemailHandled) {
      return;
    }

    if (aiIsSpeaking) {
      return;
    }

    if (!currentStreamSid) {
      return;
    }

    const timeoutMs = getCurrentSilenceTimeoutMs();

    silenceTimer = setTimeout(async () => {
      silenceTimer = null;
      await handleSilenceTimeout();
    }, timeoutMs);

    console.log("Silence timer started:", {
      timeoutMs,
      silenceCheckCount,
    });
  }

  async function handleSilenceTimeout() {
    if (callIsEnding) {
      return;
    }

    if (voicemailHandled) {
      return;
    }

    if (aiIsSpeaking) {
      return;
    }

    silenceCheckCount += 1;

    console.log("Silence timeout reached:", {
      silenceCheckCount,
      maxSilenceChecks: MAX_SILENCE_CHECKS,
    });

    if (silenceCheckCount <= MAX_SILENCE_CHECKS) {
      await playSilenceCheckMessage();
      return;
    }

    await endCallNow("Customer silent after check-in");
  }

  async function playSilenceCheckMessage() {
    try {
      if (callIsEnding || voicemailHandled) {
        return;
      }

      if (!currentStreamSid) {
        console.log("Cannot play silence check because streamSid is missing");
        return;
      }

      if (ws.readyState !== WebSocket.OPEN) {
        console.log("Cannot play silence check because Twilio WebSocket is not open");
        return;
      }

      clearSilenceTimer();

      const message = SILENCE_CHECK_MESSAGE;

      console.log("AI silence check:", message);

      addTranscriptLine("assistant", message);

      conversationHistory.push({
        role: "assistant",
        content: message,
      });

      const thisResponseId = ++responseGenerationId;
      const audio = await textToSpeech(message);

      if (
        callIsEnding ||
        voicemailHandled ||
        thisResponseId !== responseGenerationId
      ) {
        console.log("Silence check cancelled before playback");
        return;
      }

      const markName = `silence-check-audio-${Date.now()}`;

      activeAudioMark = markName;
      aiIsSpeaking = true;
      interruptionHappened = false;

      markShouldStartSilenceTimer(markName);

      sendAudioToTwilio(ws, currentStreamSid, audio, markName);
    } catch (error) {
      console.error("Silence check error:", error.message);
      addTranscriptLine("system", `Silence check error: ${error.message}`);
      await endCallNow("Silence check error");
    }
  }

  async function endCallNow(reason) {
    try {
      if (callIsEnding) {
        return;
      }

      callIsEnding = true;
      callEndReason = reason;

      console.log("Ending call:", reason);

      if (!currentCallSid) {
        console.log("Cannot end call because callSid is missing");
        return;
      }

      clearIntroTimer();
      clearSilenceTimer();
      clearPendingBargeInTimer();
      clearPendingVoicemailTimer();
      clearPendingHangupFallbackTimer();

      await endOutboundCall(currentCallSid);

      console.log("Call ended successfully");

      await sendCallResultToRails(reason);
    } catch (error) {
      console.error("Error ending call:", error.message);
      addTranscriptLine("system", `Error ending call: ${error.message}`);
      await sendCallResultToRails("Error ending call");
    }
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

        markShouldStartSilenceTimer(introMarkName);

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
    }, INTRO_DELAY_MS);
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
    silenceCheckCount = 0;
    resetPendingCustomerUtterance();

    clearIntroTimer();
    clearSilenceTimer();

    const screeningReply = CALL_SCREENING_MESSAGE;

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

    markShouldStartSilenceTimer(markName);

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
    resetPendingCustomerUtterance();

    clearIntroTimer();
    clearSilenceTimer();
    clearPendingBargeInTimer();

    // If Lily's intro has already started playing, stop it.
    if (aiIsSpeaking) {
      clearTwilioAudio(ws, currentStreamSid);
      cancelActiveAudioTracking();
    }

    // Invalidate any AI/TTS response currently being generated.
    responseGenerationId++;

    addTranscriptLine("system", `Voicemail detected: ${detectedTranscript}`);

    const voicemailMessage = VOICEMAIL_MESSAGE;

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
        scheduleHangupAfterMark(markName, "Voicemail message finished playing");

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

  function getLastAssistantReply() {
    for (let index = conversationHistory.length - 1; index >= 0; index -= 1) {
      const message = conversationHistory[index];

      if (message && message.role === "assistant" && message.content) {
        return String(message.content);
      }
    }

    return "";
  }

  function replyAsksQuestion(reply) {
    return String(reply || "").includes("?");
  }

  // If the AI ever slips and offers to "put you through" or "transfer" the
  // customer, we intercept it and steer the conversation back to arranging
  // a callback instead. Live transfer is not supported.
  function aiReplySuggestsHandoff(reply) {
    const lowerReply = String(reply || "").toLowerCase();

    return (
      lowerReply.includes("put you through") ||
      lowerReply.includes("transfer you") ||
      lowerReply.includes("connect you") ||
      lowerReply.includes("speak to someone") ||
      lowerReply.includes("speak with someone")
    );
  }

  function lastAssistantAskedFinancialAuthority() {
    const lower = getLastAssistantReply().toLowerCase();

    return (
      lower.includes("authorised to make financial decisions") ||
      lower.includes("authorized to make financial decisions") ||
      lower.includes("make financial decisions on behalf of the business")
    );
  }

  function looksLikeFinancialDecisionClarification(text) {
    const lower = String(text || "").toLowerCase().trim();

    return (
      lower.includes("what kind of financial decisions") ||
      lower.includes("what sort of financial decisions") ||
      lower.includes("what do you mean by financial decisions") ||
      lower.includes("which financial decisions") ||
      lower === "what kind" ||
      lower === "what do you mean"
    );
  }

  function looksLikeCustomerQuestion(text) {
    const lower = String(text || "").toLowerCase().trim();

    if (!lower) {
      return false;
    }

    if (lower.includes("?")) {
      return true;
    }

    return /^(who|what|when|where|why|how|is this|are you|can you|could you|would you|do you|did you)\b/.test(
      lower
    );
  }

  function getFastPathReply(memory, cleanTranscript) {
    if (memory.wrongNumber || memory.correctBusinessConfirmed === "no") {
      return "Thanks for letting me know. Sorry for the disturbance. Have a great day.";
    }

    if (memory.doNotCall) {
      return "I understand. Sorry for disturbing you, we will not call again. Thank you, goodbye.";
    }

    if (
      lastAssistantAskedFinancialAuthority() &&
      looksLikeFinancialDecisionClarification(cleanTranscript)
    ) {
      return `${buildFinancialAuthorityClarifier()} Are you authorised to make those decisions on behalf of the business?`;
    }

    if (memory.callbackRequested === true && hasCallbackSlot(memory) && !memory.callbackConfirmed) {
      memory.callbackConfirmed = true;
      return buildCallbackConfirmationMessage(memory);
    }

    if (memory.notInterested) {
      return "Thank you for your time. Have a great day.";
    }

    const scriptedNextQuestion = getScriptedNextQuestion(
      memory,
      getCurrentCallProfile(),
      { companyName: CLIENT_COMPANY_NAME }
    );

    if (scriptedNextQuestion && !looksLikeCustomerQuestion(cleanTranscript)) {
      return scriptedNextQuestion;
    }

    return null;
  }

  function shouldEndCallAfterReply({ cleanTranscript, sessionMemory, aiReply }) {
    if (sessionMemory.doNotCall) {
      return true;
    }

    if (sessionMemory.wrongNumber || sessionMemory.correctBusinessConfirmed === "no") {
      return true;
    }

    if (sessionMemory.callbackConfirmed === true) {
      return true;
    }

    if (transcriptSuggestsGoodbye(cleanTranscript) && !replyAsksQuestion(aiReply)) {
      return true;
    }

    if (sessionMemory.notInterested && !replyAsksQuestion(aiReply)) {
      return true;
    }

    return false;
  }

  async function processFinalCustomerTranscript(cleanTranscript) {
    console.log("Customer said:", cleanTranscript);
    addTranscriptLine("customer", cleanTranscript);

    const memoryUpdate = updateSessionMemoryFromTranscript(
      sessionMemory,
      cleanTranscript,
      {
        conversationHistory,
        callProfile: getCurrentCallProfile(),
      }
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
      scheduleHangupAfterMark(markName, "Do-not-call message finished playing");

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
      const responseStartedAt = Date.now();

      console.log("AI response started");

      let aiReply = getFastPathReply(sessionMemory, cleanTranscript);

      if (aiReply) {
        console.log("Using fast-path reply");
      } else {
        aiReply = await getAIResponse({
          transcript: cleanTranscript,
          conversationHistory,
          sessionMemory,
          callProfile: getCurrentCallProfile(),
        });
      }

      const aiFinishedAt = Date.now();

      console.log("AI response finished:", {
        aiMs: aiFinishedAt - responseStartedAt,
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

      // Never allow a live transfer. If the model tries to offer one and we
      // don't yet have explicit callback consent, redirect to the consent
      // question instead.
      if (
        qualificationReadyForConsent(sessionMemory) &&
        !sessionMemory.callbackConfirmed &&
        aiReplySuggestsHandoff(aiReply)
      ) {
        console.log(
          "AI tried to offer a handoff. Replacing with callback consent question."
        );

        aiReply = callbackConsentQuestion({
          companyName: CLIENT_COMPANY_NAME,
        });
      }

      if (hasCallbackSlot(sessionMemory) && !sessionMemory.callbackConfirmed) {
        console.log("Callback slot captured. Confirming and ending the call.");
        aiReply = buildCallbackConfirmationMessage(sessionMemory);
        sessionMemory.callbackConfirmed = true;
      }

      const shouldHangUp =
        shouldEndCallAfterReply({
          cleanTranscript,
          sessionMemory,
          aiReply,
        }) || sessionMemory.callbackConfirmed === true;

      console.log("AI replied:", aiReply);
      addTranscriptLine("assistant", aiReply);

      console.log("TTS started");

      const ttsStartedAt = Date.now();
      const aiAudio = await textToSpeech(aiReply);
      const ttsFinishedAt = Date.now();

      console.log("TTS finished:", {
        ttsMs: ttsFinishedAt - ttsStartedAt,
        totalMs: ttsFinishedAt - responseStartedAt,
      });

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

      if (shouldHangUp) {
        const hangupReason = sessionMemory.callbackConfirmed
          ? "Callback arranged"
          : "Final AI message finished playing";

        scheduleHangupAfterMark(markName, hangupReason);
        console.log("Call will end after AI finishes speaking:", markName);
      } else {
        markShouldStartSilenceTimer(markName);
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

      // Invalidate current AI/TTS work.
      responseGenerationId++;

      clearTwilioAudio(ws, currentStreamSid);
      cancelActiveAudioTracking();

      clearSilenceTimer();
      clearPendingBargeInTimer();
    }, BARGE_IN_DEBOUNCE_MS);
  }

  const speechToText = createSpeechToTextStream({
    onTranscript: async ({
      transcript,
      isFinal,
      speechFinal,
      utteranceEnd,
      raw,
    }) => {
      try {
        const cleanTranscript = normaliseTranscriptText(transcript);

        if (!cleanTranscript && !utteranceEnd) {
          return;
        }

        // Once a final message (do-not-call, voicemail, callback confirmation,
        // goodbye) is playing or the call is already ending, ignore further
        // speech entirely. Treating it as a barge-in would clear Twilio's
        // audio buffer, which silently drops the "mark" event the hangup
        // depends on - the fallback timer will end the call instead.
        if (callIsEnding || pendingHangupAfterMark) {
          return;
        }

        // Any real transcript means the customer, voicemail, or screening assistant has spoken.
        // Stop silence timeout while we process it.
        clearSilenceTimer();

        // 1. iPhone call screening comes first.
        // This must not be treated as voicemail.
        if (isIphoneCallScreeningPrompt(cleanTranscript)) {
          silenceCheckCount = 0;
          await answerIphoneCallScreeningPrompt();
          return;
        }

        // 2. Voicemail / answer machine comes second.
        // This leaves one message, then hangs up.
        if (isVoicemailOrAnswerMachine(cleanTranscript)) {
          silenceCheckCount = 0;
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

        if (cleanTranscript) {
          customerHasSpoken = true;
          clearIntroTimer();
        }

        if (isFinal && cleanTranscript) {
          storePendingCustomerSegment(cleanTranscript, raw);
        }

        if (!speechFinal && !utteranceEnd) {
          return;
        }

        const finalTranscript = takePendingCustomerUtterance(cleanTranscript);

        if (!finalTranscript) {
          return;
        }

        const processedAt = Date.now();

        if (
          finalTranscript === lastFinalTranscript &&
          processedAt - lastFinalTranscriptAt < 1500
        ) {
          return;
        }

        lastFinalTranscript = finalTranscript;
        lastFinalTranscriptAt = processedAt;
        silenceCheckCount = 0;

        await processFinalCustomerTranscript(finalTranscript);
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
        const profile = getCurrentCallProfile();

        if (profile.customer?.phoneNumber && !sessionMemory.phoneNumber) {
          sessionMemory.phoneNumber = profile.customer.phoneNumber;
        } else if (callContext?.to && !sessionMemory.phoneNumber) {
          sessionMemory.phoneNumber = callContext.to;
        }

        console.log("Media stream started:", {
          callSid: currentCallSid,
          streamSid: currentStreamSid,
          hasCallContext: Boolean(callContext),
          phoneNumberId: callContext?.phoneNumberId || null,
          businessName: profile.customer?.businessName || null,
        });

        startIntroTimer();
      }

      if (data.event === "mark") {
        const finishedMarkName = data.mark?.name;

        console.log("Twilio finished playing:", finishedMarkName);

        const shouldStartSilenceAfterThisMark =
          finishedMarkName && silenceWatchMarks.has(finishedMarkName);

        if (finishedMarkName) {
          silenceWatchMarks.delete(finishedMarkName);
        }

        if (finishedMarkName && finishedMarkName === activeAudioMark) {
          aiIsSpeaking = false;
          activeAudioMark = null;
          clearPendingBargeInTimer();
        }

        if (finishedMarkName && finishedMarkName === pendingHangupAfterMark) {
          pendingHangupAfterMark = null;
          clearPendingHangupFallbackTimer();

          endCallNow(callEndReason || "Final AI message finished playing");

          return;
        }

        if (shouldStartSilenceAfterThisMark) {
          startSilenceTimer();
        }
      }

      if (data.event === "media") {
        audioPacketCount++;

        const audioBuffer = Buffer.from(data.media.payload, "base64");

        speechToText.sendAudio(audioBuffer);
      }

      if (data.event === "stop") {
        clearIntroTimer();
        clearSilenceTimer();
        clearPendingBargeInTimer();
        clearPendingVoicemailTimer();
        clearPendingHangupFallbackTimer();
        speechToText.close();

        console.log("Final session memory:", formatSessionMemoryForLog(sessionMemory));

        console.log("Media stream stopped:", {
          callSid: currentCallSid,
          streamSid: currentStreamSid,
          totalAudioPackets: audioPacketCount,
        });

        sendCallResultToRails(callEndReason || "Twilio media stream stopped");
      }
    } catch (error) {
      console.error("Error reading media stream message:", error.message);
      addTranscriptLine("system", `Error reading media stream message: ${error.message}`);
      sendCallResultToRails("Error reading media stream message");
    }
  });

  ws.on("close", () => {
    clearIntroTimer();
    clearSilenceTimer();
    clearPendingBargeInTimer();
    clearPendingVoicemailTimer();
    clearPendingHangupFallbackTimer();
    speechToText.close();

    console.log("Twilio media stream disconnected", {
      callSid: currentCallSid,
      streamSid: currentStreamSid,
      totalAudioPackets: audioPacketCount,
    });

    sendCallResultToRails(callEndReason || "Twilio media stream disconnected");
  });

  ws.on("error", (error) => {
    clearIntroTimer();
    clearSilenceTimer();
    clearPendingBargeInTimer();
    clearPendingVoicemailTimer();
    clearPendingHangupFallbackTimer();
    speechToText.close();

    console.error("WebSocket error:", error.message);
    addTranscriptLine("system", `WebSocket error: ${error.message}`);
    sendCallResultToRails(callEndReason || "WebSocket error");
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

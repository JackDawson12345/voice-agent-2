const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { EventEmitter } = require("node:events");
const { runInNewContext } = require("node:vm");
const memoryService = require("../services/session-memory");
const surveyScript = require("../services/survey-script");

// Exercise the server's real transcript, reply, playback-mark, hangup and
// results paths, with all telephony/network services replaced by local fakes.
for (const scenario of [
  ...["", "Yes"].map((interimText) => ({
    name: `a Flux turn starting during synthesis keeps its original question (initial text: ${interimText || "empty"})`,
    flux: true,
    answers: [
      "Jack speaking.", "Yes", "Yes", "Yes",
      { text: "Yes", duringSynthesis: { text: interimText, event: "StartOfTurn" } },
      { text: "Yes", expectedReply: /^How long have you had the website for/ },
      "Two years", "I don't want a callback",
    ],
    websiteAge: "Two years",
    noUnclearAge: true,
  })),
  ...[false, true].map((rejectSupersededTts) => ({
    name: `a repeated yes during synthesis answers the question already heard (discarded TTS rejects: ${rejectSupersededTts})`,
    flux: true,
    rejectSupersededTts,
    answers: [
      "Jack speaking.", "Yes", "Yes", "Yes",
      { text: "Yes", duringSynthesis: "Yes", expectedReply: /^How long have you had the website for/ },
      "Two years", "I don't want a callback",
    ],
    websiteAge: "Two years",
    noUnclearAge: true,
  })),
  {
    name: "a call stopping during silence-check synthesis sends no more audio",
    flux: true,
    disconnectDuringSilence: true,
    answers: ["Jack speaking.", "Yes"],
  },
  ...[false, true].map((slowTts) => ({
    name: `short Flux answers during playback keep the next reply audible (slow TTS: ${slowTts})`,
    flux: true,
    playbackRace: true,
    slowTts,
    answers: [
      ...["Jack speaking.", "Yep", "Yeah", "Yup", "Uh-huh", "Two years", "Times", "Two times"].map((text) => ({ text, finishPlayback: false })),
      "I don't want a callback",
    ],
    websiteAge: "Two years",
    onlineEnquiryStatus: "Two times",
  })),
  {
    name: "Flux confirms a misheard Friday and only books after 10pm is replaced with 10am",
    flux: true,
    callback: true,
    answers: [
      "Jack speaking.", "Yes", "Yes", "Yes", "Yes", "Two years",
      "Yes", "Yes", "Dog walking", "Yes", "Yes",
      { text: "Rider.", expectedReply: /Did you say Friday for the callback/ },
      { text: "Yes", expectedReply: /between 9am and 5pm/ },
      { text: "Ten PM.", expectedReply: /specific time between 9am and 5pm/ },
      { text: "10 AM", expectedReply: /arranged the callback for Friday at 10 am/ },
    ],
    websiteAge: "Two years",
  },
  {
    name: "the server closes a declined callback and posts no callback booking",
    answers: ["Jack speaking.", "No. I'm not.", "No. I'm not.", "No. Thank you."],
    websiteAge: null,
  },
  {
    name: "the server preserves a correction after a presence check and confirms a misheard duration",
    answers: [
      "Jack speaking.", "Yes", "Yes",
      "Yes. I'm still here. The business name is wrong.",
      "New Business", "01632000222", "Yes", "Yes",
      "Two. Yes.", "Yes", "I don't want a callback",
    ],
    websiteAge: "Two years",
    correctedBusiness: true,
  },
  {
    name: "the server combines final transcript segments on an empty speech boundary",
    answers: [
      "Jack speaking.", "Yes", "Yes", "Yes", "Yes",
      { text: "Yes.", speechFinal: false, raw: { start: 0 }, expectReply: false },
      { text: "Two years.", speechFinal: false, raw: { start: 1 }, expectReply: false },
      { text: "", speechFinal: true, raw: { start: 2 }, expectReply: true },
      "Who is this?", "I don't want a callback",
    ],
    websiteAge: "Two years",
    identityClarification: true,
  },
  {
    name: "Flux turns drive the survey once per answer and keep repeated yes answers",
    flux: true,
    answers: [
      "Jack speaking.", "Yes", "Yes", "Yes", "Yes",
      { text: "Two", event: "StartOfTurn", expectReply: false },
      { text: "Two yes", event: "Update", expectReply: false },
      { text: "Two yes", event: "EagerEndOfTurn", expectReply: false },
      { text: "Two years", event: "TurnResumed", expectReply: false },
      { text: "Two years.", event: "EndOfTurn" },
      { text: "Two years.", event: "EndOfTurn", turnIndex: 5, expectReply: false },
      "Who is this?", "I don't want a callback",
    ],
    websiteAge: "Two years",
    identityClarification: true,
  },
]) {
test(scenario.name, async () => {
  const routes = new Map();
  const spoken = [];
  const outgoing = [];
  const results = [];
  const endedCalls = [];
  const errors = [];
  const timers = new Map();
  let timerId = 0;
  let now = Date.now();
  let onTranscript;
  let speechKeyterms;
  let fluxSocket;
  let transcriptCompletion;
  let turnIndex = 0;
  let synthesisAnswer = null;
  let websocketServer;
  const app = {
    use() {}, get() {}, all() {},
    post: (path, handler) => routes.set(path, handler),
  };
  const express = Object.assign(() => app, { json() {}, urlencoded() {} });
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    send: (message) => outgoing.push(JSON.parse(message)),
  });
  const dependencies = {
    dotenv: { config() {} },
    express,
    http: { createServer: () => ({ listen() {} }) },
    ws: {
      OPEN: 1,
      Server: class extends EventEmitter {
        constructor() { super(); websocketServer = this; }
      },
    },
    "./services/twilio": {
      startOutboundCall: async () => ({ sid: "CA-test-refusal" }),
      endOutboundCall: async (sid) => { endedCalls.push(sid); },
    },
    "./services/speech-to-text": {
      createSpeechToTextStream: (options) => {
        onTranscript = options.onTranscript;
        speechKeyterms = options.keyterms;
        if (scenario.flux) {
          class FluxWebSocket extends EventEmitter {
            static CONNECTING = 0;
            static OPEN = 1;
            constructor() { super(); this.readyState = 1; fluxSocket = this; }
            send() {}
            close() { this.readyState = 3; this.emit("close"); }
          }
          const module = { exports: {} };
          runInNewContext(readFileSync(require.resolve("../services/speech-to-text"), "utf8"), {
            require: (name) => { assert.equal(name, "ws"); return FluxWebSocket; },
            module, Buffer, URLSearchParams,
            process: { env: { DEEPGRAM_API_KEY: "test-only" } },
            console: { log() {}, warn() {}, error: (...args) => errors.push(args) },
          });
          const stream = module.exports.createSpeechToTextStream({
            ...options,
            onTranscript: (result) => { transcriptCompletion = options.onTranscript(result); },
          });
          fluxSocket.emit("open");
          return stream;
        }
        return { sendAudio() {}, close() {} };
      },
    },
    "./services/ai-response": {
      getAIResponse: async () => { throw new Error("These answers should use the scripted flow"); },
    },
    "./services/text-to-speech": {
      textToSpeech: async (text) => {
        spoken.push(text);
        if (scenario.slowTts) await fireBargeInTimers();
        if (synthesisAnswer) {
          const answer = typeof synthesisAnswer === "string" ? { text: synthesisAnswer } : synthesisAnswer;
          synthesisAnswer = null;
          now += 100;
          await deliverFluxTurn(answer.text, answer.event);
          if (scenario.rejectSupersededTts) throw new Error("Superseded TTS failed");
        }
        if (scenario.disconnectDuringSilence && text === "Hello, are you still on the line?") {
          socket.emit("message", JSON.stringify({ event: "stop" }));
        }
        return Buffer.alloc(800);
      },
    },
    "./services/session-memory": memoryService,
    "./services/survey-script": surveyScript,
  };
  runInNewContext(readFileSync(require.resolve("../server"), "utf8"), {
    require: (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    process: { env: {} },
    Buffer,
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    console: { log() {}, error: (...args) => errors.push(args) },
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (_url, options) => {
      results.push(JSON.parse(options.body));
      return { ok: true, text: async () => "ok" };
    },
  }, { filename: "server.js" });

  await routes.get("/start-call")({ body: {
    to: "+441632000111", phone_number_id: 1,
    callback_url: "https://example.invalid/call-results",
    customer: {
      business_name: "Example Business", address: "100 Old Road",
      town: "Middlesbrough", postcode: "TS6 0DS",
    },
  } }, { json() {}, status() { return this; } });
  websocketServer.emit("connection", socket);
  socket.emit("message", JSON.stringify({ event: "start", start: {
    callSid: "CA-test-refusal", streamSid: "MZ-test-refusal",
  } }));

  assert.ok(speechKeyterms.includes("Example Business"));
  assert.ok(speechKeyterms.includes("Middlesbrough"));
  async function fireBargeInTimers() {
    for (const [id, timer] of [...timers]) {
      if (timer.delay !== 250) continue;
      timers.delete(id);
      await timer.callback();
    }
  }

  async function deliverFluxTurn(text, event = "EndOfTurn", explicitTurnIndex) {
    const index = explicitTurnIndex ?? turnIndex;
    if (event === "EndOfTurn" && explicitTurnIndex === undefined) turnIndex++;
    transcriptCompletion = null;
    fluxSocket.emit("message", Buffer.from(JSON.stringify({
      type: "TurnInfo", event, transcript: text, turn_index: index,
    })));
    await transcriptCompletion;
  }

  for (const entry of scenario.answers) {
    const { text, speechFinal = true, raw, expectReply = true, expectedReply, duringSynthesis, finishPlayback = true, event = "EndOfTurn", turnIndex: explicitTurnIndex } =
      typeof entry === "string" ? { text: entry } : entry;
    now += scenario.flux ? 500 : 2000;
    const previousReplyCount = spoken.length;
    const previousMarkCount = outgoing.filter((message) => message.event === "mark").length;
    synthesisAnswer = duringSynthesis;
    if (scenario.flux) {
      await deliverFluxTurn(text, event, explicitTurnIndex);
    } else {
      await onTranscript({ transcript: text, isFinal: true, speechFinal, raw });
    }
    const extraReply = duringSynthesis && (typeof duringSynthesis === "string" || duringSynthesis.event === "EndOfTurn");
    assert.equal(spoken.length, previousReplyCount + Number(expectReply) + Number(Boolean(extraReply)), `Unexpected reply count for ${text}`);
    assert.equal(outgoing.filter((message) => message.event === "mark").length,
      previousMarkCount + Number(expectReply), `Reply audio was lost for ${text}`);
    if (scenario.playbackRace) {
      const clearCount = outgoing.filter((message) => message.event === "clear").length;
      await fireBargeInTimers();
      assert.equal(outgoing.filter((message) => message.event === "clear").length,
        clearCount, "An old interruption timer cleared the new reply");
    }
    if (expectedReply) assert.match(spoken.at(-1), expectedReply);
    if (scenario.callback && text !== "10 AM") {
      assert.ok([...timers.values()].every((timer) => timer.delay !== 1200), "Callback must not end before a valid time is supplied");
      assert.equal(results.length, 0);
    }
    if (!expectReply || !finishPlayback) continue;
    const mark = outgoing.filter((message) => message.event === "mark").at(-1);
    socket.emit("message", JSON.stringify(mark));
  }

  if (scenario.disconnectDuringSilence) {
    const previousMarkCount = outgoing.filter((message) => message.event === "mark").length;
    const silenceTimer = [...timers.values()].find((timer) => timer.delay === 8000);
    assert.ok(silenceTimer);
    await silenceTimer.callback();
    await new Promise(setImmediate);
    assert.equal(outgoing.filter((message) => message.event === "mark").length, previousMarkCount);
    assert.equal(results.length, 1);
    assert.equal(results[0].reason, "Twilio media stream stopped");
    assert.deepEqual(endedCalls, []);
    assert.deepEqual(errors, []);
    return;
  }

  if (!scenario.callback) {
    assert.equal(spoken.at(-1), surveyScript.buildCallbackDeclinedMessage());
    assert.ok(spoken.every((text) => !/what day|what time/i.test(text)));
  }
  assert.equal(endedCalls.length, 0, "The closing audio must finish before hangup");
  const finalHangup = [...timers.values()].find((timer) => timer.delay === 1200);
  assert.ok(finalHangup, "No hangup was scheduled after the closing playback mark");
  finalHangup.callback();
  await new Promise(setImmediate);

  assert.deepEqual(errors, []);
  assert.deepEqual(endedCalls, ["CA-test-refusal"]);
  assert.equal(results.length, 1);
  if (scenario.callback) {
    assert.equal(results[0].reason, "Callback arranged");
    assert.equal(results[0].survey.callback_consent, "yes");
    assert.equal(results[0].survey.callback_requested, true);
    assert.equal(results[0].survey.callback_date, "Friday");
    assert.equal(results[0].survey.callback_time, "10 am");
    assert.equal(results[0].memory.callbackConfirmed, true);
  } else {
    assert.equal(results[0].reason, "Callback declined");
    assert.equal(results[0].outcome, "Not interested");
    assert.equal(results[0].survey.callback_consent, "no");
    assert.equal(results[0].survey.callback_requested, false);
    assert.equal(results[0].survey.callback_date, null);
    assert.equal(results[0].survey.callback_time, null);
    assert.equal(results[0].memory.callbackConfirmed, false);
  }
  assert.equal(results[0].survey.website_age, scenario.websiteAge);
  if (scenario.noUnclearAge) {
    assert.ok(results[0].memory.notes.every((note) => !note.startsWith("Unclear website age")));
  }
  if (scenario.onlineEnquiryStatus) {
    assert.equal(results[0].memory.onlineEnquiryStatus, scenario.onlineEnquiryStatus);
  }
  if (scenario.correctedBusiness) {
    assert.equal(results[0].customer.business_name, "New Business");
    assert.equal(results[0].survey.business_details_confirmed, "no");
    assert.ok(spoken.includes("Did you say you've had the website for Two years?"));
  }
  if (scenario.identityClarification) {
    assert.ok(spoken.some((text) => /^My name is Lily.*Do you get enquiries online/.test(text)));
  }
});
}

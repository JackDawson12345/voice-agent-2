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
        return { sendAudio() {}, close() {} };
      },
    },
    "./services/ai-response": {
      getAIResponse: async () => { throw new Error("These answers should use the scripted flow"); },
    },
    "./services/text-to-speech": {
      textToSpeech: async (text) => { spoken.push(text); return Buffer.alloc(800); },
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
  for (const entry of scenario.answers) {
    const { text, speechFinal = true, raw, expectReply = true } =
      typeof entry === "string" ? { text: entry } : entry;
    now += 2000;
    const previousReplyCount = spoken.length;
    await onTranscript({ transcript: text, isFinal: true, speechFinal, raw });
    assert.equal(spoken.length, previousReplyCount + Number(expectReply), `Unexpected reply count for ${text}`);
    if (!expectReply) continue;
    const mark = outgoing.filter((message) => message.event === "mark").at(-1);
    socket.emit("message", JSON.stringify(mark));
  }

  assert.equal(spoken.at(-1), surveyScript.buildCallbackDeclinedMessage());
  assert.ok(spoken.every((text) => !/what day|what time/i.test(text)));
  assert.equal(endedCalls.length, 0, "The closing audio must finish before hangup");
  const finalHangup = [...timers.values()].find((timer) => timer.delay === 1200);
  assert.ok(finalHangup, "No hangup was scheduled after the closing playback mark");
  finalHangup.callback();
  await new Promise(setImmediate);

  assert.deepEqual(errors, []);
  assert.deepEqual(endedCalls, ["CA-test-refusal"]);
  assert.equal(results.length, 1);
  assert.equal(results[0].reason, "Callback declined");
  assert.equal(results[0].outcome, "Not interested");
  assert.equal(results[0].survey.callback_consent, "no");
  assert.equal(results[0].survey.callback_requested, false);
  assert.equal(results[0].survey.callback_date, null);
  assert.equal(results[0].survey.callback_time, null);
  assert.equal(results[0].memory.callbackConfirmed, false);
  assert.equal(results[0].survey.website_age, scenario.websiteAge);
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

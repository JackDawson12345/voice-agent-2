const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { EventEmitter } = require("node:events");
const { runInNewContext } = require("node:vm");
const memoryService = require("../services/session-memory");
const surveyScript = require("../services/survey-script");

const SCREENING_PROMPT = "If you record your name and reason for calling, I'll see if this person is available.";
const WAIT_TIMEOUT = 60000;

// Drive the real server with transcript events, Twilio playback marks and a
// virtual clock. All audio, telephony and Rails requests remain local fakes.
async function createCall({ env = {}, synthesise } = {}) {
  const routes = new Map();
  const spoken = [];
  const outgoing = [];
  const endedCalls = [];
  const results = [];
  const errors = [];
  const timers = new Map();
  let now = 100000;
  let timerId = 0;
  let turnIndex = 0;
  let onTranscript;
  let websocketServer;
  const app = {
    use() {}, get() {}, all() {},
    post: (path, handler) => routes.set(path, handler),
  };
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    send: (message) => outgoing.push(JSON.parse(message)),
  });
  const dependencies = {
    dotenv: { config() {} },
    express: Object.assign(() => app, { json() {}, urlencoded() {} }),
    http: { createServer: () => ({ listen() {} }) },
    ws: {
      OPEN: 1,
      Server: class extends EventEmitter {
        constructor() { super(); websocketServer = this; }
      },
    },
    "./services/twilio": {
      startOutboundCall: async () => ({ sid: "CA-screening" }),
      endOutboundCall: async (sid) => { endedCalls.push(sid); },
    },
    "./services/speech-to-text": {
      createSpeechToTextStream: (options) => {
        onTranscript = options.onTranscript;
        return { sendAudio() {}, close() {} };
      },
    },
    "./services/ai-response": {
      getAIResponse: async () => { throw new Error("Unexpected AI request"); },
    },
    "./services/text-to-speech": {
      textToSpeech: async (text) => {
        spoken.push(text);
        if (synthesise) await synthesise(text);
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
    process: { env }, Buffer,
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    console: { log() {}, error: (...args) => errors.push(args) },
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, { callback, delay, at: now + delay });
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
    customer: { business_name: "Example Business" },
  } }, { json() {}, status() { return this; } });
  websocketServer.emit("connection", socket);
  const emit = (data) => socket.emit("message", JSON.stringify(data));
  emit({ event: "start", start: { callSid: "CA-screening", streamSid: "MZ-screening" } });

  return {
    spoken, outgoing, endedCalls, results, errors, timers,
    async say(transcript, event = "EndOfTurn", metadata = {}) {
      const index = turnIndex;
      if (event === "EndOfTurn") turnIndex++;
      await onTranscript({
        transcript, isFinal: event === "EndOfTurn", speechFinal: event === "EndOfTurn",
        raw: { type: "TurnInfo", event, turn_index: index, ...metadata },
      });
    },
    transcript: (result) => onTranscript(result),
    finishAudio(mark = outgoing.filter((message) => message.event === "mark").at(-1)) {
      assert.ok(mark, "No audio mark to finish");
      emit(mark);
      return mark;
    },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        timers.delete(id);
        await timer.callback();
        await new Promise(setImmediate);
      }
      now = target;
    },
    async disconnect(event = "stop") {
      if (event === "stop") emit({ event });
      else if (event === "error") socket.emit("error", new Error("Connection lost"));
      else socket.emit(event);
      await new Promise(setImmediate);
    },
  };
}

function recognitionConfidence(text, confidence) {
  return {
    words: text.split(/\s+/).map((word) => ({ word, confidence })),
    end_of_turn_confidence: 0.99,
  };
}

test("uncertain background words cannot cancel the intro or become a survey answer", async () => {
  const call = await createCall();
  await call.say("Yes", "StartOfTurn", recognitionConfidence("Yes", 0.2));
  await call.say("Yes", "EndOfTurn", recognitionConfidence("Yes", 0.2));
  await call.advance(700);
  assert.equal(call.spoken.length, 1);
  assert.equal(call.outgoing.filter((message) => message.event === "clear").length, 0);
  await call.disconnect();
  assert.equal(call.results[0].memory.isBusinessOwner, null);
  assert.equal(call.results[0].transcript.filter((line) => line.role === "customer").length, 0);
  assert.deepEqual(call.errors, []);
});

test("uncertain recognition cannot trigger screening or voicemail", async () => {
  const call = await createCall();
  await call.advance(700);
  for (const text of [SCREENING_PROMPT, "Please leave a message after the tone."]) {
    await call.say(text, "Update", recognitionConfidence(text, 0.2));
    await call.say(text, "EndOfTurn", recognitionConfidence(text, 0.2));
  }
  await call.advance(1500);
  assert.equal(call.spoken.length, 1);
  assert.equal(call.outgoing.filter((message) => message.event === "clear").length, 0);
  assert.equal(call.endedCalls.length, 0);
  await call.disconnect();
  assert.deepEqual(call.errors, []);
});

test("interruptions need stronger confidence but a completed short answer still works", async () => {
  const call = await createCall();
  await call.advance(700);
  await call.say("Yes", "Update", recognitionConfidence("Yes", 0.65));
  await call.advance(300);
  assert.equal(call.outgoing.filter((message) => message.event === "clear").length, 0);
  await call.say("Yes", "EndOfTurn", recognitionConfidence("Yes", 0.65));
  assert.equal(call.outgoing.filter((message) => message.event === "clear").length, 1);
  assert.equal(call.spoken.length, 2);
  await call.disconnect();
  assert.equal(call.results[0].memory.isBusinessOwner, "yes");
  assert.deepEqual(call.errors, []);
});

for (const revision of ["empty update", "empty final", "low confidence", "weaker confidence", "filler"]) {
  test(`a pending interruption is cancelled after a ${revision} revision`, async () => {
    const call = await createCall();
    await call.advance(700);
    await call.say("Hello", "Update", recognitionConfidence("Hello", 0.95));
    await call.advance(100);
    const text = revision.startsWith("empty") ? "" : revision === "filler" ? "um" : "Hello";
    const confidence = revision === "low confidence" ? 0.2 : revision === "weaker confidence" ? 0.65 : 0.95;
    await call.say(text, revision === "empty final" ? "EndOfTurn" : "Update", recognitionConfidence(text, confidence));
    await call.advance(300);
    assert.equal(call.outgoing.filter((message) => message.event === "clear").length, 0);
    assert.equal(call.spoken.length, 1);
    await call.disconnect();
    assert.deepEqual(call.errors, []);
  });
}

test("repeated noise and empty turn starts cannot postpone the silence check", async () => {
  const call = await createCall();
  await call.advance(700);
  call.finishAudio();
  for (let i = 0; i < 7; i++) {
    await call.advance(1000);
    await call.say("", "StartOfTurn");
    await call.say("Yes", "EndOfTurn", recognitionConfidence("Yes", 0.1));
  }
  await call.say("", "StartOfTurn");
  await call.advance(1000);
  assert.equal(call.spoken.at(-1), "Hello, are you still on the line?");
  await call.disconnect();
  assert.deepEqual(call.errors, []);
});

test("a retracted speech update resumes the silence check after playback finishes", async () => {
  const call = await createCall();
  await call.advance(700);
  await call.say("Hello", "Update", recognitionConfidence("Hello", 0.95));
  call.finishAudio();
  await call.say("", "Update");
  await call.advance(8000);
  assert.equal(call.spoken.at(-1), "Hello, are you still on the line?");
  await call.disconnect();
  assert.deepEqual(call.errors, []);
});

for (const text of ["Yes", "No", "Stop"]) {
  test(`confident short speech can still interrupt: ${text}`, async () => {
    const call = await createCall();
    await call.advance(700);
    await call.say(text, "Update", recognitionConfidence(text, 0.95));
    await call.advance(250);
    assert.equal(call.outgoing.filter((message) => message.event === "clear").length, 1);
    await call.say(text, "EndOfTurn", recognitionConfidence(text, 0.95));
    assert.equal(call.spoken.length, 2);
    await call.disconnect();
    assert.deepEqual(call.errors, []);
  });
}

test("a rejected final never restores a confident interim answer", async () => {
  const call = await createCall();
  await call.advance(700);
  await call.say("Yes", "Update", recognitionConfidence("Yes", 0.95));
  await call.advance(250);
  await call.say("Yes", "EndOfTurn", recognitionConfidence("Yes", 0.2));
  await call.advance(8000);
  assert.equal(call.spoken.at(-1), "Hello, are you still on the line?");
  await call.disconnect();
  assert.equal(call.results[0].memory.isBusinessOwner, null);
  assert.equal(call.results[0].transcript.filter((line) => line.role === "customer").length, 0);
  assert.deepEqual(call.errors, []);
});

test("noise confidence thresholds can be tuned or disabled", async () => {
  const call = await createCall({ env: {
    MIN_TRANSCRIPT_CONFIDENCE: "0.8", BARGE_IN_MIN_CONFIDENCE: "0.9",
  } });
  await call.advance(700);
  await call.say("Yes", "EndOfTurn", recognitionConfidence("Yes", 0.75));
  assert.equal(call.spoken.length, 1);
  await call.say("Yes", "Update", recognitionConfidence("Yes", 0.85));
  await call.advance(300);
  assert.equal(call.outgoing.filter((message) => message.event === "clear").length, 0);
  await call.disconnect();

  const disabled = await createCall({ env: {
    MIN_TRANSCRIPT_CONFIDENCE: "0", BARGE_IN_MIN_CONFIDENCE: "0",
  } });
  await disabled.advance(700);
  await disabled.say("Yes", "Update", recognitionConfidence("Yes", 0.1));
  await disabled.advance(250);
  assert.equal(disabled.outgoing.filter((message) => message.event === "clear").length, 1);
  await disabled.say("Yes", "EndOfTurn", recognitionConfidence("Yes", 0.1));
  await disabled.disconnect();
  assert.equal(disabled.results[0].memory.isBusinessOwner, "yes");
});

test("invalid noise confidence thresholds fail at startup", async () => {
  for (const name of ["MIN_TRANSCRIPT_CONFIDENCE", "BARGE_IN_MIN_CONFIDENCE"]) {
    for (const value of ["-0.1", "1.1", "NaN", "Infinity"]) {
      await assert.rejects(createCall({ env: { [name]: value } }), new RegExp(name));
    }
  }
});

test("the logged screening handoff stays quiet until the recipient speaks", async () => {
  const call = await createCall();
  await call.say(SCREENING_PROMPT, "Update");
  await call.say(SCREENING_PROMPT);
  call.finishAudio();
  await call.advance(12000);
  await call.say("Thanks.");
  await call.say("stay on the line", "Update");
  await call.advance(300);
  await call.say("Please stay on the line.");
  await call.say("", "StartOfTurn");
  await call.say("");
  await call.advance(25000);
  assert.equal(call.spoken.length, 1);
  assert.equal(call.endedCalls.length, 0);
  assert.ok([...call.timers.values()].every((timer) => timer.delay !== 8000));

  await call.say("Hello, Jack speaking.");
  assert.equal(call.spoken.length, 2);
  assert.match(call.spoken.at(-1), /calling on behalf of.*Are you the business owner\?/);
  assert.ok([...call.timers.values()].every((timer) => timer.delay !== WAIT_TIMEOUT));
  call.finishAudio();
  await call.advance(8000);
  assert.equal(call.spoken.at(-1), "Hello, are you still on the line?");
  call.finishAudio();
  await call.advance(8000);
  assert.deepEqual(call.endedCalls, ["CA-screening"]);
  assert.equal(call.results[0].reason, "Customer silent after check-in");
  assert.equal(call.results[0].memory.contactName, "Jack");
  assert.equal(call.results[0].memory.isBusinessOwner, null);
  assert.deepEqual(call.results[0].transcript.filter((line) => line.role === "customer")
    .map((line) => line.content), ["Hello, Jack speaking."]);
  assert.deepEqual(call.errors, []);
});

for (const timeout of [WAIT_TIMEOUT, 45000]) {
  test(`screening has a bounded ${timeout}ms wait even with repeated announcements`, async () => {
    const call = await createCall({ env: timeout === WAIT_TIMEOUT ? {} : {
      CALL_SCREENING_WAIT_TIMEOUT_MS: String(timeout),
    } });
    await call.say(SCREENING_PROMPT);
    call.finishAudio();
    await call.advance(timeout - 1);
    await call.say("Thank you. Please stay on the line.");
    await call.say(SCREENING_PROMPT);
    assert.equal(call.spoken.length, 1);
    assert.equal(call.endedCalls.length, 0);
    await call.advance(1);
    assert.deepEqual(call.endedCalls, ["CA-screening"]);
    assert.equal(call.results[0].reason, "Call screening timed out waiting for the recipient");
    assert.equal(call.spoken.length, 1);
    assert.equal(call.results[0].memory.contactName, null);
    assert.equal(call.results[0].memory.lastUpdatedAt, null);
    assert.deepEqual(call.errors, []);
  });
}

test("screening clears a playing intro and ignores stale marks and hold barge-ins", async () => {
  const call = await createCall();
  await call.advance(700);
  const introMark = call.outgoing.find((message) => message.event === "mark");
  await call.say(SCREENING_PROMPT);
  assert.equal(call.outgoing.filter((message) => message.event === "clear").length, 1);
  call.finishAudio(introMark);
  await call.say("Please stay on the line", "Update");
  await call.advance(300);
  await call.say("Thanks. Please stay on the line.");
  assert.equal(call.outgoing.filter((message) => message.event === "clear").length, 1);
  call.finishAudio();
  await call.advance(16000);
  assert.equal(call.spoken.length, 2);
  assert.equal(call.endedCalls.length, 0);
  await call.disconnect();
  assert.equal(call.timers.size, 0);
  assert.deepEqual(call.errors, []);
});

test("segmented transcripts can carry a screening acknowledgement and hold instruction", async () => {
  const call = await createCall();
  await call.say(SCREENING_PROMPT);
  call.finishAudio();
  await call.transcript({ transcript: "Thank you.", isFinal: true, speechFinal: false, raw: { start: 1 } });
  await call.transcript({ transcript: "Please hold while I try to connect you.", isFinal: true, speechFinal: false, raw: { start: 2 } });
  await call.transcript({ transcript: "", utteranceEnd: true });
  await call.advance(20000);
  assert.equal(call.spoken.length, 1);
  await call.say("Thanks, hello, Jack speaking.");
  assert.equal(call.spoken.length, 2, "A human response containing thanks must resume the survey");
  await call.disconnect();
  assert.deepEqual(call.errors, []);
});

test("thanks is a normal customer turn outside the screening wait", async () => {
  const call = await createCall();
  await call.say("Thanks.");
  assert.equal(call.spoken.length, 1);
  assert.match(call.spoken[0], /Are you the business owner\?/);
  await call.disconnect();
  assert.deepEqual(call.errors, []);

  const screened = await createCall();
  await screened.say(SCREENING_PROMPT);
  screened.finishAudio();
  await screened.say("Hello.");
  screened.finishAudio();
  await screened.say("Thanks.");
  assert.equal(screened.spoken.length, 3);
  await screened.disconnect();
  assert.deepEqual(screened.errors, []);
});

test("voicemail during the screening wait still leaves a message and hangs up", async () => {
  const call = await createCall();
  await call.say(SCREENING_PROMPT);
  call.finishAudio();
  await call.say("Please leave a message after the tone.");
  assert.ok([...call.timers.values()].every((timer) => timer.delay !== WAIT_TIMEOUT));
  await call.advance(1200);
  assert.equal(call.spoken.length, 2);
  call.finishAudio();
  await call.advance(1200);
  assert.deepEqual(call.endedCalls, ["CA-screening"]);
  assert.equal(call.results[0].reason, "Voicemail message finished playing");
  assert.deepEqual(call.errors, []);
});

for (const event of ["stop", "close", "error", "human", "timeout"]) {
  test(`pending screening synthesis is cancelled on ${event}`, async () => {
    let completeSynthesis;
    const call = await createCall({ synthesise: (text) => {
      if (text.includes("regarding the business and online visibility")) {
        return new Promise((resolve) => { completeSynthesis = resolve; });
      }
    } });
    const reply = call.say(SCREENING_PROMPT);
    assert.ok(completeSynthesis);
    if (event === "human") await call.say("Hello, Jack speaking.");
    else if (event === "timeout") await call.advance(WAIT_TIMEOUT);
    else await call.disconnect(event);
    const audioCount = call.outgoing.length;
    completeSynthesis();
    await reply;
    assert.equal(call.outgoing.length, audioCount, "Stale screening audio must not play");
    assert.ok([...call.timers.values()].every((timer) => timer.delay !== WAIT_TIMEOUT));
    if (event === "human") {
      assert.match(call.spoken.at(-1), /Are you the business owner\?/);
      await call.disconnect();
    }
    await call.advance(WAIT_TIMEOUT);
    assert.equal(call.results.length, 1);
    assert.equal(call.endedCalls.length, event === "timeout" ? 1 : 0);
    assert.equal(call.errors.length, event === "error" ? 1 : 0);
  });
}

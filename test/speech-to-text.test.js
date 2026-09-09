const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");

function recognitionStream(env = {}, keyterms = []) {
  let socket;
  const transcripts = [];
  const warnings = [];
  const errors = [];
  class WebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.readyState = WebSocket.CONNECTING;
      this.sent = [];
      socket = this;
    }
    send(buffer) { this.sent.push(buffer); }
    close() { this.readyState = 3; this.emit("close"); }
  }
  const module = { exports: {} };
  runInNewContext(readFileSync(require.resolve("../services/speech-to-text"), "utf8"), {
    require: (name) => { assert.equal(name, "ws"); return WebSocket; },
    module,
    process: { env: { DEEPGRAM_API_KEY: "test-only", ...env } },
    URLSearchParams,
    Buffer,
    console: { log() {}, error() {}, warn: (message) => warnings.push(message) },
  });
  const stream = module.exports.createSpeechToTextStream({
    onTranscript: (result) => transcripts.push(result), keyterms,
    onError: (error) => errors.push(error),
  });
  return { socket, stream, transcripts, warnings, errors,
    receive(data) { socket.emit("message", Buffer.from(JSON.stringify(data))); },
    open() {
    socket.readyState = WebSocket.OPEN;
    socket.emit("open");
  } };
}

test("Flux uses listen v2, Twilio audio, and individually encoded terminology hints", () => {
  const recognition = recognitionStream({ DEEPGRAM_KEYTERMS: "Whinfell Drive,Normanby,years" }, ["Example & Sons", "Middlesbrough"]);
  const params = new URL(recognition.socket.url).searchParams;
  assert.equal(new URL(recognition.socket.url).origin, "wss://api.deepgram.com");
  assert.equal(new URL(recognition.socket.url).pathname, "/v2/listen");
  assert.equal(recognition.socket.options.headers.Authorization, "Token test-only");
  assert.equal(params.get("encoding"), "mulaw");
  assert.equal(params.get("sample_rate"), "8000");
  assert.equal(params.get("model"), "flux-general-en");
  assert.equal(params.get("eot_threshold"), "0.7");
  assert.equal(params.get("eot_timeout_ms"), "5000");
  for (const name of ["language", "channels", "interim_results", "punctuate", "endpointing", "utterance_end_ms", "eager_eot_threshold"]) {
    assert.equal(params.has(name), false, name);
  }
  const hints = params.getAll("keyterm");
  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]) {
    assert.ok(hints.includes(day), `Missing weekday hint: ${day}`);
  }
  for (const term of ["years", "months", "Whinfell Drive", "Normanby", "Example & Sons", "Middlesbrough"]) {
    assert.ok(hints.includes(term), term);
  }
  assert.equal(hints.filter((term) => term === "years").length, 1);
});

test("Flux turn settings override defaults and obsolete Nova settings are ignored", () => {
  const recognition = recognitionStream({
    DEEPGRAM_EOT_THRESHOLD: "0.8", DEEPGRAM_EOT_TIMEOUT_MS: "1500",
    DEEPGRAM_ENDPOINTING_MS: "750", DEEPGRAM_UTTERANCE_END_MS: "1000",
  });
  const params = new URL(recognition.socket.url).searchParams;
  assert.equal(params.get("eot_threshold"), "0.8");
  assert.equal(params.get("eot_timeout_ms"), "1500");
  assert.equal(params.has("endpointing"), false);
  assert.equal(params.has("utterance_end_ms"), false);
});

test("startup and live Twilio packets form ordered 80 ms Flux frames", () => {
  const recognition = recognitionStream();
  const packets = Array.from({ length: 8 }, (_, i) => Buffer.alloc(160, i));
  packets.slice(0, 3).forEach(recognition.stream.sendAudio);
  assert.equal(recognition.socket.sent.length, 0);
  recognition.open();
  assert.equal(recognition.socket.sent.length, 0);
  packets.slice(3).forEach(recognition.stream.sendAudio);
  assert.deepEqual(recognition.socket.sent.map((buffer) => buffer.length), [640, 640]);
  assert.deepEqual(Buffer.concat(recognition.socket.sent), Buffer.concat(packets));
});

test("startup audio is bounded and closing clears queued audio", () => {
  const recognition = recognitionStream();
  for (let i = 0; i < 8; i += 1) recognition.stream.sendAudio(Buffer.alloc(8000, i));
  assert.equal(recognition.warnings.length, 1);
  recognition.open();
  recognition.stream.close();
  assert.deepEqual(Buffer.concat(recognition.socket.sent), Buffer.concat(
    Array.from({ length: 5 }, (_, i) => Buffer.alloc(8000, i + 3))
  ));
  const closed = recognitionStream();
  closed.stream.sendAudio(Buffer.from("queued"));
  closed.stream.close();
  closed.open();
  closed.stream.sendAudio(Buffer.alloc(640));
  assert.equal(closed.socket.sent.length, 0);
});

test("empty turn boundaries are forwarded without recycling words from the previous turn", () => {
  const recognition = recognitionStream();
  recognition.receive({ type: "TurnInfo", event: "EndOfTurn", transcript: "two years", turn_index: 0 });
  recognition.receive({ type: "TurnInfo", event: "EndOfTurn", transcript: "", turn_index: 1 });
  assert.equal(recognition.transcripts.length, 2);
  assert.equal(recognition.transcripts[1].transcript, "");
  assert.equal(recognition.transcripts[1].speechFinal, true);
});

test("invalid turn settings fail before opening a connection", () => {
  for (const [name, values] of [
    ["DEEPGRAM_EOT_THRESHOLD", ["0.49", "1.1", "NaN"]],
    ["DEEPGRAM_EOT_TIMEOUT_MS", ["499", "60001", "1000.5", "Infinity"]],
  ]) {
    for (const value of values) assert.throws(() => recognitionStream({ [name]: value }), new RegExp(name));
  }
  assert.throws(() => recognitionStream({ DEEPGRAM_API_KEY: "" }), /DEEPGRAM_API_KEY is missing/);
});

test("irregular packet sizes preserve every byte and closing flushes the remainder", () => {
  const recognition = recognitionStream();
  recognition.open();
  const packets = [Buffer.alloc(111, 1), Buffer.alloc(1400, 2), Buffer.alloc(73, 3)];
  packets.forEach(recognition.stream.sendAudio);
  assert.deepEqual(recognition.socket.sent.map((buffer) => buffer.length), [640, 640]);
  recognition.stream.close();
  assert.deepEqual(recognition.socket.sent.map((buffer) => buffer.length), [640, 640, 304]);
  assert.deepEqual(Buffer.concat(recognition.socket.sent), Buffer.concat(packets));
  recognition.stream.sendAudio(Buffer.alloc(640));
  recognition.stream.close();
  assert.equal(recognition.socket.sent.length, 3);
});

test("only EndOfTurn finalizes a cumulative Flux transcript, including after speech resumes", () => {
  const recognition = recognitionStream();
  for (const [event, transcript] of [
    ["StartOfTurn", "Yes"], ["Update", "Yes, two"],
    ["EagerEndOfTurn", "Yes, two years."], ["TurnResumed", "Yes, two years, actually"],
    ["Update", "Yes, two years, actually three years."],
    ["EndOfTurn", "Yes, two years, actually three years."],
  ]) {
    recognition.receive({ type: "TurnInfo", event, transcript, turn_index: 0 });
  }
  assert.equal(recognition.transcripts.length, 6);
  for (const result of recognition.transcripts.slice(0, -1)) {
    assert.equal(result.isFinal, false);
    assert.equal(result.speechFinal, false);
    assert.equal(result.utteranceEnd, false);
  }
  const final = recognition.transcripts.at(-1);
  assert.equal(final.transcript, "Yes, two years, actually three years.");
  assert.equal(final.isFinal, true);
  assert.equal(final.speechFinal, true);
  assert.equal(final.utteranceEnd, true);
  assert.equal(final.raw.turn_index, 0);
});

test("duplicate completed turns are ignored while identical answers in new turns are retained", () => {
  const recognition = recognitionStream();
  for (const turn_index of [0, 0, 1, 0, 1]) {
    recognition.receive({ type: "TurnInfo", event: "EndOfTurn", transcript: "Yes.", turn_index });
  }
  recognition.receive({ type: "TurnInfo", event: "Update", transcript: "Yes.", turn_index: 1 });
  assert.equal(recognition.transcripts.length, 2);
  assert.deepEqual(recognition.transcripts.map((result) => result.raw.turn_index), [0, 1]);
});

test("non-transcript messages are ignored and Flux errors reach the caller", () => {
  const recognition = recognitionStream();
  recognition.receive({ type: "Connected", sequence_id: 0 });
  recognition.receive({ type: "ConfigureSuccess" });
  recognition.receive({ type: "TurnInfo", event: "StartOfTurn", transcript: "", turn_index: 0 });
  recognition.socket.emit("message", Buffer.from("invalid JSON"));
  recognition.receive({ type: "Error", code: "INVALID_AUDIO", description: "Invalid audio format" });
  assert.equal(recognition.transcripts.length, 1);
  assert.equal(recognition.transcripts[0].raw.event, "StartOfTurn");
  assert.equal(recognition.transcripts[0].speechFinal, false);
  assert.equal(recognition.errors.length, 1);
  assert.equal(recognition.errors[0].code, "INVALID_AUDIO");
  assert.equal(recognition.errors[0].message, "Invalid audio format");
  const socketError = new Error("Connection failed");
  recognition.socket.emit("error", socketError);
  assert.equal(recognition.errors[1], socketError);
  recognition.stream.close();
  recognition.receive({ type: "TurnInfo", event: "EndOfTurn", transcript: "late answer", turn_index: 0 });
  assert.equal(recognition.transcripts.length, 1);
});

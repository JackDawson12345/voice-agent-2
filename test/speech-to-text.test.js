const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");

function recognitionStream(env = {}, keyterms = []) {
  let socket;
  const transcripts = [];
  const warnings = [];
  class WebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    constructor(url) {
      super();
      this.url = url;
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
    console: { log() {}, error() {}, warn: (message) => warnings.push(message) },
  });
  const stream = module.exports.createSpeechToTextStream({
    onTranscript: (result) => transcripts.push(result), keyterms,
  });
  return { socket, stream, transcripts, warnings, open() {
    socket.readyState = WebSocket.OPEN;
    socket.emit("open");
  } };
}

test("recognition uses a longer pause and individually encoded terminology hints", () => {
  const recognition = recognitionStream({ DEEPGRAM_KEYTERMS: "Whinfell Drive,Normanby,years" }, ["Example & Sons", "Middlesbrough"]);
  const params = new URL(recognition.socket.url).searchParams;
  assert.equal(params.get("encoding"), "mulaw");
  assert.equal(params.get("sample_rate"), "8000");
  assert.equal(params.get("language"), "en-GB");
  assert.equal(params.get("model"), "nova-3");
  assert.equal(params.get("endpointing"), "600");
  assert.equal(params.get("utterance_end_ms"), "1000");
  const hints = params.getAll("keyterm");
  for (const term of ["years", "months", "Whinfell Drive", "Normanby", "Example & Sons", "Middlesbrough"]) {
    assert.ok(hints.includes(term), term);
  }
  assert.equal(hints.filter((term) => term === "years").length, 1);
});

test("configured speech timing overrides are respected", () => {
  const recognition = recognitionStream({ DEEPGRAM_ENDPOINTING_MS: "750", DEEPGRAM_UTTERANCE_END_MS: "1500" });
  const params = new URL(recognition.socket.url).searchParams;
  assert.equal(params.get("endpointing"), "750");
  assert.equal(params.get("utterance_end_ms"), "1500");
});

test("audio received while connecting is sent in order instead of losing the first words", () => {
  const recognition = recognitionStream();
  const first = Buffer.from("first");
  const second = Buffer.from("second");
  recognition.stream.sendAudio(first);
  recognition.stream.sendAudio(second);
  assert.equal(recognition.socket.sent.length, 0);
  recognition.open();
  recognition.stream.sendAudio(Buffer.from("third"));
  assert.deepEqual(recognition.socket.sent.map((buffer) => buffer.toString()), ["first", "second", "third"]);
});

test("startup audio is bounded and closing clears queued audio", () => {
  const recognition = recognitionStream();
  for (let i = 0; i < 8; i += 1) recognition.stream.sendAudio(Buffer.alloc(8000));
  assert.equal(recognition.warnings.length, 1);
  recognition.open();
  assert.equal(recognition.socket.sent.length, 5);
  const closed = recognitionStream();
  closed.stream.sendAudio(Buffer.from("queued"));
  closed.stream.close();
  closed.open();
  assert.equal(closed.socket.sent.length, 0);
});

test("empty end-of-speech results reach the server so buffered words can be completed", () => {
  const recognition = recognitionStream();
  recognition.socket.emit("message", Buffer.from(JSON.stringify({
    type: "Results", is_final: true, speech_final: false,
    channel: { alternatives: [{ transcript: "two years" }] },
  })));
  recognition.socket.emit("message", Buffer.from(JSON.stringify({
    type: "Results", is_final: true, speech_final: true,
    channel: { alternatives: [{ transcript: "" }] },
  })));
  assert.equal(recognition.transcripts.length, 2);
  assert.equal(recognition.transcripts[1].transcript, "");
  assert.equal(recognition.transcripts[1].speechFinal, true);
});

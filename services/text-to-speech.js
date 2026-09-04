// services/text-to-speech.js

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

const ELEVENLABS_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";

const ELEVENLABS_MODEL =
  process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";
const ELEVENLABS_OPTIMIZE_STREAMING_LATENCY = Number(
  process.env.ELEVENLABS_OPTIMIZE_STREAMING_LATENCY || 1
);

const ELEVENLABS_STABILITY = Number(process.env.ELEVENLABS_STABILITY || 0.35);
const ELEVENLABS_SIMILARITY_BOOST = Number(
  process.env.ELEVENLABS_SIMILARITY_BOOST || 0.75
);
const ELEVENLABS_STYLE = Number(process.env.ELEVENLABS_STYLE || 0.15);
const ELEVENLABS_USE_SPEAKER_BOOST =
  process.env.ELEVENLABS_USE_SPEAKER_BOOST !== "false";

function formatDigitsForSpeech(value) {
  const cleaned = String(value || "").replace(/\s+/g, "");

  return cleaned
    .replace(/^\+/, "plus ")
    .split("")
    .join(" ");
}

function formatPostcodeForSpeech(value) {
  const cleaned = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");

  if (!/^[A-Z]{2,4}\d[A-Z\d]{2,4}$|^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(cleaned)) {
    return value;
  }

  if (cleaned.length <= 4) {
    return cleaned.split("").join(" ");
  }

  const outward = cleaned.slice(0, -3).split("").join(" ");
  const inward = cleaned.slice(-3).split("").join(" ");

  return `${outward}, ${inward}`;
}

function prepareTextForSpeech(text) {
  return String(text || "")
    .replace(/\b118(?=\s+online\b)/gi, "1 1 8")
    .replace(
      /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/gi,
      (match) => formatPostcodeForSpeech(match)
    )
    .replace(
      /(?<!\w)(\+?\d(?:[\s-]?\d){6,})(?!\w)/g,
      (match) => formatDigitsForSpeech(match)
    )
    .replace(/\s+/g, " ")
    .trim();
}

async function textToSpeech(text) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY is missing from .env");
  }

  if (!text || !text.trim()) {
    return null;
  }

  const preparedText = prepareTextForSpeech(text);

  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}` +
    `?output_format=ulaw_8000` +
    `&optimize_streaming_latency=${ELEVENLABS_OPTIMIZE_STREAMING_LATENCY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mulaw",
    },
    body: JSON.stringify({
      text: preparedText,
      model_id: ELEVENLABS_MODEL,
      voice_settings: {
        stability: ELEVENLABS_STABILITY,
        similarity_boost: ELEVENLABS_SIMILARITY_BOOST,
        style: ELEVENLABS_STYLE,
        use_speaker_boost: ELEVENLABS_USE_SPEAKER_BOOST,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `ElevenLabs error: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();

  return Buffer.from(arrayBuffer);
}

module.exports = {
  textToSpeech,
};

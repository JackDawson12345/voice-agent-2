// services/text-to-speech.js

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

const ELEVENLABS_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";

const ELEVENLABS_MODEL =
  process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";

const ELEVENLABS_STABILITY = Number(process.env.ELEVENLABS_STABILITY || 0.35);
const ELEVENLABS_SIMILARITY_BOOST = Number(
  process.env.ELEVENLABS_SIMILARITY_BOOST || 0.75
);
const ELEVENLABS_STYLE = Number(process.env.ELEVENLABS_STYLE || 0.15);
const ELEVENLABS_USE_SPEAKER_BOOST =
  process.env.ELEVENLABS_USE_SPEAKER_BOOST !== "false";

async function textToSpeech(text) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY is missing from .env");
  }

  if (!text || !text.trim()) {
    return null;
  }

  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}` +
    `?output_format=ulaw_8000` +
    `&optimize_streaming_latency=3`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mulaw",
    },
    body: JSON.stringify({
      text: text.trim(),
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

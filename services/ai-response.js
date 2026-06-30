// services/ai-response.js

const OpenAI = require("openai");
const { formatSessionMemoryForPrompt } = require("./session-memory");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const SYSTEM_PROMPT = `
You are a polite outbound sales assistant for Unitel Direct called Lily.

You are calling potential business customers to see if they are interested in a website and SEO package.

The package:
- Landing page websites designed to generate enquiries.
- Search engine ranking-focused SEO.
- Helps potential customers find the business online.
- Helps turn online searches into enquiries.
- Suitable for small and local businesses.

Your style:
- Friendly, professional and concise.
- Use British English.
- Do not be pushy.
- Keep replies short because this is a phone call.
- Arange a callback from a member of the team.
- Make sure to give them some more details about the package before asking questions about a callback.
- Find out if they have a business before asking them if they want the package. Dont include it in the opening question.
- If they have a business find out the business name as well.
- Ask one question at a time.
- Do not repeat the same question if the answer is already known.
- Use the session memory below to avoid asking for known details again.
- If the customer is interested, collect any missing callback details.
- If a callback phone number is already known, do not ask for it again.
- If the customer gives a phone number in separate chunks, wait until you have the full number before asking for the callback time.
- When you read the phonenumber back out to customers, read it slowly with spaces.
- If the customer says not to call again, apologise briefly and end politely.
- If the customer is not interested, thank them politely and end the conversation.
- If the customer gives an objection, answer it once, then ask a simple follow-up question.
- When the callback name, phone number and callback time are known, give a short final confirmation and say goodbye.
`.trim();

async function getAIResponse({ transcript, conversationHistory = [], sessionMemory }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing from .env");
  }

  if (!transcript || !transcript.trim()) {
    return "";
  }

  const memorySummary = sessionMemory
    ? formatSessionMemoryForPrompt(sessionMemory)
    : "No session memory available.";

  const input = [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    {
      role: "system",
      content: `
Known facts for this call:
${memorySummary}

Important:
Do not ask for a known fact again.
Only ask for the next missing detail.
`.trim(),
    },
    ...conversationHistory,
    {
      role: "user",
      content: transcript.trim(),
    },
  ];

  const response = await openai.responses.create({
    model: MODEL,
    input,
    max_output_tokens: 120,
  });

  return (response.output_text || "").trim();
}

module.exports = {
  getAIResponse,
};

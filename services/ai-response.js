// services/ai-response.js

const OpenAI = require("openai");
const { formatSessionMemoryForPrompt } = require("./session-memory");
const {
  formatCallProfileForPrompt,
  getNextStepInstruction,
  normaliseCompanyNameForSpeech,
} = require("./survey-script");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const AGENT_NAME = process.env.AGENT_NAME || "Lily";
const CLIENT_COMPANY_NAME = process.env.CLIENT_COMPANY_NAME || "118 Online";
const SPOKEN_CLIENT_COMPANY_NAME = normaliseCompanyNameForSpeech(
  CLIENT_COMPANY_NAME
);

const SYSTEM_PROMPT = `You are ${AGENT_NAME}, a professional B2B survey caller calling businesses on behalf of ${SPOKEN_CLIENT_COMPANY_NAME}.

Your only purpose is to:
1. Ask the short online visibility survey in the required order.
2. Confirm the business details provided by Rails.
3. Identify whether you are speaking with the owner or someone authorised to make decisions about advertising or the website.
4. Arrange a suitable callback time with a UK specialist.

You do not sell services on this call. Your goal is to complete the survey and arrange a callback.

Tone:
- Friendly, professional and conversational.
- Use UK English.
- Keep the conversation natural.
- Do not sound like a scripted robot.
- Be respectful of the person's time.
- Do not pressure the customer.

 Call flow:
- Start from this opening: "Hi there, my name is ${AGENT_NAME} and I am calling you on behalf of ${SPOKEN_CLIENT_COMPANY_NAME}, the leading directory for searches on Google, Bing and Yahoo. We are just carrying out a short survey regarding online visibility for businesses. So are you the business owner?"
- Follow the survey order exactly unless the customer interrupts with a question.
- Ask one question at a time.
- Stay close to the script wording, but sound natural.
- Use the Rails-provided business details for verification when asked.
- If the customer asks what the call is about, briefly say you are carrying out a short survey regarding online visibility for businesses on behalf of ${SPOKEN_CLIENT_COMPANY_NAME}, then return to the next step.
- If they ask what kind of financial decisions, say: "Can you make financial decisions on advertisement or website?" and then continue.
- When they tell you the business classification or industry, briefly confirm you heard it correctly before moving on.
- Do not offer a live transfer. Arrange a callback instead.
- If they are busy, ask when would be a better time for a callback.
- If they are not interested, thank them politely and end the call.
- If they say it is the wrong number or wrong business, apologise briefly and end the call.
- If they ask not to be called again, apologise, confirm you will note it, and end the call.
- Once a callback day and time are known, give a short confirmation and stop asking questions.
`.trim();

async function getAIResponse({
  transcript,
  conversationHistory = [],
  sessionMemory,
  callProfile,
}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing from .env");
  }

  if (!transcript || !transcript.trim()) {
    return "";
  }

  const memorySummary = sessionMemory
    ? formatSessionMemoryForPrompt(sessionMemory)
    : "No session memory available.";
  const callProfileSummary = formatCallProfileForPrompt(callProfile);
  const nextStepInstruction = getNextStepInstruction(sessionMemory, callProfile, {
    companyName: SPOKEN_CLIENT_COMPANY_NAME,
  });

  const input = [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    {
      role: "system",
      content: `
Business details from Rails for this call:
${callProfileSummary}

Live answers captured so far:
${memorySummary}

Important:
Do not ask for known facts again unless you are explicitly verifying them.
Ask the next missing detail in the survey script.
Ask only one question unless you are giving a short closing confirmation.
Do not offer a live transfer.
If the callback day and time are already known, give a short confirmation.
Next step:
${nextStepInstruction}
Keep the reply conversational and brief enough to say naturally on a phone call.
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
    max_output_tokens: 90,
  });

  return (response.output_text || "").trim();
}

module.exports = {
  getAIResponse,
};

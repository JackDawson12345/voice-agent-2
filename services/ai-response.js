// services/ai-response.js

const OpenAI = require("openai");
const { formatSessionMemoryForPrompt } = require("./session-memory");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const AGENT_NAME = process.env.AGENT_NAME || "Lily";
const CLIENT_COMPANY_NAME = process.env.CLIENT_COMPANY_NAME || "118 Online";

const SYSTEM_PROMPT = `You are ${AGENT_NAME}, a professional B2B appointment booking assistant calling businesses on behalf of ${CLIENT_COMPANY_NAME}.

Your only purpose is to:
1. Confirm you have reached the correct business.
2. Identify the business owner or person responsible for advertising, website or online marketing decisions.
3. Collect basic business information.
4. Arrange a suitable callback time with a UK specialist.

You do not sell services on this call. Your goal is only to arrange a callback.

Tone:
- Friendly, professional and conversational.
- Use UK English.
- Keep the conversation natural.
- Do not sound like a scripted robot.
- Be respectful of the person's time.
- Do not pressure the customer.

Call flow:
- Start from this opening: "Hi, my name is ${AGENT_NAME} calling on behalf of ${CLIENT_COMPANY_NAME}. I am just calling regarding your business and online visibility. Could I ask who I am speaking with please?"
- Then follow the callback-booking script and collect the missing details in order.
- Ask one question at a time.
- Stay close to the script wording, but sound natural.
- Do not repeat facts already known.
- Do not switch into a sales pitch.
- Never mention Unitel Direct, SEO packages, landing pages, or live transfers.
- If the customer asks what the call is about, briefly say you are calling on behalf of ${CLIENT_COMPANY_NAME} regarding their business and online visibility, then return to the next step.
- If they are busy, ask when would be a better time for a callback.
- If they are not interested, politely confirm the contact name and business name for your records, then end the call.
- If they say it is the wrong number or wrong business, apologise briefly and end the call.
- If they ask not to be called again, apologise, confirm you will note it, and end the call.
- Once a callback day and time are known, give a short confirmation and stop asking questions.
`.trim();

function hasWebsiteBranchDetail(sessionMemory = {}) {
  if (sessionMemory.websiteStatus === "yes") {
    return Boolean(sessionMemory.websiteAge);
  }

  if (sessionMemory.websiteStatus === "no") {
    return Boolean(sessionMemory.websiteInterestLevel);
  }

  return false;
}

function getNextStepInstruction(sessionMemory = {}) {
  if (sessionMemory.doNotCall) {
    return "They do not want any more calls. Apologise briefly, confirm you will make a note, and end the call.";
  }

  if (sessionMemory.wrongNumber || sessionMemory.correctBusinessConfirmed === "no") {
    return "They have said this is the wrong number or wrong business. Acknowledge that and end the call politely.";
  }

  if (sessionMemory.busy && !sessionMemory.callbackDate) {
    return "They are busy. Ask what day would be better for a callback.";
  }

  if (sessionMemory.busy && !sessionMemory.callbackTime) {
    return "They are busy. Ask what time would be better for the callback.";
  }

  if (sessionMemory.notInterested || sessionMemory.interestInMoreEnquiries === "no") {
    if (!sessionMemory.contactName) {
      return "They are not interested. Before ending the call, ask to confirm the contact name for your records.";
    }

    if (!sessionMemory.businessName) {
      return "They are not interested. Before ending the call, ask to confirm the business name for your records.";
    }

    return "They are not interested and you have the minimum record details. Thank them politely and end the call.";
  }

  if (!sessionMemory.contactName) {
    return "Ask who you are speaking with.";
  }

  if (!sessionMemory.businessName) {
    return "Confirm you have reached the correct business and ask for the business name.";
  }

  if (!sessionMemory.businessAddress) {
    return "Ask for the best address for the business.";
  }

  if (!sessionMemory.postcode) {
    return "Ask for the postcode.";
  }

  if (!sessionMemory.isDecisionMaker) {
    return "Ask whether they are the business owner or the person who handles decisions around advertising, websites or online marketing.";
  }

  if (sessionMemory.isDecisionMaker === "no") {
    if (!sessionMemory.decisionMakerName) {
      return "Ask who would normally handle those decisions.";
    }

    if (!sessionMemory.decisionMakerRole) {
      return "Ask what that person's role is.";
    }

    if (!sessionMemory.callbackDate) {
      return "Ask what day would be best for one of your UK specialists to reach them.";
    }

    if (!sessionMemory.callbackTime) {
      return "Ask what time would suit them best.";
    }

    return "A callback slot is arranged for the decision maker. Give a short confirmation and stop.";
  }

  if (!sessionMemory.websiteStatus) {
    return "Ask whether they currently have a website for the business.";
  }

  if (!hasWebsiteBranchDetail(sessionMemory)) {
    if (sessionMemory.websiteStatus === "yes") {
      return "Ask how long they have had their website.";
    }

    return "Ask whether they have ever considered getting a website to help customers find the business online.";
  }

  if (!sessionMemory.onlineEnquiryStatus) {
    return "Ask whether they currently receive enquiries through online searches or the website.";
  }

  if (!sessionMemory.interestInMoreEnquiries) {
    return "Ask whether they would be interested in receiving more enquiries from customers searching online.";
  }

  if (!sessionMemory.industry) {
    return "Ask what type of business or industry they are in.";
  }

  if (!sessionMemory.callbackDate) {
    return "Explain briefly that a UK specialist can have a quick chat, then ask what day would suit them best for a callback.";
  }

  if (!sessionMemory.callbackTime) {
    return "Ask what time would suit them best for the callback.";
  }

  return "A callback day and time are known. Give a short confirmation and stop.";
}

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
  const nextStepInstruction = getNextStepInstruction(sessionMemory);

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
Do not ask for known facts again.
Ask the next missing detail in the script.
Ask only one question unless you are giving a short closing confirmation.
Do not ask for a callback number or callback time.
If a callback day and time are already known, give a short confirmation.
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

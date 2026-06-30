// services/twilio.js

const twilio = require("twilio");

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  APP_PUBLIC_URL,
} = process.env;

function getTwilioClient() {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio account SID or auth token is missing from .env");
  }

  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

async function startOutboundCall(customerPhoneNumber) {
  if (!customerPhoneNumber) {
    throw new Error("Customer phone number is required");
  }

  if (!TWILIO_PHONE_NUMBER) {
    throw new Error("TWILIO_PHONE_NUMBER is missing from .env");
  }

  if (!APP_PUBLIC_URL) {
    throw new Error("APP_PUBLIC_URL is missing from .env");
  }

  const client = getTwilioClient();

  const call = await client.calls.create({
    to: customerPhoneNumber,
    from: TWILIO_PHONE_NUMBER,
    url: `${APP_PUBLIC_URL}/voice`,
  });

  return call;
}

async function endOutboundCall(callSid) {
  if (!callSid) {
    throw new Error("Call SID is required to end the call");
  }

  const client = getTwilioClient();

  const call = await client.calls(callSid).update({
    status: "completed",
  });

  return call;
}

module.exports = {
  startOutboundCall,
  endOutboundCall,
};
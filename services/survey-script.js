const { isCallbackTimeWithinHours, isAnytimeCallbackTime } = require("./callback-time");

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanAddressPart(value) {
  return cleanText(value).replace(/^[,;]+|[,;]+$/g, "").trim();
}

function upperPostcode(value) {
  return cleanText(value).toUpperCase();
}

function startsWithAny(text, prefixes) {
  return prefixes.some((prefix) => text.startsWith(prefix));
}

function normaliseCompanyNameForSpeech(name) {
  const cleanName = cleanText(name);

  if (!cleanName) {
    return cleanName;
  }

  return cleanName.replace(/\b118\b/gi, "1 1 8");
}

function normaliseCallProfile(raw = {}) {
  const customer = raw.customer || {};
  const survey = raw.survey || {};

  return {
    phoneNumberId: raw.phone_number_id || raw.phoneNumberId || null,
    to: cleanText(raw.to),
    customer: {
      title: cleanText(customer.title),
      name: cleanText(customer.name || customer.customer_name),
      businessName: cleanText(customer.business_name || customer.businessName),
      phoneNumber: cleanText(
        customer.phone_number || customer.phoneNumber || raw.to
      ),
      address: cleanAddressPart(customer.address),
      town: cleanAddressPart(customer.town),
      county: cleanAddressPart(customer.county),
      postcode: upperPostcode(customer.postcode),
    },
    survey: {
      status: cleanText(survey.status),
      date: cleanText(survey.date),
      currentWebsite: cleanText(
        survey.current_website || survey.currentWebsite
      ),
      wantsMoreEnquiries: cleanText(
        survey.wants_more_enquiries || survey.wantsMoreEnquiries
      ),
      classification: cleanText(survey.classification),
      owner: cleanText(survey.owner),
    },
  };
}

function formatCustomerAddress(customer = {}) {
  const parts = [customer.address, customer.town, customer.county]
    .map(cleanAddressPart)
    .filter(Boolean)

  return parts
    .filter(
      (part, index) =>
        index === 0 || part.toLowerCase() !== parts[index - 1].toLowerCase()
    )
    .join(", ");
}

function buildIntroMessage({ agentName, companyName }) {
  return `Hi there, my name is ${agentName} and I am calling you on behalf of ${normaliseCompanyNameForSpeech(companyName)}, the leading directory for searches on Google, Bing and Yahoo. We are just carrying out a short survey regarding online visibility for businesses. So are you the business owner?`;
}

function buildFinancialAuthorityClarifier() {
  return "Can you make financial decisions on advertisement or website?";
}

function isFinancialAuthorityPrompt(text = "") {
  const lower = cleanText(text).toLowerCase();

  if (!lower) {
    return false;
  }

  return (
    lower.includes("authorised to make financial decisions") ||
    lower.includes("authorized to make financial decisions") ||
    lower.includes("make financial decisions on behalf of the business") ||
    lower.includes("financial decisions on advertisement or website") ||
    lower.includes("financial decisions on advertising or website") ||
    lower.includes("make those decisions on behalf of the business")
  );
}

function buildAddressVerificationQuestion(customer = {}) {
  const address = formatCustomerAddress(customer);
  const postcode = cleanText(customer.postcode);

  if (address && postcode) {
    return `Can you confirm that your address is ${address} and the postcode is ${postcode}, is that right?`;
  }

  if (address) {
    return `Can you confirm that your address is ${address}, is that right?`;
  }

  if (postcode) {
    return `Can you confirm that the postcode is ${postcode}, is that right?`;
  }

  return "Can you confirm the address for the business?";
}

function buildBusinessVerificationQuestion(customer = {}, fallbackPhoneNumber = "") {
  const businessName = cleanText(customer.businessName);
  const businessNumber = cleanText(customer.phoneNumber || fallbackPhoneNumber);

  if (businessName && businessNumber) {
    return `I have your business name as ${businessName} and the business number as ${businessNumber}, is that right?`;
  }

  if (businessName) {
    return `I have your business name as ${businessName}, is that right?`;
  }

  if (businessNumber) {
    return `I have your business number as ${businessNumber}, is that right?`;
  }

  return "Could you confirm the business name for me?";
}

function callbackConsentQuestion({ companyName }) {
  return `As I mentioned earlier, I am calling on behalf of ${normaliseCompanyNameForSpeech(companyName)}. To thank you for taking part in the survey, one of our UK experts can call you back and provide a no cost basic listing on the largest directories in the UK to help give your business more visibility. Is that OK?`;
}

function buildIndustryConfirmationQuestion(industry) {
  const cleanIndustry = cleanText(industry);

  if (!cleanIndustry) {
    return "I just wanted to check I got that correctly, what classification or industry does your business come under?";
  }

  return `I just wanted to check I got that correctly, was it ${cleanIndustry}?`;
}

function hasWebsiteBranchDetail(memory = {}) {
  if (memory.websiteStatus === "yes") {
    return Boolean(memory.websiteAge);
  }

  if (memory.websiteStatus === "no") {
    return Boolean(memory.websiteInterestLevel);
  }

  return false;
}

function hasSurveyAnswers(memory = {}) {
  return Boolean(
    memory.websiteStatus &&
      hasWebsiteBranchDetail(memory) &&
      memory.onlineEnquiryStatus &&
      memory.interestInMoreEnquiries &&
      memory.industry
  );
}

function hasDeclinedCallback(memory = {}) {
  return memory.callbackConsent === "no" || memory.callbackRequested === false;
}

function hasCallbackSlot(memory = {}) {
  return Boolean(
    !hasDeclinedCallback(memory) && !memory.doNotCall &&
    memory.callbackDate && !memory.pendingCallbackDate &&
    isCallbackTimeWithinHours(memory.callbackTime)
  );
}

function buildCallbackDeclinedMessage() {
  return "No problem, we won't arrange a callback. Thank you for your time. Goodbye.";
}

function buildCallbackConfirmationMessage(memory = {}) {
  const date = cleanText(memory.callbackDate) || "the agreed day";
  const time = cleanText(memory.callbackTime) || "the agreed time";
  const lowerTime = time.toLowerCase();

  let slotText = `${date} at ${time}`;

  if (isAnytimeCallbackTime(time)) {
    slotText = `${date}, anytime between 9am and 5pm`;
  } else if (
    lowerTime === "morning" ||
    lowerTime === "afternoon" ||
    lowerTime === "evening"
  ) {
    slotText = `${date} in the ${lowerTime}`;
  } else if (lowerTime === "lunchtime") {
    slotText = `${date} at lunchtime`;
  } else if (
    startsWithAny(lowerTime, [
      "after ",
      "before ",
      "around ",
      "between ",
      "from ",
      "any time after ",
      "any time before ",
    ])
  ) {
    slotText = `${date} ${lowerTime}`;
  }

  return `Fantastic, thank you. I have arranged the callback for ${slotText}. Please hold onto that for us and we will speak with you then.`;
}

function inferQuestionKeyFromAssistantReply(reply = "") {
  const lower = cleanText(reply).toLowerCase();

  if (!lower) {
    return null;
  }

  if (
    lower.includes("who i am speaking with") ||
    lower.includes("who am i speaking with") ||
    lower.includes("how should i address you") ||
    lower.includes("how can i address you") ||
    lower.includes("what should i call you")
  ) {
    return "contact_name";
  }

  if (lower.includes("are you the business owner")) {
    return "owner_status";
  }

  if (isFinancialAuthorityPrompt(lower)) {
    return "financial_authority";
  }

  if (lower.includes("updated address is")) {
    return "address_correction_confirmation";
  }

  if (lower.includes("updated business name is")) {
    return "business_details_correction_confirmation";
  }

  if (
    lower.includes("correct address for the business") ||
    lower.includes("confirm the address for the business")
  ) {
    return "business_address";
  }

  if (lower.includes("postcode for that address")) {
    return "postcode";
  }

  if (
    lower.includes("correct business name") ||
    lower.includes("confirm the business name for me")
  ) {
    return "business_name";
  }

  if (lower.includes("correct phone number for the business")) {
    return "business_phone";
  }

  if (
    lower.includes("confirm that your address is") ||
    lower.includes("confirm your address is") ||
    lower.includes("confirm that the postcode is")
  ) {
    return "address_confirmation";
  }

  if (
    lower.includes("business name as") ||
    lower.includes("business number as") ||
    lower.includes("business number")
  ) {
    return "business_details_confirmation";
  }

  if (lower.includes("currently have a website")) {
    return "website_status";
  }

  if (lower.includes("did you say you've had the website for")) {
    return "website_age_confirmation";
  }

  if (
    lower.includes("how long have you had the website") ||
    lower.includes("how long have you had your website") ||
    lower.includes("how many months or years have you had the website")
  ) {
    return "website_age";
  }

  if (lower.includes("considered getting a website")) {
    return "website_interest";
  }

  if (lower.includes("get enquiries online from new customers")) {
    return "online_enquiries";
  }

  if (lower.includes("like to get enquiries or more enquiries online")) {
    return "more_enquiries";
  }

  if (lower.includes("classification or industry")) {
    return "industry";
  }

  if (
    lower.includes("i just wanted to check i got that correctly") &&
    lower.includes("was it")
  ) {
    return "industry_confirmation";
  }

  if (
    lower.includes("to thank you for taking part in the survey") ||
    lower.includes("no cost basic listing") ||
    lower.includes("would you like us to call back")
  ) {
    return "callback_consent";
  }

  if (lower.includes("what day would suit") || lower.includes("what day would be better")) {
    return "callback_day";
  }

  if (lower.includes("did you say") && lower.includes("for the callback")) {
    return "callback_day_confirmation";
  }

  if (lower.includes("what time would suit")) {
    return "callback_time";
  }

  return null;
}

function getScriptedNextQuestion(
  memory = {},
  callProfile = {},
  options = {}
) {
  const customer = callProfile.customer || {};
  const fallbackPhoneNumber = customer.phoneNumber || callProfile.to || "";
  const companyName = options.companyName || "118 Online";
  const addressStepComplete = Boolean(
    memory.addressConfirmed === "yes" ||
      memory.addressCorrectionConfirmed
  );
  const businessDetailsStepComplete = Boolean(
    memory.businessDetailsConfirmed === "yes" ||
      memory.businessDetailsCorrectionConfirmed
  );

  if (memory.doNotCall || memory.wrongNumber || hasDeclinedCallback(memory)) {
    return null;
  }

  if (memory.pendingCallbackDate) {
    return `Did you say ${memory.pendingCallbackDate} for the callback?`;
  }

  if (memory.callbackDateNeedsClarification && !memory.callbackDate) {
    return "Sorry, what day would suit you best for the callback? Please say the day, such as this Friday or next Monday.";
  }

  if (memory.callbackTimeNeedsClarification) {
    if (memory.pendingCallbackMeridiem) {
      return `Sorry, I only caught ${memory.pendingCallbackMeridiem.toUpperCase()}. What time would suit you best? Please say the hour as well, or say anytime between 9am and 5pm.`;
    }
    return "Please choose a specific time between 9am and 5pm, or say anytime. What time would suit you best?";
  }

  if (memory.busy) {
    if (!memory.callbackDate) {
      return "No problem at all. What day would be better for us to call you back?";
    }

    if (!isCallbackTimeWithinHours(memory.callbackTime)) {
      return "And what time would suit you best for the callback, between 9am and 5pm?";
    }

    return null;
  }

  if (!memory.isBusinessOwner) {
    return "So are you the business owner?";
  }

  if (memory.isBusinessOwner === "no" && !memory.authorisedDecisionMaker) {
    return "So are you authorised to make financial decisions on behalf of the business?";
  }

  if (memory.isDecisionMaker === "no") {
    if (!memory.callbackConsent && memory.callbackRequested !== true) {
      return "No problem. Would you like us to call back when the owner or the person who handles advertising or website decisions is available?";
    }

    if (!memory.callbackDate) {
      return "What day would suit best for that callback?";
    }

    if (!isCallbackTimeWithinHours(memory.callbackTime)) {
      return "And what time would suit you best, between 9am and 5pm?";
    }

    return null;
  }

  if (!addressStepComplete) {
    if (memory.addressConfirmed === "no" || memory.businessAddress || memory.postcode) {
      if (!memory.businessAddress) {
        return "Could you confirm the correct address for the business?";
      }

      if (!memory.postcode) {
        return "And what is the postcode for that address?";
      }

      return `Just to confirm, the updated address is ${memory.businessAddress} and the postcode is ${memory.postcode}, is that right?`;
    }

    return buildAddressVerificationQuestion(customer);
  }

  if (!businessDetailsStepComplete) {
    if (memory.businessDetailsConfirmed === "no" || memory.businessName) {
      if (!memory.businessName) {
        return "Could you confirm the correct business name?";
      }

      if (!memory.phoneNumber) {
        return "And what is the correct phone number for the business?";
      }

      return `Just to confirm, the updated business name is ${memory.businessName} and the phone number is ${memory.phoneNumber}, is that right?`;
    }

    return buildBusinessVerificationQuestion(customer, fallbackPhoneNumber);
  }

  if (!memory.contactName) {
    return "And how should I address you over the call?";
  }

  if (!memory.websiteStatus) {
    return "Do you currently have a website?";
  }

  if (memory.websiteStatus === "yes" && !memory.websiteAge) {
    if (memory.pendingWebsiteAge) {
      return `Did you say you've had the website for ${memory.pendingWebsiteAge}?`;
    }

    if (memory.websiteAgeNeedsClarification) {
      return "Sorry, how many months or years have you had the website?";
    }

    return "How long have you had the website for?";
  }

  if (memory.websiteStatus === "no" && !memory.websiteInterestLevel) {
    return "Have you ever considered getting a website for your business?";
  }

  if (!memory.onlineEnquiryStatus) {
    if (memory.onlineEnquiryNeedsClarification) {
      return "Sorry, do you get enquiries online from new customers? You can say yes, no, or sometimes.";
    }
    return "Do you get enquiries online from new customers?";
  }

  if (!memory.interestInMoreEnquiries) {
    return "Would you like to get enquiries or more enquiries online?";
  }

  if (memory.pendingIndustry && !memory.industry) {
    return buildIndustryConfirmationQuestion(memory.pendingIndustry);
  }

  if (!memory.industry) {
    return "What classification or industry does your business come under?";
  }

  if (!memory.callbackConsent) {
    return callbackConsentQuestion({ companyName });
  }

  if (!memory.callbackDate) {
    return "Fantastic. What day would suit you best for the callback?";
  }

  if (!isCallbackTimeWithinHours(memory.callbackTime)) {
    return "And what time would suit you best, between 9am and 5pm?";
  }

  return null;
}

function getNextStepInstruction(
  memory = {},
  callProfile = {},
  options = {}
) {
  if (memory.doNotCall) {
    return "They asked not to be called again. Apologise briefly, confirm you will note it, and end the call.";
  }

  if (memory.wrongNumber || memory.correctBusinessConfirmed === "no") {
    return "They said this is the wrong business or wrong number. Apologise briefly and end the call.";
  }

  if (hasDeclinedCallback(memory)) {
    return `They declined a callback. Say "${buildCallbackDeclinedMessage()}" and end the call. Do not ask for a callback day or time or offer another callback.`;
  }

  if (hasCallbackSlot(memory) && !memory.callbackConfirmed) {
    return "Confirm the callback day and time briefly, thank them, and finish the call.";
  }

  if (memory.notInterested) {
    return "They are not interested. Thank them politely and finish the call unless they are giving you a callback time.";
  }

  const scriptedQuestion = getScriptedNextQuestion(memory, callProfile, options);

  if (scriptedQuestion) {
    return `Ask this next question and only this question: "${scriptedQuestion}"`;
  }

  return "Give a short polite closing line and end the call.";
}

function formatCallProfileForPrompt(callProfile = {}) {
  const customer = callProfile.customer || {};
  const survey = callProfile.survey || {};
  const customerAddress = formatCustomerAddress(customer) || "Unknown";

  return [
    `Customer title from Rails: ${cleanText(customer.title) || "Unknown"}`,
    `Customer name from Rails: ${cleanText(customer.name) || "Unknown"}`,
    `Business name from Rails: ${cleanText(customer.businessName) || "Unknown"}`,
    `Business phone from Rails: ${cleanText(customer.phoneNumber || callProfile.to) || "Unknown"}`,
    `Business address from Rails: ${customerAddress}`,
    `Business postcode from Rails: ${cleanText(customer.postcode) || "Unknown"}`,
    `Historic survey status from Rails: ${cleanText(survey.status) || "Unknown"}`,
    `Historic website value from Rails: ${cleanText(survey.currentWebsite) || "Unknown"}`,
    `Historic wants more enquiries value from Rails: ${cleanText(survey.wantsMoreEnquiries) || "Unknown"}`,
    `Historic classification from Rails: ${cleanText(survey.classification) || "Unknown"}`,
    `Historic owner value from Rails: ${cleanText(survey.owner) || "Unknown"}`,
  ].join("\n");
}

module.exports = {
  buildAddressVerificationQuestion,
  buildBusinessVerificationQuestion,
  buildCallbackConfirmationMessage,
  buildCallbackDeclinedMessage,
  buildFinancialAuthorityClarifier,
  buildIndustryConfirmationQuestion,
  buildIntroMessage,
  callbackConsentQuestion,
  formatCallProfileForPrompt,
  formatCustomerAddress,
  getNextStepInstruction,
  getScriptedNextQuestion,
  hasCallbackSlot,
  hasDeclinedCallback,
  hasSurveyAnswers,
  hasWebsiteBranchDetail,
  inferQuestionKeyFromAssistantReply,
  isFinancialAuthorityPrompt,
  normaliseCallProfile,
  normaliseCompanyNameForSpeech,
};

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function upperPostcode(value) {
  return cleanText(value).toUpperCase();
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
      address: cleanText(customer.address),
      town: cleanText(customer.town),
      county: cleanText(customer.county),
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
  return [customer.address, customer.town, customer.county]
    .map(cleanText)
    .filter(Boolean)
    .join(", ");
}

function buildIntroMessage({ agentName, companyName }) {
  return `Hi there, my name is ${agentName} and I am calling you on behalf of ${companyName}, the leading directory for searches on Google, Bing and Yahoo. We are just carrying out a short survey regarding online visibility for businesses. So are you the business owner?`;
}

function buildFinancialAuthorityClarifier() {
  return "Can you make financial decisions on advertisement or website?";
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
  return `As I mentioned earlier, I am calling on behalf of ${companyName}. To thank you for taking part in the survey, one of our UK experts can call you back and provide a no cost basic listing on the largest directories in the UK to help give your business more visibility. Is that OK?`;
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

function hasCallbackSlot(memory = {}) {
  return Boolean(memory.callbackDate && memory.callbackTime);
}

function buildCallbackConfirmationMessage(memory = {}) {
  const date = cleanText(memory.callbackDate) || "the agreed day";
  const time = cleanText(memory.callbackTime) || "the agreed time";
  const lowerTime = time.toLowerCase();

  let slotText = `${date} at ${time}`;

  if (
    lowerTime === "morning" ||
    lowerTime === "afternoon" ||
    lowerTime === "evening"
  ) {
    slotText = `${date} in the ${lowerTime}`;
  } else if (lowerTime === "lunchtime") {
    slotText = `${date} at lunchtime`;
  }

  return `Fantastic, thank you. I have arranged the callback for ${slotText}. Please hold onto that for us and we will speak with you then.`;
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
      (memory.businessAddress && memory.postcode)
  );
  const businessDetailsStepComplete = Boolean(
    memory.businessDetailsConfirmed === "yes" ||
      (memory.businessName && (memory.phoneNumber || fallbackPhoneNumber))
  );

  if (memory.doNotCall || memory.wrongNumber) {
    return null;
  }

  if (memory.busy) {
    if (!memory.callbackDate) {
      return "No problem at all. What day would be better for us to call you back?";
    }

    if (!memory.callbackTime) {
      return "And what time would suit you best for the callback?";
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
    if (!memory.callbackDate) {
      return "No problem. Could we give you a call back when the owner or the person who handles advertising or website decisions is available? What day would suit best?";
    }

    if (!memory.callbackTime) {
      return "And what time would suit best?";
    }

    return null;
  }

  if (!addressStepComplete) {
    return buildAddressVerificationQuestion(customer);
  }

  if (!businessDetailsStepComplete) {
    return buildBusinessVerificationQuestion(customer, fallbackPhoneNumber);
  }

  if (!memory.contactName) {
    return "And how should I address you over the call?";
  }

  if (!memory.websiteStatus) {
    return "Do you currently have a website?";
  }

  if (memory.websiteStatus === "yes" && !memory.websiteAge) {
    return "How long have you had the website for?";
  }

  if (memory.websiteStatus === "no" && !memory.websiteInterestLevel) {
    return "Have you ever considered getting a website for your business?";
  }

  if (!memory.onlineEnquiryStatus) {
    return "Do you get enquiries online from new customers?";
  }

  if (!memory.interestInMoreEnquiries) {
    return "Would you like to get enquiries or more enquiries online?";
  }

  if (!memory.industry) {
    return "What classification or industry does your business come under?";
  }

  if (!memory.callbackConsent) {
    return callbackConsentQuestion({ companyName });
  }

  if (!memory.callbackDate) {
    if (memory.callbackConsent === "no") {
      return "No problem. Could we give you a call back at a more suitable time? What day would suit you best?";
    }

    return "Fantastic. What day would suit you best for the callback?";
  }

  if (!memory.callbackTime) {
    return "And what time would suit you best?";
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
  buildFinancialAuthorityClarifier,
  buildIntroMessage,
  callbackConsentQuestion,
  formatCallProfileForPrompt,
  formatCustomerAddress,
  getNextStepInstruction,
  getScriptedNextQuestion,
  hasCallbackSlot,
  hasSurveyAnswers,
  hasWebsiteBranchDetail,
  normaliseCallProfile,
};

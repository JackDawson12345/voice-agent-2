// services/session-memory.js

const { formatCustomerAddress } = require("./survey-script");

function createSessionMemory() {
  return {
    contactName: null,
    contactTitle: null,
    correctBusinessConfirmed: null,
    businessDetailsConfirmed: null,
    addressConfirmed: null,
    businessName: null,
    businessAddress: null,
    postcode: null,
    isBusinessOwner: null,
    isDecisionMaker: null,
    authorisedDecisionMaker: null,
    decisionMakerName: null,
    decisionMakerRole: null,
    phoneNumber: null,
    websiteStatus: null,
    websiteAge: null,
    websiteInterestLevel: null,
    onlineEnquiryStatus: null,
    interestInMoreEnquiries: null,
    industry: null,
    callbackConsent: null,
    callbackDate: null,
    callbackTime: null,
    callbackRequested: null,
    callbackConfirmed: false,
    busy: false,
    notInterested: false,
    wrongNumber: false,
    doNotCall: false,
    notes: [],
    lastUpdatedAt: null,
  };
}

function cleanValue(value) {
  return String(value || "")
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compactText(value) {
  return cleanValue(value).toLowerCase();
}

function normaliseSpeechText(value) {
  return cleanValue(value)
    .replace(/[.!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPresenceCheckMessage(text) {
  const lower = compactText(text);

  return (
    lower.includes("are you still there") ||
    lower.includes("still on the line")
  );
}

function getLastAssistantMessage(conversationHistory = [], options = {}) {
  const preferredPromptText = cleanValue(options.preferredPromptText);

  if (preferredPromptText) {
    return preferredPromptText;
  }

  for (let index = conversationHistory.length - 1; index >= 0; index -= 1) {
    const message = conversationHistory[index];

    if (message && message.role === "assistant" && message.content) {
      const content = String(message.content);

      if (
        options.skipGenericPresenceChecks !== false &&
        isPresenceCheckMessage(content)
      ) {
        continue;
      }

      return content;
    }
  }

  return "";
}

function hasAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
}

function isSimpleYes(text) {
  return /^(?:yes|yeah|yep|yeh|sure|okay|ok|correct|that'?s right|that is right|that is correct|it is|fine|go ahead|please do|happy to)[.!?\s]*$/i.test(
    cleanValue(text)
  );
}

function isSimpleNo(text) {
  return /^(?:no|nope|nah|not really|not at the moment|not now|rather not)[.!?\s]*$/i.test(
    cleanValue(text)
  );
}

function isAffirmativeAnswer(text) {
  const lower = compactText(text);

  if (!lower) {
    return false;
  }

  if (isSimpleYes(lower)) {
    return true;
  }

  return /\b(yes|yeah|yep|yeh|sure|okay|ok|correct|that'?s right|that is right|that is correct|go ahead|please do|happy to|i do|we do|i have|we have|it is)\b/i.test(
    lower
  );
}

function isNegativeAnswer(text) {
  const lower = compactText(text);

  if (!lower) {
    return false;
  }

  if (isSimpleNo(lower)) {
    return true;
  }

  return /\b(no|nope|nah|not now|not today|rather not|don'?t|do not|not interested|wrong number)\b/i.test(
    lower
  );
}

function extractAfterPatterns(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);

    if (match && match[1]) {
      const value = cleanValue(match[1]);

      if (value) {
        return value;
      }
    }
  }

  return null;
}

function extractUkPostcode(text) {
  const rawText = String(text || "");
  const match = rawText.match(
    /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i
  );

  if (match) {
    return cleanValue(match[1]).toUpperCase();
  }

  const tokens = stripLeadingPhrase(rawText, [
    /^(?:it is|it's|the postcode is)[,.\s-]+/i,
  ])
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map(normaliseSingleWordToken)
    .filter(Boolean);

  if (tokens.length < 5 || tokens.length > 7) {
    return null;
  }

  return formatUkPostcode(tokens.join(""));
}

function extractWebsiteAddress(text) {
  const match = String(text || "").match(
    /((https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z]{2,}){1,3}(\/[\w\-.~:/?#[\]@!$&'()*+,;=%]*)?)/i
  );

  return match ? cleanValue(match[1]) : null;
}

function stripLeadingPhrase(text, patterns) {
  let value = cleanValue(text);

  for (const pattern of patterns) {
    value = value.replace(pattern, "");
  }

  return cleanValue(value);
}

function extractPersonName(text) {
  const candidate =
    extractAfterPatterns(text, [
      /(?:my name is|this is|i am|i'm)\s+([a-z][a-z .'-]{1,60})$/i,
      /(?:hello|hi|hiya)?[\s,.]*([a-z][a-z .'-]{1,60})\s+(?:speaking|here)$/i,
    ]) || null;

  if (!candidate) {
    return null;
  }

  const lower = compactText(candidate);

  if (
    lower.startsWith("a ") ||
    lower.startsWith("the ") ||
    hasAny(lower, [
      "owner",
      "director",
      "manager",
      "marketing",
      "website",
      "advertising",
      "business owner",
    ])
  ) {
    return null;
  }

  return candidate;
}

function extractBusinessName(text) {
  return (
    extractAfterPatterns(text, [
      /(?:business is called|company is called|business name is|company name is|my business is|my company is|we are called|we're called|it is called|it's called|called)\s+(.{2,100})$/i,
      /(?:the business is|the company is)\s+(.{2,100})$/i,
    ]) || null
  );
}

function normaliseBusinessNameAnswer(text) {
  return stripLeadingPhrase(text, [
    /^(?:yes|yeah|yep|yeh|okay|ok|right|correct)[,.\s-]+/i,
    /^(?:it is|it's|this is)[,.\s-]+/i,
  ]);
}

function normaliseBusinessAddressAnswer(text) {
  return stripLeadingPhrase(text, [
    /^(?:it is|it's|this is)[,.\s-]+/i,
    /^(?:the address is|our address is|we are at|we're at)[,.\s-]+/i,
  ]);
}

function normaliseContactNameAnswer(text) {
  return stripLeadingPhrase(text, [
    /^(?:you can call me|call me|it's|it is|this is|i am|i'm)[,.\s-]+/i,
    /^(?:mr|mrs|ms|miss|dr)\.?\s+/i,
  ]);
}

function normaliseIndustryAnswer(text) {
  return stripLeadingPhrase(text, [
    /^(?:it is|it's|we are|we're)[,.\s-]+/i,
    /^(?:a|an)\s+/i,
  ]);
}

function stripPresenceCheckPrefix(text) {
  let value = cleanValue(text);

  value = value.replace(/^(?:yes|yeah|yep|yeh|hello|hi|okay|ok)[,.\s-]*/i, "");
  value = value.replace(
    /^(?:(?:i am|i'm|we are|we're)\s+)?(?:still here|still there|still on the line|here on the line|on the line)\b[,.\s-]*/i,
    ""
  );

  return cleanValue(value);
}

function normaliseSingleWordToken(token) {
  const lowered = String(token || "").toLowerCase();
  const digitWords = {
    zero: "0",
    oh: "0",
    o: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
  };

  if (digitWords[lowered]) {
    return digitWords[lowered];
  }

  if (/^[a-z]$/i.test(lowered)) {
    return lowered.toUpperCase();
  }

  if (/^\d$/.test(lowered)) {
    return lowered;
  }

  return null;
}

function formatUkPostcode(compactPostcode) {
  const value = String(compactPostcode || "").replace(/\s+/g, "").toUpperCase();

  if (!/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(value)) {
    return null;
  }

  return `${value.slice(0, -3)} ${value.slice(-3)}`;
}

function extractRole(text) {
  return (
    extractAfterPatterns(text, [
      /(?:i am the|i'm the|they are the|they're the|he is the|she is the)\s+(.{2,80})$/i,
      /(?:role is|their role is)\s+(.{2,80})$/i,
    ]) || null
  );
}

function extractPhoneNumber(text) {
  const digits = String(text || "").replace(/[^\d+]/g, "");

  if (digits.length >= 7) {
    return digits;
  }

  return null;
}

function normaliseHonorific(value) {
  const lowered = cleanValue(value).toLowerCase().replace(/\./g, "");
  const mappings = {
    mr: "Mr",
    mrs: "Mrs",
    ms: "Ms",
    miss: "Miss",
    dr: "Dr",
  };

  return mappings[lowered] || null;
}

function extractHonorific(text) {
  const match = String(text || "").match(/\b(mr|mrs|ms|miss|dr)\b\.?/i);

  return match ? normaliseHonorific(match[1]) : null;
}

function extractDuration(text) {
  return (
    extractAfterPatterns(text, [
      /\b(\d+\s*(?:year|years|month|months|week|weeks))\b/i,
      /\b([a-z]+\s+(?:year|years|month|months|week|weeks))\b/i,
      /\b(since\s+\d{4})\b/i,
      /\b(for\s+[a-z0-9 .'-]+\s+(?:year|years|month|months|week|weeks))\b/i,
    ]) || null
  );
}

function extractDateLikeText(text) {
  return (
    extractAfterPatterns(text, [
      /\b((?:next|this)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week))\b/i,
      /\b((?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening))?)\b/i,
      /\b(\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?))\b/i,
      /\b((?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?)\b/i,
      /\b(\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?)\b/i,
    ]) || null
  );
}

function extractTimeLikeText(text) {
  const numberPattern =
    "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d{1,2})";

  return (
    extractAfterPatterns(text, [
      /\b(after lunchtime|after lunch|before lunchtime|before lunch|around lunchtime|around lunch|late morning|early morning|early afternoon|late afternoon)\b/i,
      new RegExp(`\\b(any time after\\s+${numberPattern}(?::\\d{2})?\\s*(?:am|pm)?)\\b`, "i"),
      new RegExp(`\\b(any time before\\s+${numberPattern}(?::\\d{2})?\\s*(?:am|pm)?)\\b`, "i"),
      new RegExp(`\\b(between\\s+${numberPattern}(?::\\d{2})?\\s*(?:am|pm)?\\s+and\\s+${numberPattern}(?::\\d{2})?\\s*(?:am|pm)?)\\b`, "i"),
      new RegExp(`\\b(from\\s+${numberPattern}(?::\\d{2})?\\s*(?:am|pm)?\\s+(?:to|until)\\s+${numberPattern}(?::\\d{2})?\\s*(?:am|pm)?)\\b`, "i"),
      new RegExp(`\\b((?:about|around)\\s+(?:half\\s+past\\s+${numberPattern}|half\\s+${numberPattern}|quarter\\s+(?:past|to)\\s+${numberPattern}|${numberPattern}\\s*o'?clock|${numberPattern}(?::\\d{2})?\\s*(?:am|pm)?))\\b`, "i"),
      new RegExp(`\\b((?:half\\s+past\\s+${numberPattern}|half\\s+${numberPattern}))\\b`, "i"),
      new RegExp(`\\b((?:quarter\\s+(?:past|to)\\s+${numberPattern}))\\b`, "i"),
      new RegExp(`\\b(${numberPattern}\\s*o'?clock)\\b`, "i"),
      new RegExp(`\\b(${numberPattern}(?::\\d{2})?\\s*(?:am|pm))\\b`, "i"),
      /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i,
      /\b((?:morning|afternoon|evening|lunchtime))\b/i,
      new RegExp(`\\b(${numberPattern}:\\d{2})\\b`, "i"),
    ]) || null
  );
}

function inferIndustryFromText(text) {
  const lower = compactText(text);

  if (!lower) {
    return null;
  }

  const mappings = [
    { phrases: ["dog walking", "dog walker", "pet walking"], value: "dog walking" },
    { phrases: ["pet care", "pet sitting", "dog sitting"], value: "pet care" },
    { phrases: ["marketing", "seo", "social media", "digital"], value: "marketing" },
    { phrases: ["telecom", "telecoms", "telecommunications"], value: "telecoms" },
    { phrases: ["plumbing", "plumber"], value: "plumbing" },
    { phrases: ["roofing", "roofer"], value: "roofing" },
    { phrases: ["cleaning", "cleaner"], value: "cleaning" },
    {
      phrases: ["landscaping", "landscape gardener", "gardening"],
      value: "landscaping",
    },
    { phrases: ["building", "builder", "construction"], value: "construction" },
    { phrases: ["electrical", "electrician"], value: "electrical" },
    { phrases: ["carpentry", "carpenter", "joinery"], value: "carpentry" },
    { phrases: ["hair", "barber", "beauty", "salon"], value: "hair and beauty" },
    { phrases: ["restaurant", "cafe", "takeaway"], value: "hospitality" },
  ];

  for (const mapping of mappings) {
    if (mapping.phrases.some((phrase) => lower.includes(phrase))) {
      return mapping.value;
    }
  }

  return null;
}

function looksLikeOnlineEnquiryAnswer(text) {
  const lower = compactText(text);

  return (
    hasAny(lower, [
      "online",
      "search",
      "website",
      "google",
      "enquiries",
      "inquiries",
      "facebook",
      "instagram",
      "leads",
      "messages",
      "contact form",
    ]) ||
    /\b(yes|no|some|none)\b/i.test(lower)
  );
}

function normaliseDecisionMakerRole(text) {
  const lower = compactText(text);

  if (!lower) {
    return null;
  }

  if (hasAny(lower, ["owner", "business owner"])) {
    return "owner";
  }

  if (lower.includes("director")) {
    return "director";
  }

  if (lower.includes("marketing")) {
    return "marketing";
  }

  if (lower.includes("manager")) {
    return "manager";
  }

  if (lower.includes("website")) {
    return "website";
  }

  if (lower.includes("advertising")) {
    return "advertising";
  }

  return extractRole(text);
}

function looksLikeAddressCorrection(text) {
  if (extractUkPostcode(text)) {
    return true;
  }

  const candidate = normaliseBusinessAddressAnswer(text);

  return Boolean(candidate && candidate.split(/\s+/).length >= 3);
}

function looksLikeBusinessDetailCorrection(text) {
  if (extractBusinessName(text) || extractPhoneNumber(text)) {
    return true;
  }

  const candidate = normaliseBusinessNameAnswer(text);

  return Boolean(candidate && candidate.split(/\s+/).length >= 2);
}

function isLowConfidenceIndustry(text) {
  const lower = compactText(text);

  if (!lower) {
    return true;
  }

  const blockedValues = new Set([
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "echo",
    "foxtrot",
    "golf",
    "hotel",
    "india",
    "juliet",
    "juliett",
    "kilo",
    "lima",
    "mike",
    "november",
    "oscar",
    "papa",
    "quebec",
    "romeo",
    "sierra",
    "tango",
    "uniform",
    "victor",
    "whiskey",
    "xray",
    "x-ray",
    "yankee",
    "zulu",
    "yes",
    "no",
    "okay",
    "ok",
    "correct",
    "still here",
  ]);

  if (blockedValues.has(lower)) {
    return true;
  }

  return lower.split(/\s+/).length === 1 && lower.length <= 2;
}

function normaliseCallbackTimeAnswer(text) {
  const candidate = cleanValue(text);
  const lower = compactText(candidate).replace(
    /^(?:about|around|at about|at around|roughly|maybe|probably|say)\s+/,
    ""
  );

  if (!lower) {
    return null;
  }

  const normalisedMappings = new Map([
    ["after lunch", "after lunchtime"],
    ["after lunchtime", "after lunchtime"],
    ["before lunch", "before lunchtime"],
    ["before lunchtime", "before lunchtime"],
    ["around lunch", "around lunchtime"],
    ["around lunchtime", "around lunchtime"],
  ]);

  if (normalisedMappings.has(lower)) {
    return normalisedMappings.get(lower);
  }

  if (/^half\s+\w+$/i.test(lower)) {
    return lower.replace(/^half\s+/, "half past ");
  }

  const extracted = extractTimeLikeText(lower);

  if (!extracted) {
    return null;
  }

  const extractedLower = compactText(extracted).replace(
    /^(?:about|around)\s+/,
    ""
  );

  if (normalisedMappings.has(extractedLower)) {
    return normalisedMappings.get(extractedLower);
  }

  if (/^half\s+\w+$/i.test(extractedLower)) {
    return extractedLower.replace(/^half\s+/, "half past ");
  }

  return cleanValue(extractedLower);
}

function setField(memory, field, value, changedFields) {
  const cleanedValue = typeof value === "string" ? cleanValue(value) : value;

  if (cleanedValue === undefined || cleanedValue === null || cleanedValue === "") {
    return;
  }

  if (memory[field] !== cleanedValue) {
    memory[field] = cleanedValue;
    changedFields.push(field);
  }
}

function pushNote(memory, note, changedFields) {
  const cleanedNote = cleanValue(note);

  if (!cleanedNote) {
    return;
  }

  if (!Array.isArray(memory.notes)) {
    memory.notes = [];
  }

  const duplicate = memory.notes.some(
    (existingNote) => compactText(existingNote) === compactText(cleanedNote)
  );

  if (!duplicate) {
    memory.notes.push(cleanedNote);
    changedFields.push("notes");
  }
}

function shouldStoreRawAnswer(rawText) {
  return Boolean(rawText && !isSimpleYes(rawText) && !isSimpleNo(rawText));
}

function promptMatches(promptKey, expectedKey, fallbackText, patterns) {
  if (promptKey) {
    return promptKey === expectedKey;
  }

  return hasAny(fallbackText, patterns);
}

function updateSessionMemoryFromTranscript(memory, transcript, context = {}) {
  const changedFields = [];
  const rawText = cleanValue(transcript);
  const strippedPresenceText = stripPresenceCheckPrefix(rawText);
  const hasPresencePrefix = strippedPresenceText !== rawText;
  const questionRawText =
    hasPresencePrefix && !strippedPresenceText ? "" : strippedPresenceText || rawText;
  const speechText = normaliseSpeechText(questionRawText || rawText);
  const lower = rawText.toLowerCase();
  const questionLower = questionRawText.toLowerCase();
  const promptKey = cleanValue(context.promptKey).toLowerCase();
  const lastAssistant = getLastAssistantMessage(context.conversationHistory || [], {
    preferredPromptText: context.promptText,
    skipGenericPresenceChecks: true,
  });
  const lastAssistantLower = lastAssistant.toLowerCase();
  const callProfile = context.callProfile || {};
  const callProfileCustomer = callProfile.customer || {};
  const knownBusinessAddressLine = cleanValue(callProfileCustomer.address);
  const knownBusinessAddress = formatCustomerAddress(callProfileCustomer);
  const knownPostcode = cleanValue(callProfileCustomer.postcode);
  const knownBusinessName = cleanValue(callProfileCustomer.businessName);
  const knownBusinessPhone = cleanValue(
    callProfileCustomer.phoneNumber || callProfile.to
  );

  if (!rawText) {
    return { changedFields, memory };
  }

  if (
    hasAny(lower, [
      "do not call",
      "don't call",
      "remove me",
      "take me off",
      "stop calling",
      "never call",
      "not call again",
    ])
  ) {
    setField(memory, "doNotCall", true, changedFields);
    setField(memory, "notInterested", true, changedFields);
  }

  if (
    hasAny(lower, [
      "wrong number",
      "you've got the wrong number",
      "you have the wrong number",
      "wrong business",
      "not this business",
      "not our business",
    ])
  ) {
    setField(memory, "wrongNumber", true, changedFields);
    setField(memory, "correctBusinessConfirmed", "no", changedFields);
  }

  if (
    hasAny(lower, [
      "can't talk",
      "cannot talk",
      "busy right now",
      "in a meeting",
      "call me back",
      "call back later",
      "better time",
      "not a good time",
    ])
  ) {
    setField(memory, "busy", true, changedFields);
    setField(memory, "callbackRequested", true, changedFields);
  }

  if (
    hasAny(lower, [
      "not interested",
      "no thanks",
      "no thank you",
      "not for me",
      "not for us",
      "we're okay",
      "we are okay",
      "we're all good",
      "we are all good",
    ])
  ) {
    setField(memory, "notInterested", true, changedFields);
    setField(memory, "interestInMoreEnquiries", "no", changedFields);
  }

  const assistantAskedContactName = promptMatches(
    promptKey,
    "contact_name",
    lastAssistantLower,
    [
      "who i am speaking with",
      "who am i speaking with",
      "who am i speaking to",
      "who am i speaking with please",
      "how should i address you",
      "how can i address you",
      "what should i call you",
    ]
  );

  const assistantAskedBusinessName = promptMatches(
    promptKey,
    "business_name",
    lastAssistantLower,
    [
      "name of your business",
      "right business",
      "business please",
      "business name",
    ]
  );

  const assistantAskedBusinessAddress = promptMatches(
    promptKey,
    "business_address",
    lastAssistantLower,
    [
      "best address for the business",
      "best address for your business",
      "confirm the best address",
      "business address",
    ]
  );

  const assistantAskedPostcode = promptMatches(
    promptKey,
    "postcode",
    lastAssistantLower,
    [
      "postcode",
      "post code",
    ]
  );

  const assistantAskedDecisionMaker = promptMatches(
    promptKey,
    "decision_maker",
    lastAssistantLower,
    [
      "looks after decisions around advertising",
      "websites or online marketing",
      "responsible for advertising",
    ]
  );

  const assistantAskedOwnerStatus = promptMatches(
    promptKey,
    "owner_status",
    lastAssistantLower,
    [
      "are you the business owner",
    ]
  );

  const assistantAskedFinancialAuthority = promptMatches(
    promptKey,
    "financial_authority",
    lastAssistantLower,
    [
      "authorised to make financial decisions",
      "authorized to make financial decisions",
      "make financial decisions on behalf of the business",
    ]
  );

  const assistantAskedAddressConfirmation = promptMatches(
    promptKey,
    "address_confirmation",
    lastAssistantLower,
    [
      "confirm that your address is",
      "confirm your address is",
      "confirm that the postcode is",
    ]
  );

  const assistantAskedBusinessDetailsConfirmation = promptMatches(
    promptKey,
    "business_details_confirmation",
    lastAssistantLower,
    [
      "business name as",
      "business number as",
      "business number",
    ]
  );

  const assistantAskedDecisionMakerName = promptMatches(
    promptKey,
    "decision_maker_name",
    lastAssistantLower,
    [
      "who would normally handle those decisions",
      "who handles those decisions",
      "who would handle that",
    ]
  );

  const assistantAskedDecisionMakerRole = promptMatches(
    promptKey,
    "decision_maker_role",
    lastAssistantLower,
    [
      "what is their role",
      "what's their role",
      "role at the business",
    ]
  );

  const assistantAskedWebsiteStatus = promptMatches(
    promptKey,
    "website_status",
    lastAssistantLower,
    [
      "currently have a website",
      "have a website for your business",
      "do you currently have a website",
    ]
  );

  const assistantAskedWebsiteAge = promptMatches(
    promptKey,
    "website_age",
    lastAssistantLower,
    [
      "how long have you had your website",
      "how long have you had the website",
    ]
  );

  const assistantAskedWebsiteInterest = promptMatches(
    promptKey,
    "website_interest",
    lastAssistantLower,
    [
      "considered getting a website",
      "help customers find your business online",
      "considered getting a website for your business",
    ]
  );

  const assistantAskedOnlineEnquiries = promptMatches(
    promptKey,
    "online_enquiries",
    lastAssistantLower,
    [
      "receive enquiries",
      "online searches",
      "through online searches or your website",
      "get enquiries online from new customers",
    ]
  );

  const assistantAskedMoreEnquiries = promptMatches(
    promptKey,
    "more_enquiries",
    lastAssistantLower,
    [
      "interested in receiving more enquiries",
      "more enquiries from customers searching online",
      "like to get enquiries or more enquiries online",
    ]
  );

  const assistantAskedIndustry = promptMatches(
    promptKey,
    "industry",
    lastAssistantLower,
    [
      "type of business or industry",
      "what type of business",
      "what industry are you in",
      "classification or industry",
    ]
  );

  const assistantAskedCallbackConsent = promptMatches(
    promptKey,
    "callback_consent",
    lastAssistantLower,
    [
      "to thank you for taking part in the survey",
      "no cost basic listing",
      "is that ok",
      "is that okay",
    ]
  );

  const assistantAskedCallbackDay = promptMatches(
    promptKey,
    "callback_day",
    lastAssistantLower,
    [
      "what day would suit you best",
      "what day would be better",
      "what day would suit them best",
      "what day would suit best",
    ]
  );

  const assistantAskedCallbackTime = promptMatches(
    promptKey,
    "callback_time",
    lastAssistantLower,
    [
      "what time would suit you best",
      "what time would suit them best",
      "what time works best",
      "what time would suit best",
    ]
  );

  const assistantAskedCallbackGeneral = hasAny(lastAssistantLower, [
    "better time for us to call you back",
    "best way and time to reach them",
    "available for a callback",
    "what day and time would suit you best",
  ]);

  const contactName =
    extractPersonName(speechText) || extractPersonName(questionRawText) || null;
  const contactTitle = extractHonorific(questionRawText);

  if (contactName && (!memory.contactName || assistantAskedContactName)) {
    setField(memory, "contactName", contactName, changedFields);
  } else if (assistantAskedContactName && shouldStoreRawAnswer(questionRawText)) {
    setField(
      memory,
      "contactName",
      normaliseContactNameAnswer(questionRawText) || questionRawText,
      changedFields
    );
  }

  if (contactTitle && (!memory.contactTitle || assistantAskedContactName)) {
    setField(memory, "contactTitle", contactTitle, changedFields);
  }

  const businessName =
    extractBusinessName(questionRawText) ||
    (assistantAskedBusinessName && shouldStoreRawAnswer(questionRawText)
      ? normaliseBusinessNameAnswer(questionRawText)
      : null);

  if (businessName && !memory.wrongNumber) {
    setField(memory, "businessName", businessName, changedFields);
    setField(memory, "correctBusinessConfirmed", "yes", changedFields);
  }

  const postcode = extractUkPostcode(questionRawText || rawText);

  if (postcode) {
    setField(memory, "postcode", postcode, changedFields);
  }

  if (assistantAskedAddressConfirmation) {
    if (isNegativeAnswer(questionRawText)) {
      setField(memory, "addressConfirmed", "no", changedFields);

      if (looksLikeAddressCorrection(questionRawText)) {
        if (postcode) {
          setField(memory, "postcode", postcode, changedFields);
        }

        const correctedAddress = normaliseBusinessAddressAnswer(questionRawText);

        if (correctedAddress) {
          setField(memory, "businessAddress", correctedAddress, changedFields);
        }
      } else if (shouldStoreRawAnswer(questionRawText)) {
        pushNote(memory, `Address correction: ${questionRawText}`, changedFields);
      }
    } else if (isAffirmativeAnswer(questionRawText)) {
      setField(memory, "addressConfirmed", "yes", changedFields);

      if (knownBusinessAddressLine || knownBusinessAddress) {
        setField(
          memory,
          "businessAddress",
          knownBusinessAddressLine || knownBusinessAddress,
          changedFields
        );
      }

      if (knownPostcode) {
        setField(memory, "postcode", knownPostcode, changedFields);
      }
    } else if (looksLikeAddressCorrection(questionRawText)) {
      setField(memory, "addressConfirmed", "no", changedFields);

      if (postcode) {
        setField(memory, "postcode", postcode, changedFields);
      }

      if (shouldStoreRawAnswer(questionRawText)) {
        setField(
          memory,
          "businessAddress",
          normaliseBusinessAddressAnswer(questionRawText),
          changedFields
        );
      }
    }
  }

  if (
    assistantAskedBusinessAddress &&
    shouldStoreRawAnswer(questionRawText) &&
    !memory.wrongNumber
  ) {
    setField(
      memory,
      "businessAddress",
      normaliseBusinessAddressAnswer(questionRawText),
      changedFields
    );
    setField(memory, "correctBusinessConfirmed", "yes", changedFields);
  }

  if (assistantAskedPostcode && shouldStoreRawAnswer(questionRawText)) {
    setField(memory, "postcode", postcode || questionRawText, changedFields);
  }

  if (assistantAskedBusinessDetailsConfirmation) {
    if (isNegativeAnswer(questionRawText)) {
      setField(memory, "businessDetailsConfirmed", "no", changedFields);

      if (looksLikeBusinessDetailCorrection(questionRawText)) {
        const correctedBusinessName =
          extractBusinessName(questionRawText) ||
          normaliseBusinessNameAnswer(questionRawText);
        const correctedPhoneNumber = extractPhoneNumber(questionRawText);

        if (correctedBusinessName) {
          setField(memory, "businessName", correctedBusinessName, changedFields);
        }

        if (correctedPhoneNumber) {
          setField(memory, "phoneNumber", correctedPhoneNumber, changedFields);
        }
      } else if (shouldStoreRawAnswer(questionRawText)) {
        pushNote(
          memory,
          `Business detail correction: ${questionRawText}`,
          changedFields
        );
      }
    } else if (isAffirmativeAnswer(questionRawText)) {
      setField(memory, "businessDetailsConfirmed", "yes", changedFields);
      setField(memory, "correctBusinessConfirmed", "yes", changedFields);

      if (knownBusinessName) {
        setField(memory, "businessName", knownBusinessName, changedFields);
      }

      if (knownBusinessPhone) {
        setField(memory, "phoneNumber", knownBusinessPhone, changedFields);
      }
    } else if (looksLikeBusinessDetailCorrection(questionRawText)) {
      setField(memory, "businessDetailsConfirmed", "no", changedFields);

      const correctedBusinessName =
        extractBusinessName(questionRawText) ||
        normaliseBusinessNameAnswer(questionRawText);
      const correctedPhoneNumber = extractPhoneNumber(questionRawText);

      if (correctedBusinessName) {
        setField(memory, "businessName", correctedBusinessName, changedFields);
      }

      if (correctedPhoneNumber) {
        setField(memory, "phoneNumber", correctedPhoneNumber, changedFields);
      }
    }
  }

  if (assistantAskedOwnerStatus) {
    if (
      isAffirmativeAnswer(questionRawText) ||
      hasAny(questionLower, [
        "i am the owner",
        "i'm the owner",
        "i own it",
        "i own the business",
        "i run it",
      ])
    ) {
      setField(memory, "isBusinessOwner", "yes", changedFields);
      setField(memory, "authorisedDecisionMaker", "yes", changedFields);
      setField(memory, "isDecisionMaker", "yes", changedFields);
      setField(memory, "decisionMakerRole", "owner", changedFields);
    }

    if (
      isNegativeAnswer(questionRawText) ||
      hasAny(questionLower, [
        "not the owner",
        "i am not the owner",
        "i'm not the owner",
      ])
    ) {
      setField(memory, "isBusinessOwner", "no", changedFields);
    }
  }

  if (assistantAskedFinancialAuthority) {
    if (
      isAffirmativeAnswer(questionRawText) ||
      hasAny(questionLower, [
        "i can",
        "yes i do",
        "i handle that",
        "that is me",
      ])
    ) {
      setField(memory, "authorisedDecisionMaker", "yes", changedFields);
      setField(memory, "isDecisionMaker", "yes", changedFields);
    }

    if (
      isNegativeAnswer(questionRawText) ||
      hasAny(questionLower, [
        "i cannot",
        "i don't",
        "i do not",
        "someone else does",
      ])
    ) {
      setField(memory, "authorisedDecisionMaker", "no", changedFields);
      setField(memory, "isDecisionMaker", "no", changedFields);
    }
  }

  if (assistantAskedDecisionMaker) {
    if (
      isAffirmativeAnswer(questionRawText) ||
      hasAny(questionLower, [
        "i am the owner",
        "i'm the owner",
        "i own it",
        "i run it",
        "i look after that",
        "that's me",
      ])
    ) {
      setField(memory, "isDecisionMaker", "yes", changedFields);
    }

    if (
      isNegativeAnswer(questionRawText) ||
      hasAny(questionLower, [
        "that isn't me",
        "that's not me",
        "someone else handles that",
        "i don't handle that",
      ])
    ) {
      setField(memory, "isDecisionMaker", "no", changedFields);
    }
  }

  if (
    hasAny(questionLower, [
      "i am the owner",
      "i'm the owner",
      "i own the business",
      "i run the business",
      "i look after the website",
      "i look after the marketing",
    ])
  ) {
    setField(memory, "isBusinessOwner", "yes", changedFields);
    setField(memory, "authorisedDecisionMaker", "yes", changedFields);
    setField(memory, "isDecisionMaker", "yes", changedFields);
    setField(memory, "decisionMakerRole", "owner", changedFields);
  }

  if (memory.isDecisionMaker === "yes" && memory.contactName && !memory.decisionMakerName) {
    setField(memory, "decisionMakerName", memory.contactName, changedFields);
  }

  if (
    memory.isDecisionMaker === "yes" &&
    !memory.decisionMakerRole &&
    hasAny(questionLower, ["owner", "director", "manager", "marketing"])
  ) {
    setField(
      memory,
      "decisionMakerRole",
      normaliseDecisionMakerRole(questionRawText),
      changedFields
    );
  }

  if (assistantAskedDecisionMakerName && shouldStoreRawAnswer(questionRawText)) {
    setField(
      memory,
      "decisionMakerName",
      contactName || questionRawText,
      changedFields
    );
  }

  if (assistantAskedDecisionMakerRole && shouldStoreRawAnswer(questionRawText)) {
    const normalisedRole = normaliseDecisionMakerRole(questionRawText);

    if (normalisedRole) {
      setField(memory, "decisionMakerRole", normalisedRole, changedFields);
    } else {
      pushNote(memory, `Unclear decision maker role: ${questionRawText}`, changedFields);
    }
  }

  const websiteAddress = extractWebsiteAddress(questionRawText);

  if (websiteAddress) {
    setField(memory, "websiteStatus", "yes", changedFields);
    pushNote(memory, `Website mentioned: ${websiteAddress}`, changedFields);
  }

  if (assistantAskedWebsiteStatus) {
    if (
      isAffirmativeAnswer(questionRawText) ||
      hasAny(questionLower, ["we do", "i do", "we have one", "i have one", "got one"])
    ) {
      setField(memory, "websiteStatus", "yes", changedFields);
    }

    if (
      isNegativeAnswer(questionRawText) ||
      hasAny(questionLower, [
        "no website",
        "don't have a website",
        "do not have a website",
        "haven't got a website",
      ])
    ) {
      setField(memory, "websiteStatus", "no", changedFields);
    }
  }

  if (assistantAskedWebsiteAge && shouldStoreRawAnswer(questionRawText)) {
    setField(
      memory,
      "websiteAge",
      extractDuration(questionRawText) || questionRawText,
      changedFields
    );
  }

  if (assistantAskedWebsiteInterest && questionRawText) {
    if (isAffirmativeAnswer(questionRawText)) {
      setField(memory, "websiteInterestLevel", "yes", changedFields);
    } else if (isNegativeAnswer(questionRawText)) {
      setField(memory, "websiteInterestLevel", "no", changedFields);
    } else {
      setField(memory, "websiteInterestLevel", questionRawText, changedFields);
    }
  }

  if (assistantAskedOnlineEnquiries) {
    if (isAffirmativeAnswer(questionRawText)) {
      setField(memory, "onlineEnquiryStatus", "yes", changedFields);
    } else if (isNegativeAnswer(questionRawText)) {
      setField(memory, "onlineEnquiryStatus", "no", changedFields);
    } else if (
      shouldStoreRawAnswer(questionRawText) &&
      looksLikeOnlineEnquiryAnswer(questionRawText)
    ) {
      setField(memory, "onlineEnquiryStatus", questionRawText, changedFields);
    } else if (shouldStoreRawAnswer(questionRawText)) {
      pushNote(
        memory,
        `Unclear online enquiry answer: ${questionRawText}`,
        changedFields
      );
    }
  }

  if (assistantAskedMoreEnquiries) {
    if (
      isAffirmativeAnswer(questionRawText) ||
      hasAny(questionLower, [
        "would like",
        "like to get",
        "want more enquiries",
        "want more inquiries",
        "more enquiries",
        "more inquiries",
      ])
    ) {
      setField(memory, "interestInMoreEnquiries", "yes", changedFields);
    } else if (isNegativeAnswer(questionRawText)) {
      setField(memory, "interestInMoreEnquiries", "no", changedFields);
    } else if (shouldStoreRawAnswer(questionRawText)) {
      setField(memory, "interestInMoreEnquiries", questionRawText, changedFields);
    }
  }

  const inferredIndustry =
    inferIndustryFromText(questionRawText) || inferIndustryFromText(memory.businessName);

  if (assistantAskedIndustry && shouldStoreRawAnswer(questionRawText)) {
    const normalisedIndustry =
      inferIndustryFromText(questionRawText) ||
      normaliseIndustryAnswer(questionRawText);

    if (normalisedIndustry && !isLowConfidenceIndustry(normalisedIndustry)) {
      setField(memory, "industry", normalisedIndustry, changedFields);
    } else {
      pushNote(memory, `Unclear industry answer: ${questionRawText}`, changedFields);
    }
  } else if (!memory.industry && inferredIndustry) {
    setField(memory, "industry", inferredIndustry, changedFields);
  }

  const callbackDate = extractDateLikeText(questionRawText);
  const callbackTime = normaliseCallbackTimeAnswer(questionRawText);

  if (callbackDate) {
    setField(memory, "callbackDate", callbackDate, changedFields);
    setField(memory, "callbackRequested", true, changedFields);
  }

  if (callbackTime) {
    setField(memory, "callbackTime", callbackTime, changedFields);
    setField(memory, "callbackRequested", true, changedFields);
  }

  if (assistantAskedCallbackConsent) {
    if (isAffirmativeAnswer(questionRawText)) {
      setField(memory, "callbackConsent", "yes", changedFields);
      setField(memory, "callbackRequested", true, changedFields);
    } else if (isNegativeAnswer(questionRawText)) {
      setField(memory, "callbackConsent", "no", changedFields);
      setField(memory, "callbackRequested", true, changedFields);
    }
  }

  if (assistantAskedCallbackDay && shouldStoreRawAnswer(questionRawText)) {
    setField(memory, "callbackDate", callbackDate || questionRawText, changedFields);
    setField(memory, "callbackRequested", true, changedFields);
  }

  if (assistantAskedCallbackTime && shouldStoreRawAnswer(questionRawText)) {
    if (callbackTime) {
      setField(memory, "callbackTime", callbackTime, changedFields);
      setField(memory, "callbackRequested", true, changedFields);
    } else {
      pushNote(memory, `Unclear callback time: ${questionRawText}`, changedFields);
    }
  }

  if (assistantAskedCallbackGeneral && shouldStoreRawAnswer(questionRawText)) {
    if (!callbackDate && !callbackTime) {
      pushNote(memory, `Callback details: ${questionRawText}`, changedFields);
    }

    setField(memory, "callbackRequested", true, changedFields);
  }

  if (
    hasAny(lower, [
      "call me back",
      "give me a call back",
      "someone call me",
      "ring me back",
      "call back tomorrow",
      "call back later",
    ])
  ) {
    setField(memory, "callbackRequested", true, changedFields);
  }

  if (
    !assistantAskedCallbackGeneral &&
    !assistantAskedCallbackDay &&
    !assistantAskedCallbackTime &&
    !assistantAskedBusinessAddress &&
    !assistantAskedPostcode &&
    !assistantAskedIndustry &&
    shouldStoreRawAnswer(rawText) &&
    hasAny(lower, ["email", "mobile", "landline", "afternoon", "morning"])
  ) {
    pushNote(memory, rawText, changedFields);
  }

  if (changedFields.length) {
    memory.lastUpdatedAt = new Date().toISOString();
  }

  return { changedFields, memory };
}

function formatValue(value) {
  if (Array.isArray(value)) {
    return value.length ? value.join("; ") : "Unknown";
  }

  if (value === true) {
    return "Yes";
  }

  if (value === false) {
    return "No";
  }

  return value || "Unknown";
}

function formatSessionMemoryForPrompt(memory) {
  if (!memory) {
    return "No session memory available.";
  }

  return [
    `Contact name: ${formatValue(memory.contactName)}`,
    `Contact title: ${formatValue(memory.contactTitle)}`,
    `Correct business confirmed: ${formatValue(memory.correctBusinessConfirmed)}`,
    `Business details confirmed: ${formatValue(memory.businessDetailsConfirmed)}`,
    `Address confirmed: ${formatValue(memory.addressConfirmed)}`,
    `Business name: ${formatValue(memory.businessName)}`,
    `Business address: ${formatValue(memory.businessAddress)}`,
    `Postcode: ${formatValue(memory.postcode)}`,
    `Business owner status: ${formatValue(memory.isBusinessOwner)}`,
    `Decision maker status: ${formatValue(memory.isDecisionMaker)}`,
    `Authorised decision maker status: ${formatValue(memory.authorisedDecisionMaker)}`,
    `Decision maker name: ${formatValue(memory.decisionMakerName)}`,
    `Decision maker role: ${formatValue(memory.decisionMakerRole)}`,
    `Phone number: ${formatValue(memory.phoneNumber)}`,
    `Has website: ${formatValue(memory.websiteStatus)}`,
    `Website age: ${formatValue(memory.websiteAge)}`,
    `Website interest level: ${formatValue(memory.websiteInterestLevel)}`,
    `Gets enquiries online: ${formatValue(memory.onlineEnquiryStatus)}`,
    `Interested in more enquiries: ${formatValue(memory.interestInMoreEnquiries)}`,
    `Industry: ${formatValue(memory.industry)}`,
    `Callback consent: ${formatValue(memory.callbackConsent)}`,
    `Callback date: ${formatValue(memory.callbackDate)}`,
    `Callback time: ${formatValue(memory.callbackTime)}`,
    `Busy: ${formatValue(memory.busy)}`,
    `Not interested: ${formatValue(memory.notInterested)}`,
    `Wrong number: ${formatValue(memory.wrongNumber)}`,
    `Do not call: ${formatValue(memory.doNotCall)}`,
    `Notes: ${formatValue(memory.notes)}`,
  ].join("\n");
}

function formatSessionMemoryForLog(memory) {
  return {
    contactName: memory.contactName,
    contactTitle: memory.contactTitle,
    correctBusinessConfirmed: memory.correctBusinessConfirmed,
    businessDetailsConfirmed: memory.businessDetailsConfirmed,
    addressConfirmed: memory.addressConfirmed,
    businessName: memory.businessName,
    businessAddress: memory.businessAddress,
    postcode: memory.postcode,
    isBusinessOwner: memory.isBusinessOwner,
    isDecisionMaker: memory.isDecisionMaker,
    authorisedDecisionMaker: memory.authorisedDecisionMaker,
    decisionMakerName: memory.decisionMakerName,
    decisionMakerRole: memory.decisionMakerRole,
    phoneNumber: memory.phoneNumber,
    websiteStatus: memory.websiteStatus,
    websiteAge: memory.websiteAge,
    websiteInterestLevel: memory.websiteInterestLevel,
    onlineEnquiryStatus: memory.onlineEnquiryStatus,
    interestInMoreEnquiries: memory.interestInMoreEnquiries,
    industry: memory.industry,
    callbackConsent: memory.callbackConsent,
    callbackDate: memory.callbackDate,
    callbackTime: memory.callbackTime,
    callbackRequested: memory.callbackRequested,
    callbackConfirmed: memory.callbackConfirmed,
    busy: memory.busy,
    notInterested: memory.notInterested,
    wrongNumber: memory.wrongNumber,
    doNotCall: memory.doNotCall,
    notes: memory.notes,
    lastUpdatedAt: memory.lastUpdatedAt,
  };
}

module.exports = {
  createSessionMemory,
  updateSessionMemoryFromTranscript,
  formatSessionMemoryForPrompt,
  formatSessionMemoryForLog,
};

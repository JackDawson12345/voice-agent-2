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

function getLastAssistantMessage(conversationHistory = []) {
  for (let index = conversationHistory.length - 1; index >= 0; index -= 1) {
    const message = conversationHistory[index];

    if (message && message.role === "assistant" && message.content) {
      return String(message.content);
    }
  }

  return "";
}

function hasAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
}

function isSimpleYes(text) {
  return /^(?:yes|yeah|yep|yeh|sure|okay|ok|correct|that'?s right|fine|go ahead|please do|happy to)[.!?\s]*$/i.test(
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

  return /\b(yes|yeah|yep|yeh|sure|okay|ok|correct|that'?s right|go ahead|please do|happy to|i do|we do|i am|we are|i have|we have)\b/i.test(
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
  return (
    extractAfterPatterns(text, [
      /(?:my name is|this is|i am|i'm)\s+([a-z][a-z .'-]{1,60})$/i,
      /(?:hello|hi|hiya)?[\s,.]*([a-z][a-z .'-]{1,60})\s+(?:speaking|here)$/i,
    ]) || null
  );
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
      /\b((?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening))?)\b/i,
      /\b((?:next|this)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week))\b/i,
      /\b(\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?))\b/i,
      /\b((?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?)\b/i,
      /\b(\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?)\b/i,
    ]) || null
  );
}

function extractTimeLikeText(text) {
  return (
    extractAfterPatterns(text, [
      /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i,
      /\b(\d{1,2}\s*o'?clock)\b/i,
      /\b((?:morning|afternoon|evening|lunchtime))\b/i,
      /\b(half\s+past\s+\d{1,2})\b/i,
      /\b(quarter\s+(?:past|to)\s+\d{1,2})\b/i,
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

function updateSessionMemoryFromTranscript(memory, transcript, context = {}) {
  const changedFields = [];
  const rawText = cleanValue(transcript);
  const speechText = normaliseSpeechText(rawText);
  const lower = rawText.toLowerCase();
  const lastAssistant = getLastAssistantMessage(context.conversationHistory || []);
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

  const assistantAskedContactName = hasAny(lastAssistantLower, [
    "who i am speaking with",
    "who am i speaking with",
    "who am i speaking to",
    "who am i speaking with please",
    "how should i address you",
    "how can i address you",
    "what should i call you",
  ]);

  const assistantAskedBusinessName = hasAny(lastAssistantLower, [
    "name of your business",
    "right business",
    "business please",
    "business name",
  ]);

  const assistantAskedBusinessAddress = hasAny(lastAssistantLower, [
    "best address for the business",
    "best address for your business",
    "confirm the best address",
    "business address",
  ]);

  const assistantAskedPostcode = hasAny(lastAssistantLower, [
    "postcode",
    "post code",
  ]);

  const assistantAskedDecisionMaker = hasAny(lastAssistantLower, [
    "looks after decisions around advertising",
    "websites or online marketing",
    "responsible for advertising",
  ]);

  const assistantAskedOwnerStatus = hasAny(lastAssistantLower, [
    "are you the business owner",
  ]);

  const assistantAskedFinancialAuthority = hasAny(lastAssistantLower, [
    "authorised to make financial decisions",
    "authorized to make financial decisions",
    "make financial decisions on behalf of the business",
  ]);

  const assistantAskedAddressConfirmation = hasAny(lastAssistantLower, [
    "confirm that your address is",
    "confirm your address is",
    "confirm that the postcode is",
  ]);

  const assistantAskedBusinessDetailsConfirmation = hasAny(lastAssistantLower, [
    "business name as",
    "business number as",
    "business number",
  ]);

  const assistantAskedDecisionMakerName = hasAny(lastAssistantLower, [
    "who would normally handle those decisions",
    "who handles those decisions",
    "who would handle that",
  ]);

  const assistantAskedDecisionMakerRole = hasAny(lastAssistantLower, [
    "what is their role",
    "what's their role",
    "role at the business",
  ]);

  const assistantAskedWebsiteStatus = hasAny(lastAssistantLower, [
    "currently have a website",
    "have a website for your business",
    "do you currently have a website",
  ]);

  const assistantAskedWebsiteAge = hasAny(lastAssistantLower, [
    "how long have you had your website",
    "how long have you had the website",
  ]);

  const assistantAskedWebsiteInterest = hasAny(lastAssistantLower, [
    "considered getting a website",
    "help customers find your business online",
    "considered getting a website for your business",
  ]);

  const assistantAskedOnlineEnquiries = hasAny(lastAssistantLower, [
    "receive enquiries",
    "online searches",
    "through online searches or your website",
    "get enquiries online from new customers",
  ]);

  const assistantAskedMoreEnquiries = hasAny(lastAssistantLower, [
    "interested in receiving more enquiries",
    "more enquiries from customers searching online",
    "like to get enquiries or more enquiries online",
  ]);

  const assistantAskedIndustry = hasAny(lastAssistantLower, [
    "type of business or industry",
    "what type of business",
    "what industry are you in",
    "classification or industry",
  ]);

  const assistantAskedCallbackConsent = hasAny(lastAssistantLower, [
    "to thank you for taking part in the survey",
    "no cost basic listing",
    "is that ok",
    "is that okay",
  ]);

  const assistantAskedCallbackDay = hasAny(lastAssistantLower, [
    "what day would suit you best",
    "what day would be better",
    "what day would suit them best",
    "what day would suit best",
  ]);

  const assistantAskedCallbackTime = hasAny(lastAssistantLower, [
    "what time would suit you best",
    "what time would suit them best",
    "what time works best",
    "what time would suit best",
  ]);

  const assistantAskedCallbackGeneral = hasAny(lastAssistantLower, [
    "better time for us to call you back",
    "best way and time to reach them",
    "available for a callback",
    "what day and time would suit you best",
  ]);

  const contactName =
    extractPersonName(speechText) || extractPersonName(rawText) || null;
  const contactTitle = extractHonorific(rawText);

  if (contactName && (!memory.contactName || assistantAskedContactName)) {
    setField(memory, "contactName", contactName, changedFields);
  } else if (assistantAskedContactName && shouldStoreRawAnswer(rawText)) {
    setField(
      memory,
      "contactName",
      normaliseContactNameAnswer(rawText) || rawText,
      changedFields
    );
  }

  if (contactTitle && (!memory.contactTitle || assistantAskedContactName)) {
    setField(memory, "contactTitle", contactTitle, changedFields);
  }

  const businessName =
    extractBusinessName(rawText) ||
    (assistantAskedBusinessName && shouldStoreRawAnswer(rawText)
      ? normaliseBusinessNameAnswer(rawText)
      : null);

  if (businessName && !memory.wrongNumber) {
    setField(memory, "businessName", businessName, changedFields);
    setField(memory, "correctBusinessConfirmed", "yes", changedFields);
  }

  const postcode = extractUkPostcode(rawText);

  if (postcode) {
    setField(memory, "postcode", postcode, changedFields);
  }

  if (assistantAskedAddressConfirmation) {
    if (isAffirmativeAnswer(rawText)) {
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
    } else if (isNegativeAnswer(rawText) || shouldStoreRawAnswer(rawText)) {
      setField(memory, "addressConfirmed", "no", changedFields);

      if (postcode) {
        setField(memory, "postcode", postcode, changedFields);
      }

      if (shouldStoreRawAnswer(rawText) && !isNegativeAnswer(rawText)) {
        setField(
          memory,
          "businessAddress",
          normaliseBusinessAddressAnswer(rawText),
          changedFields
        );
      } else if (shouldStoreRawAnswer(rawText)) {
        pushNote(memory, `Address correction: ${rawText}`, changedFields);
      }
    }
  }

  if (
    assistantAskedBusinessAddress &&
    shouldStoreRawAnswer(rawText) &&
    !memory.wrongNumber
  ) {
    setField(
      memory,
      "businessAddress",
      normaliseBusinessAddressAnswer(rawText),
      changedFields
    );
    setField(memory, "correctBusinessConfirmed", "yes", changedFields);
  }

  if (assistantAskedPostcode && shouldStoreRawAnswer(rawText)) {
    setField(memory, "postcode", postcode || rawText, changedFields);
  }

  if (assistantAskedBusinessDetailsConfirmation) {
    if (isAffirmativeAnswer(rawText)) {
      setField(memory, "businessDetailsConfirmed", "yes", changedFields);
      setField(memory, "correctBusinessConfirmed", "yes", changedFields);

      if (knownBusinessName) {
        setField(memory, "businessName", knownBusinessName, changedFields);
      }

      if (knownBusinessPhone) {
        setField(memory, "phoneNumber", knownBusinessPhone, changedFields);
      }
    } else if (isNegativeAnswer(rawText) || shouldStoreRawAnswer(rawText)) {
      setField(memory, "businessDetailsConfirmed", "no", changedFields);

      const correctedBusinessName =
        extractBusinessName(rawText) || normaliseBusinessNameAnswer(rawText);
      const correctedPhoneNumber = extractPhoneNumber(rawText);

      if (correctedBusinessName && !isNegativeAnswer(rawText)) {
        setField(memory, "businessName", correctedBusinessName, changedFields);
      }

      if (correctedPhoneNumber) {
        setField(memory, "phoneNumber", correctedPhoneNumber, changedFields);
      }

      if (shouldStoreRawAnswer(rawText)) {
        pushNote(memory, `Business detail correction: ${rawText}`, changedFields);
      }
    }
  }

  if (assistantAskedOwnerStatus) {
    if (
      isAffirmativeAnswer(rawText) ||
      hasAny(lower, [
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
    }

    if (
      isNegativeAnswer(rawText) ||
      hasAny(lower, [
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
      isAffirmativeAnswer(rawText) ||
      hasAny(lower, [
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
      isNegativeAnswer(rawText) ||
      hasAny(lower, [
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
      isAffirmativeAnswer(rawText) ||
      hasAny(lower, [
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
      isNegativeAnswer(rawText) ||
      hasAny(lower, [
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
    hasAny(lower, [
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
  }

  if (memory.isDecisionMaker === "yes" && memory.contactName && !memory.decisionMakerName) {
    setField(memory, "decisionMakerName", memory.contactName, changedFields);
  }

  if (
    memory.isDecisionMaker === "yes" &&
    !memory.decisionMakerRole &&
    hasAny(lower, ["owner", "director", "manager", "marketing"])
  ) {
    setField(memory, "decisionMakerRole", extractRole(rawText) || rawText, changedFields);
  }

  if (assistantAskedDecisionMakerName && shouldStoreRawAnswer(rawText)) {
    setField(memory, "decisionMakerName", contactName || rawText, changedFields);
  }

  if (assistantAskedDecisionMakerRole && shouldStoreRawAnswer(rawText)) {
    setField(memory, "decisionMakerRole", extractRole(rawText) || rawText, changedFields);
  }

  const websiteAddress = extractWebsiteAddress(rawText);

  if (websiteAddress) {
    setField(memory, "websiteStatus", "yes", changedFields);
    pushNote(memory, `Website mentioned: ${websiteAddress}`, changedFields);
  }

  if (assistantAskedWebsiteStatus) {
    if (
      isAffirmativeAnswer(rawText) ||
      hasAny(lower, ["we do", "i do", "we have one", "i have one", "got one"])
    ) {
      setField(memory, "websiteStatus", "yes", changedFields);
    }

    if (
      isNegativeAnswer(rawText) ||
      hasAny(lower, [
        "no website",
        "don't have a website",
        "do not have a website",
        "haven't got a website",
      ])
    ) {
      setField(memory, "websiteStatus", "no", changedFields);
    }
  }

  if (assistantAskedWebsiteAge && shouldStoreRawAnswer(rawText)) {
    setField(memory, "websiteAge", extractDuration(rawText) || rawText, changedFields);
  }

  if (assistantAskedWebsiteInterest && rawText) {
    if (isAffirmativeAnswer(rawText)) {
      setField(memory, "websiteInterestLevel", "yes", changedFields);
    } else if (isNegativeAnswer(rawText)) {
      setField(memory, "websiteInterestLevel", "no", changedFields);
    } else {
      setField(memory, "websiteInterestLevel", rawText, changedFields);
    }
  }

  if (assistantAskedOnlineEnquiries) {
    if (isAffirmativeAnswer(rawText)) {
      setField(memory, "onlineEnquiryStatus", "yes", changedFields);
    } else if (isNegativeAnswer(rawText)) {
      setField(memory, "onlineEnquiryStatus", "no", changedFields);
    } else if (shouldStoreRawAnswer(rawText) && looksLikeOnlineEnquiryAnswer(rawText)) {
      setField(memory, "onlineEnquiryStatus", rawText, changedFields);
    } else if (shouldStoreRawAnswer(rawText)) {
      pushNote(memory, `Unclear online enquiry answer: ${rawText}`, changedFields);
    }
  }

  if (assistantAskedMoreEnquiries) {
    if (isAffirmativeAnswer(rawText)) {
      setField(memory, "interestInMoreEnquiries", "yes", changedFields);
    } else if (isNegativeAnswer(rawText)) {
      setField(memory, "interestInMoreEnquiries", "no", changedFields);
    } else if (shouldStoreRawAnswer(rawText)) {
      setField(memory, "interestInMoreEnquiries", rawText, changedFields);
    }
  }

  const inferredIndustry =
    inferIndustryFromText(rawText) || inferIndustryFromText(memory.businessName);

  if (assistantAskedIndustry && shouldStoreRawAnswer(rawText)) {
    setField(memory, "industry", normaliseIndustryAnswer(rawText), changedFields);
  } else if (!memory.industry && inferredIndustry) {
    setField(memory, "industry", inferredIndustry, changedFields);
  }

  const callbackDate = extractDateLikeText(rawText);
  const callbackTime = extractTimeLikeText(rawText);

  if (callbackDate) {
    setField(memory, "callbackDate", callbackDate, changedFields);
    setField(memory, "callbackRequested", true, changedFields);
  }

  if (callbackTime) {
    setField(memory, "callbackTime", callbackTime, changedFields);
    setField(memory, "callbackRequested", true, changedFields);
  }

  if (assistantAskedCallbackConsent) {
    if (isAffirmativeAnswer(rawText)) {
      setField(memory, "callbackConsent", "yes", changedFields);
      setField(memory, "callbackRequested", true, changedFields);
    } else if (isNegativeAnswer(rawText)) {
      setField(memory, "callbackConsent", "no", changedFields);
      setField(memory, "callbackRequested", true, changedFields);
    }
  }

  if (assistantAskedCallbackDay && shouldStoreRawAnswer(rawText)) {
    setField(memory, "callbackDate", callbackDate || rawText, changedFields);
    setField(memory, "callbackRequested", true, changedFields);
  }

  if (assistantAskedCallbackTime && shouldStoreRawAnswer(rawText)) {
    setField(memory, "callbackTime", callbackTime || rawText, changedFields);
    setField(memory, "callbackRequested", true, changedFields);
  }

  if (assistantAskedCallbackGeneral && shouldStoreRawAnswer(rawText)) {
    if (!callbackDate && !callbackTime) {
      pushNote(memory, `Callback details: ${rawText}`, changedFields);
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

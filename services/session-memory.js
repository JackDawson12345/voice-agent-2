// services/session-memory.js

const {
  formatCustomerAddress,
  hasDeclinedCallback,
  inferQuestionKeyFromAssistantReply,
  isFinancialAuthorityPrompt,
} = require("./survey-script");
const { callbackTimeMinutes, isCallbackTimeWithinHours, formatCallbackClock } = require("./callback-time");

function createSessionMemory() {
  return {
    contactName: null,
    contactTitle: null,
    correctBusinessConfirmed: null,
    businessDetailsConfirmed: null,
    addressConfirmed: null,
    addressCorrectionConfirmed: false,
    businessDetailsCorrectionConfirmed: false,
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
    pendingWebsiteAge: null,
    websiteAgeNeedsClarification: false,
    websiteInterestLevel: null,
    onlineEnquiryStatus: null,
    onlineEnquiryNeedsClarification: false,
    interestInMoreEnquiries: null,
    pendingIndustry: null,
    industry: null,
    callbackConsent: null,
    callbackDate: null,
    pendingCallbackDate: null,
    callbackDateNeedsClarification: false,
    callbackTime: null,
    callbackTimeNeedsClarification: false,
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
  return /^(?:yes|yeah|yep|yup|yeh|uh[ -]?huh|mm[ -]?hmm|mhm|sure|okay|ok|correct|that'?s right|that is right|that is correct|that'?s correct|i am|i'm|it is|that is|fine|go ahead|please do|happy to|absolutely|definitely|indeed)[.!?\s]*$/i.test(
    cleanValue(text)
  );
}

function isSimpleNo(text) {
  return /^(?:no|nope|nah|not really|not at the moment|not now|rather not|i am not|i'm not|it is not|it isn't|that is not right|that isn't right|incorrect)[.!?\s]*$/i.test(
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

  return /\b(yes|yeah|yep|yup|yeh|sure|okay|ok|correct|that'?s right|that is right|that is correct|go ahead|please do|happy to|i do|we do|i have|we have|it is)\b/i.test(
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
  return stripLeadingPhrase(stripDetailAnswerPrefix(text), [
    /^(?:yes|yeah|yep|yeh|okay|ok|right|correct)[,.\s-]+/i,
    /^(?:it is|it's|this is)[,.\s-]+/i,
  ]);
}

function normaliseBusinessAddressAnswer(text) {
  return stripLeadingPhrase(stripDetailAnswerPrefix(text), [
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
    /^(?:yes|yeah|yep|yeh|correct|right|okay|ok|no|nope|nah)[,.\s-]+/i,
    /^(?:it is|it's|we are|we're)[,.\s-]+/i,
    /^(?:the industry is|our industry is|the classification is|our classification is|the business is|our business is)[,.\s-]+/i,
    /^(?:a|an)\s+/i,
  ]);
}

function normaliseIndustryCandidate(text) {
  const candidate = normaliseIndustryAnswer(text);
  const lower = compactText(candidate);
  const blockedCandidates = new Set([
    "that's",
    "that is",
    "this",
    "it",
    "there",
    "here",
  ]);

  if (!candidate || isAffirmativeAnswer(lower) || isNegativeAnswer(lower)) {
    return null;
  }

  if (blockedCandidates.has(lower)) {
    return null;
  }

  return candidate;
}

function stripPresenceCheckPrefix(text) {
  let value = cleanValue(text);

  value = value.replace(/^(?:hello|hi)[,.\s-]*/i, "");
  value = value.replace(
    /^(?:(?:yes|yeah|yep|yeh|okay|ok)[,.\s-]+)?(?:(?:i am|i'm|we are|we're)\s+)?(?:still here|still there|still on the line|here on the line|on the line|here|there)\b[,.!\s-]*/i,
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
  const candidates = [];
  let digits = "";
  let prefix = "";
  let start = null;
  let repeat = 1;
  let invalid = false;
  const finishNumber = () => {
    if (!invalid && repeat === 1 && digits.length >= 7 && digits.length <= 15) {
      candidates.push({ number: prefix + digits, start });
    }
    digits = "";
    prefix = "";
    start = null;
    repeat = 1;
    invalid = false;
  };

  // Keep contiguous phone digits together, including spoken zero/oh, double
  // and triple. Other words separate numbers so unrelated values are not joined.
  for (const token of String(text || "").toLowerCase().matchAll(/[a-z]+|\d+|[^\s]/g)) {
    const word = token[0];
    if (/^[.,()\-]$/.test(word)) continue;
    const digit = /^\d+$/.test(word) ? word
      : word === "nought" ? "0" : normaliseSingleWordToken(word);

    if (digit && /^\d+$/.test(digit)) {
      if (start === null) start = token.index;
      if (repeat !== 1 && digit.length !== 1) invalid = true;
      digits += digit.repeat(repeat);
      repeat = 1;
    } else if (word === "double" || word === "triple") {
      if (start === null) start = token.index;
      if (repeat !== 1) invalid = true;
      repeat = word === "double" ? 2 : 3;
    } else if (word === "+" || word === "plus") {
      if (start !== null) invalid = true;
      start = token.index;
      prefix = "+";
    } else {
      finishNumber();
    }
  }
  finishNumber();

  // Multiple complete numbers need clarification rather than an arbitrary pick.
  return candidates.length === 1 ? candidates[0] : null;
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

const DURATION_QUANTITY =
  "(?:\\d+(?:\\.\\d+)?|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|(?:a )?(?:couple|few)(?: of)?|several|an?)";
const DURATION_PATTERN = `${DURATION_QUANTITY}(?: and a half)?\\s*(?:years?|months?|weeks?)`;

function extractDuration(text) {
  const durationText = String(text || "").replace(/([a-z0-9])[.!?]+(?=\s|$)/gi, "$1 ");
  return (
    extractAfterPatterns(durationText, [
      new RegExp(`\\b(${DURATION_PATTERN}(?:[ ,]+(?:and )?${DURATION_PATTERN})?)\\b`, "i"),
      /\b(since\s+\d{4})\b/i,
    ]) || null
  );
}

function looksLikeWebsiteAgeAnswer(text) {
  const lower = compactText(text);

  if (!lower || isSimpleYes(lower) || isSimpleNo(lower) ||
      lower.includes("?") || /^(?:who|what|why|how|can you|could you)\b/.test(lower) ||
      new RegExp(`\\b(?:not|isn't|wasn't)\\s+${DURATION_PATTERN}\\b`, "i").test(lower)) {
    return false;
  }

  return (
    Boolean(extractDuration(text)) ||
    /\bsince\s+\d{4}\b/i.test(lower) ||
    /\b(?:for|over|about|around)\s+(?:a\s+)?(?:year|month|week|couple|few|long time|while)\b/i.test(lower) ||
    hasAny(lower, [
      "a while",
      "long time",
      "couple of years",
      "few years",
      "few months",
      "recently",
      "just launched",
      "new website",
    ])
  );
}

function inferMisheardWebsiteAge(text) {
  // This is a proposed interpretation, never a direct change to the transcript
  // or the saved answer. The caller must confirm it on the next turn.
  const answer = normaliseSpeechText(text).replace(/,/g, " ").replace(/\s+/g, " ");
  const match = answer.match(new RegExp(
    `^(?:(?:about|around|roughly|for|it's|it is)\\s+)?(${DURATION_QUANTITY})\\s+yes$`, "i"
  ));
  if (!match) {
    return null;
  }
  const unit = /^(?:1|one|a|an)$/i.test(match[1]) ? "year" : "years";
  return `${match[1]} ${unit}`;
}

function updateWebsiteAge(memory, text, promptKey, changedFields) {
  if (!text || text.includes("?") || /^(?:who|what|why|how|can you|could you)\b/i.test(text)) {
    return;
  }

  const confirming = promptKey === "website_age_confirmation";
  const candidate = inferMisheardWebsiteAge(text);
  const answer = normaliseSpeechText(text);
  const confirmationAnswer = answer.replace(/^(?:yes|yeah|yep|yeh)[,\s]+/i, "");
  const confirmed = !isDetailRejection(text) &&
    (isSimpleYes(answer) || isSimpleYes(confirmationAnswer));

  if (looksLikeWebsiteAgeAnswer(text)) {
    setField(memory, "websiteAge", extractDuration(text) || cleanValue(text), changedFields);
    clearField(memory, "pendingWebsiteAge", changedFields);
    setField(memory, "websiteAgeNeedsClarification", false, changedFields);
  } else if (candidate) {
    setField(memory, "pendingWebsiteAge", candidate, changedFields);
    setField(memory, "websiteAgeNeedsClarification", false, changedFields);
  } else if (confirming && memory.pendingWebsiteAge && confirmed) {
    setField(memory, "websiteAge", memory.pendingWebsiteAge, changedFields);
    clearField(memory, "pendingWebsiteAge", changedFields);
    setField(memory, "websiteAgeNeedsClarification", false, changedFields);
  } else {
    clearField(memory, "pendingWebsiteAge", changedFields);
    setField(memory, "websiteAgeNeedsClarification", true, changedFields);
    pushNote(memory, `Unclear website age answer: ${text}`, changedFields);
  }
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

function suggestCallbackDay(text) {
  // Only suggest this known mishearing while collecting a callback day.
  // The caller must confirm it before it becomes a scheduled date.
  const match = compactText(text).match(/^(?:(this|next)\s+)?(?:rider|fry day|fryday)(?:\s+please)?$/);
  return match ? `${match[1] ? `${match[1]} ` : ""}Friday` : null;
}

function extractTimeLikeText(text) {
  const numberPattern =
    "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d{1,2})";

  return (
    extractAfterPatterns(text, [
      /\b(after lunchtime|after lunch|before lunchtime|before lunch|around lunchtime|around lunch|late morning|early morning|early afternoon|late afternoon)\b/i,
      new RegExp(`\\b((?:any time )?after\\s+${numberPattern}(?::\\d{2})?\\s*(?:am|pm)?)\\b`, "i"),
      new RegExp(`\\b((?:any time )?before\\s+${numberPattern}(?::\\d{2})?\\s*(?:am|pm)?)\\b`, "i"),
      new RegExp(`\\b(between\\s+${numberPattern}(?::\\d{2})?\\s*(?:am|pm)?\\s+and\\s+${numberPattern}(?::\\d{2})?\\s*(?:am|pm)?)\\b`, "i"),
      new RegExp(`\\b((?:from\\s+)?${numberPattern}(?::\\d{2})?\\s*(?:am|pm)?\\s*(?:to|until|-)\\s*${numberPattern}(?::\\d{2})?\\s*(?:am|pm)?)\\b`, "i"),
      new RegExp(`\\b((?:about|around)\\s+(?:half\\s+past\\s+${numberPattern}|half\\s+${numberPattern}|quarter\\s+(?:past|to)\\s+${numberPattern}|${numberPattern}\\s*o'?clock|${numberPattern}(?::\\d{2})?\\s*(?:am|pm)?))\\b`, "i"),
      new RegExp(`\\b((?:half\\s+past\\s+${numberPattern}|half\\s+${numberPattern})\\s*(?:am|pm)?)\\b`, "i"),
      new RegExp(`\\b((?:quarter\\s+(?:past|to)\\s+${numberPattern})\\s*(?:am|pm)?)\\b`, "i"),
      new RegExp(`\\b(${numberPattern}\\s*o'?clock\\s*(?:am|pm)?)\\b`, "i"),
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
      "sometimes",
      "occasionally",
      "from time to time",
      "now and then",
      "every now and then",
    ]) ||
    /\b(yes|no|some|none)\b/i.test(lower)
  );
}

function normaliseOnlineEnquiryAnswer(text) {
  const lower = compactText(text);

  if (!lower) {
    return null;
  }

  if (
    hasAny(lower, [
      "sometimes",
      "some times",
      "occasionally",
      "from time to time",
      "now and then",
      "every now and then",
    ])
  ) {
    return "sometimes";
  }

  if (isAffirmativeAnswer(lower)) {
    return "yes";
  }

  if (isNegativeAnswer(lower) || hasAny(lower, ["none", "never"])) {
    return "no";
  }

  // A complete frequency is a useful answer in this question's context.
  // A bare "times" is incomplete and must not be guessed to mean "sometimes".
  if (/^(?:(?:once|twice)|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|a few|a couple of|several)\s+times)(?:\s+(?:a|per|each)\s+(?:day|week|month|year))?$/i.test(lower)) {
    return cleanValue(text);
  }

  if (looksLikeOnlineEnquiryAnswer(text)) {
    return cleanValue(text);
  }

  return null;
}

function looksLikeMoreEnquiriesAnswer(text) {
  const lower = compactText(text);

  if (!lower) {
    return false;
  }

  return (
    isAffirmativeAnswer(lower) ||
    isNegativeAnswer(lower) ||
    hasAny(lower, [
      "would like",
      "like to get",
      "want more enquiries",
      "want more inquiries",
      "more enquiries",
      "more inquiries",
      "more leads",
      "more customers",
      "more business",
      "yes please",
    ])
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

function isDetailRejection(text) {
  return isNegativeAnswer(text) ||
    /\b(?:wrong|incorrect|not (?:right|correct)|isn't (?:right|correct)|is not (?:right|correct))\b/i.test(text);
}

function stripDetailAnswerPrefix(text) {
  return cleanValue(text).replace(
    /^(?:(?:oh|ah|sorry|actually|no|nope|nah|yes|yeah|yep|(?:that is|that's|it is|it's) (?:wrong|incorrect|not right|not correct))[,.!\s-]+)+/i,
    ""
  );
}

function isUsableDetailAnswer(text) {
  const candidate = cleanValue(text);
  return Boolean(candidate && !isDetailRejection(candidate) &&
    !isAffirmativeAnswer(candidate) && !candidate.includes("?") &&
    !/^(?:oh|ah|um|erm|sorry|actually|hello|hi|here|i'm here|i am here|thanks|thank you|i don't know|i do not know)$/i.test(candidate) &&
    !/^(?:what|why|how|can you|could you|would you)\b/i.test(candidate));
}

function extractAddressCorrection(text, allowFreeform = false) {
  const candidate = normaliseBusinessAddressAnswer(text)
    .replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi, "")
    .replace(/(?:[,;\s]+)?(?:and\s+)?(?:the\s+)?(?:postcode|post code)(?:\s+is)?[,.\s]*.*$/i, "");
  const address = cleanValue(candidate);

  if (!isUsableDetailAnswer(address) || extractUkPostcode(address)) {
    return null;
  }

  return allowFreeform || /\d.*[a-z]|\b(?:road|street|lane|avenue|drive|close|court|way|terrace|place|cottage|house|farm|lodge)\b/i.test(address)
    ? address : null;
}

function extractBusinessDetailName(text, allowFreeform = false, phoneMatch = null) {
  const nameText = cleanValue(phoneMatch ? text.slice(0, phoneMatch.start) : text)
    .replace(/(?:[,;\s]+)?(?:and\s+)?(?:the\s+|our\s+)?(?:business\s+)?(?:phone(?: number)?|telephone(?: number)?|number|mobile(?: number)?)\s+(?:is|as)\b.*$/i, "")
    .replace(/\+?\d[\d ()-]{5,}\d.*$/, "")
    .replace(/[,;\s]+and\s*$/i, "");
  const explicitName = extractBusinessName(nameText);
  const candidate = explicitName || normaliseBusinessNameAnswer(nameText);

  return isUsableDetailAnswer(candidate) && (explicitName || allowFreeform)
    ? cleanValue(candidate) : null;
}

const BUSINESS_DETAIL_PROMPTS = new Set([
  "address_confirmation", "address_correction_confirmation", "business_address", "postcode",
  "business_details_confirmation", "business_details_correction_confirmation", "business_name", "business_phone",
]);

function updateBusinessDetails(memory, text, promptKey, customer, changedFields) {
  const addressPrompt = ["address_confirmation", "address_correction_confirmation", "business_address", "postcode"].includes(promptKey);
  const originalConfirmation = promptKey === "address_confirmation" || promptKey === "business_details_confirmation";
  const correctionConfirmation = promptKey === "address_correction_confirmation" || promptKey === "business_details_correction_confirmation";
  const confirmation = originalConfirmation || correctionConfirmation;
  const answerField = addressPrompt ? "addressConfirmed" : "businessDetailsConfirmed";
  const correctionField = addressPrompt ? "addressCorrectionConfirmed" : "businessDetailsCorrectionConfirmed";
  const valueFields = addressPrompt ? ["businessAddress", "postcode"] : ["businessName", "phoneNumber"];
  const rejected = isDetailRejection(text);
  const affirmative = !rejected && isAffirmativeAnswer(text);
  const postcode = addressPrompt ? extractUkPostcode(text) : null;
  const address = addressPrompt && promptKey !== "postcode"
    ? extractAddressCorrection(text, promptKey === "business_address") : null;
  const phoneMatch = !addressPrompt ? extractPhoneNumber(text) : null;
  const phone = phoneMatch?.number || null;
  // A confirmation question is not a request for a freeform name. Require a
  // correction cue before letting a fragment replace the name and clear the phone.
  const namingCorrection = rejected || /\b(?:actually|instead|it is|it's|this is)\b/i.test(text);
  const name = !addressPrompt && promptKey !== "business_phone"
    ? extractBusinessDetailName(text, promptKey === "business_name" || namingCorrection, phoneMatch) : null;
  const replacements = addressPrompt ? [address, postcode] : [name, phone];
  const knownValues = addressPrompt
    ? [customer.address || formatCustomerAddress(customer), customer.postcode]
    : [customer.businessName, customer.phoneNumber];
  const confirmationValues = correctionConfirmation
    ? valueFields.map((field) => memory[field]) : knownValues;
  const comparableValue = (value) => compactText(value).replace(/[^a-z0-9]/g, "");
  const hasChangedReplacement = replacements.some((value, index) =>
    value && comparableValue(value) !== comparableValue(confirmationValues[index])
  );

  if (confirmation && (rejected || hasChangedReplacement)) {
    setField(memory, answerField, "no", changedFields);
    setField(memory, correctionField, false, changedFields);
    // A rejected pair must be collected again; never reuse the rejected profile values.
    for (const field of valueFields) {
      clearField(memory, field, changedFields);
    }
  } else if (confirmation && affirmative) {
    if (correctionConfirmation) {
      if (valueFields.every((field) => memory[field])) {
        setField(memory, correctionField, true, changedFields);
        if (memory[answerField] !== "no") {
          setField(memory, answerField, "yes", changedFields);
        }
      }
    } else {
      setField(memory, answerField, "yes", changedFields);
      valueFields.forEach((field, index) => setField(memory, field, knownValues[index], changedFields));
    }
    if (!addressPrompt && !memory.wrongNumber) {
      setField(memory, "correctBusinessConfirmed", "yes", changedFields);
    }
    return;
  } else if (confirmation) {
    // Repeating an unchanged value or an unclear answer leaves the known pair
    // intact. Ask for confirmation again without inventing a correction.
    return;
  }

  replacements.forEach((value, index) => {
    if (value) {
      setField(memory, valueFields[index], value, changedFields);
      setField(memory, correctionField, false, changedFields);
    }
  });
}

function isLowConfidenceIndustry(text) {
  const lower = compactText(text);
  const words = lower.split(/\s+/).filter(Boolean);

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
    "dude",
    "mate",
    "same",
    "sam's",
    "sams",
    "still here",
  ]);

  if (blockedValues.has(lower)) {
    return true;
  }

  if (words.length === 1) {
    if (lower.length <= 2) {
      return true;
    }

    return false;
  }

  return false;
}

function normaliseCallbackTimeAnswer(text, allowBareHour = false) {
  const candidate = cleanValue(text);
  const lower = compactText(candidate)
    .replace(/\b([ap])\.?\s*m\.?/g, "$1m")
    .replace(/\s+(?:in the|at)\s+(morning|afternoon|evening|night)\b/g, (_, period) => period === "morning" ? " am" : " pm")
    .replace(
      /^(?:about|around|at about|at around|roughly|maybe|probably|say)\s+/,
      ""
    );

  if (!lower) {
    return null;
  }

  if (!allowBareHour && /^(?:at\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})$/.test(lower)) {
    return null;
  }

  if (callbackTimeMinutes(lower) !== null) {
    return /\b(?:am|pm)\b/.test(lower) ? lower : formatCallbackClock(lower);
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

  return callbackTimeMinutes(extractedLower) !== null && !/\b(?:am|pm)\b/.test(extractedLower)
    ? formatCallbackClock(extractedLower)
    : cleanValue(extractedLower);
}

function recordCallbackTime(memory, candidate, changedFields) {
  if (!candidate) return null;
  setField(memory, "callbackConfirmed", false, changedFields);
  if (!isCallbackTimeWithinHours(candidate)) {
    clearField(memory, "callbackTime", changedFields);
    setField(memory, "callbackTimeNeedsClarification", true, changedFields);
    pushNote(memory, `Callback time needs a specific time between 9am and 5pm: ${candidate}`, changedFields);
    return null;
  }
  setField(memory, "callbackTime", candidate, changedFields);
  setField(memory, "callbackTimeNeedsClarification", false, changedFields);
  setField(memory, "callbackRequested", true, changedFields);
  return candidate;
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

function clearField(memory, field, changedFields) {
  if (memory[field] !== null) {
    memory[field] = null;
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

function isCallbackRefusal(text, promptKey, promptText) {
  const answer = normaliseSpeechText(text)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[,;:]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  const callbackMentioned = /\b(?:(?:call|ring)\s*(?:(?:me|us|them)\s+)?back|follow[ -]?up)\b/.test(answer);
  const explicitRefusal = callbackMentioned && (
    /\b(?:don'?t|do not|wouldn't|would not)\s+(?:want|wanna|need|like)\b/.test(answer) ||
    /\b(?:no|without)\s+(?:(?:a|any|another)\s+)?call\s*back\b/.test(answer) ||
    /\b(?:not interested|no need|cancel|don't call|do not call)\b/.test(answer)
  );
  const answeringCallback = ["callback_consent", "callback_day", "callback_day_confirmation", "callback_time", "callback_general"].includes(promptKey) ||
    (!promptKey && /\b(?:callback|call (?:you |me )?back)\b/i.test(promptText));

  if (explicitRefusal) {
    return true;
  }

  if (promptKey === "callback_day_confirmation" &&
      !/\b(?:no thanks|no thank you|not interested|rather not)\b/.test(answer)) {
    return false;
  }

  if (!answeringCallback) {
    return false;
  }

  if (/\b(?:no thanks|no thank you|not interested|rather not)\b/.test(answer) ||
      /^(?:(?:oh|sorry)\s+)?(?:none|never|no time|no day)(?:\s+(?:thanks|thank you))?$/.test(answer)) {
    return true;
  }

  // A negative answer with an alternative slot ("No, Friday at 3 pm")
  // changes the proposed time rather than refusing the callback itself.
  return !extractDateLikeText(answer) && !normaliseCallbackTimeAnswer(answer) && (
    isSimpleNo(answer) ||
    /\b(?:no|nope|nah|not now|not today|don'?t want|do not want|don'?t wanna)\b/.test(answer)
  );
}

function recordCallbackRefusal(memory, changedFields) {
  setField(memory, "callbackConsent", "no", changedFields);
  setField(memory, "callbackRequested", false, changedFields);
  setField(memory, "callbackConfirmed", false, changedFields);
  clearField(memory, "callbackDate", changedFields);
  clearField(memory, "pendingCallbackDate", changedFields);
  setField(memory, "callbackDateNeedsClarification", false, changedFields);
  clearField(memory, "callbackTime", changedFields);
  setField(memory, "callbackTimeNeedsClarification", false, changedFields);
  setField(memory, "busy", false, changedFields);
}

function updateSessionMemoryFromTranscript(memory, transcript, context = {}) {
  const changedFields = [];
  const rawText = cleanValue(transcript);
  const strippedPresenceText = stripPresenceCheckPrefix(rawText);
  const hasPresencePrefix = strippedPresenceText !== rawText;
  const questionRawText =
    hasPresencePrefix && !strippedPresenceText ? "" : strippedPresenceText || rawText;
  const speechText = normaliseSpeechText(questionRawText);
  const lower = rawText.toLowerCase();
  const questionLower = questionRawText.toLowerCase();
  const lastAssistant = getLastAssistantMessage(context.conversationHistory || [], {
    preferredPromptText: context.promptText,
    skipGenericPresenceChecks: true,
  });
  const promptKey = cleanValue(context.promptKey).toLowerCase() ||
    inferQuestionKeyFromAssistantReply(lastAssistant);
  const lastAssistantLower = lastAssistant.toLowerCase();
  const callProfile = context.callProfile || {};
  const callProfileCustomer = callProfile.customer || {};
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

  if (memory.doNotCall || hasDeclinedCallback(memory) ||
      isCallbackRefusal(questionRawText, promptKey, lastAssistant)) {
    recordCallbackRefusal(memory, changedFields);
    if (changedFields.length) {
      memory.lastUpdatedAt = new Date().toISOString();
    }
    return { changedFields, memory };
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

  if (promptKey === "callback_day_confirmation") {
    const replacementDate = /\b(?:not|can't|cannot)\b/i.test(questionRawText)
      ? null : extractDateLikeText(questionRawText);
    const confirmedDate = replacementDate ||
      (!isNegativeAnswer(questionRawText) && isAffirmativeAnswer(questionRawText) ? memory.pendingCallbackDate : null);
    if (confirmedDate) {
      setField(memory, "callbackDate", confirmedDate, changedFields);
      setField(memory, "callbackRequested", true, changedFields);
      clearField(memory, "pendingCallbackDate", changedFields);
      setField(memory, "callbackDateNeedsClarification", false, changedFields);
    } else if (isNegativeAnswer(questionRawText)) {
      clearField(memory, "pendingCallbackDate", changedFields);
      setField(memory, "callbackDateNeedsClarification", true, changedFields);
    }
    recordCallbackTime(memory, normaliseCallbackTimeAnswer(questionRawText), changedFields);
    if (changedFields.length) memory.lastUpdatedAt = new Date().toISOString();
    return { changedFields, memory };
  }

  if (BUSINESS_DETAIL_PROMPTS.has(promptKey)) {
    if (!memory.wrongNumber && !memory.doNotCall && !memory.busy && !memory.notInterested) {
      updateBusinessDetails(memory, questionRawText, promptKey, {
        ...callProfileCustomer,
        phoneNumber: knownBusinessPhone,
      }, changedFields);
    }
    if (memory.busy) {
      setField(memory, "callbackDate", extractDateLikeText(questionRawText), changedFields);
      recordCallbackTime(memory, normaliseCallbackTimeAnswer(questionRawText), changedFields);
    }
    if (changedFields.length) {
      memory.lastUpdatedAt = new Date().toISOString();
    }
    return { changedFields, memory };
  }

  if (promptKey === "website_age" || promptKey === "website_age_confirmation") {
    if (!memory.wrongNumber && !memory.doNotCall && !memory.busy && !memory.notInterested) {
      updateWebsiteAge(memory, questionRawText, promptKey, changedFields);
    }
    if (memory.busy) {
      setField(memory, "callbackDate", extractDateLikeText(questionRawText), changedFields);
      recordCallbackTime(memory, normaliseCallbackTimeAnswer(questionRawText), changedFields);
    }
    if (changedFields.length) {
      memory.lastUpdatedAt = new Date().toISOString();
    }
    return { changedFields, memory };
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
      "financial decisions on advertisement or website",
      "financial decisions on advertising or website",
      "make those decisions on behalf of the business",
    ]
  );

  const assistantAskedFinancialAuthorityByPrompt =
    assistantAskedFinancialAuthority || isFinancialAuthorityPrompt(lastAssistantLower);

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

  const assistantAskedIndustryConfirmation = promptMatches(
    promptKey,
    "industry_confirmation",
    lastAssistantLower,
    [
      "i just wanted to check i got that correctly",
      "was it",
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

  if (assistantAskedFinancialAuthorityByPrompt) {
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

  if (assistantAskedWebsiteInterest && questionRawText) {
    if (isAffirmativeAnswer(questionRawText)) {
      setField(memory, "websiteInterestLevel", "yes", changedFields);
    } else if (isNegativeAnswer(questionRawText)) {
      setField(memory, "websiteInterestLevel", "no", changedFields);
    } else {
      setField(memory, "websiteInterestLevel", questionRawText, changedFields);
    }
  }

  if (assistantAskedOnlineEnquiries && !/^(?:who|what|when|where|why|how|can you|could you|would you|do you|did you)\b/i.test(questionRawText)) {
    const onlineEnquiryAnswer = normaliseOnlineEnquiryAnswer(questionRawText);

    if (onlineEnquiryAnswer) {
      setField(memory, "onlineEnquiryStatus", onlineEnquiryAnswer, changedFields);
      setField(memory, "onlineEnquiryNeedsClarification", false, changedFields);
    } else if (shouldStoreRawAnswer(questionRawText)) {
      setField(memory, "onlineEnquiryNeedsClarification", true, changedFields);
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
    } else if (
      shouldStoreRawAnswer(questionRawText) &&
      looksLikeMoreEnquiriesAnswer(questionRawText)
    ) {
      setField(memory, "interestInMoreEnquiries", cleanValue(questionRawText), changedFields);
    } else if (shouldStoreRawAnswer(questionRawText)) {
      pushNote(
        memory,
        `Unclear more enquiries answer: ${questionRawText}`,
        changedFields
      );
    }
  }

  if (assistantAskedIndustry && shouldStoreRawAnswer(questionRawText)) {
    const industryCandidate =
      normaliseIndustryCandidate(questionRawText) || inferIndustryFromText(questionRawText);

    if (industryCandidate && !isLowConfidenceIndustry(industryCandidate)) {
      setField(memory, "pendingIndustry", industryCandidate, changedFields);
      clearField(memory, "industry", changedFields);
    } else {
      pushNote(memory, `Unclear industry answer: ${questionRawText}`, changedFields);
    }
  }

  if (assistantAskedIndustryConfirmation) {
    const pendingIndustry = cleanValue(memory.pendingIndustry);
    const correctedIndustry =
      normaliseIndustryCandidate(questionRawText) || inferIndustryFromText(questionRawText);

    if (isAffirmativeAnswer(questionRawText)) {
      if (pendingIndustry) {
        setField(memory, "industry", pendingIndustry, changedFields);
      }

      clearField(memory, "pendingIndustry", changedFields);
    } else if (isNegativeAnswer(questionRawText)) {
      clearField(memory, "industry", changedFields);
      clearField(memory, "pendingIndustry", changedFields);

      if (correctedIndustry && !isLowConfidenceIndustry(correctedIndustry)) {
        setField(memory, "pendingIndustry", correctedIndustry, changedFields);
      }
    } else if (correctedIndustry && !isLowConfidenceIndustry(correctedIndustry)) {
      setField(memory, "pendingIndustry", correctedIndustry, changedFields);
      clearField(memory, "industry", changedFields);
    }
  }

  const schedulingText = questionRawText.replace(/^(?:no|nope|nah)[,.!\s]+/i, "");
  const rejectedSlot = (assistantAskedCallbackConsent || assistantAskedCallbackDay ||
    assistantAskedCallbackTime || assistantAskedCallbackGeneral) &&
    /^(?:not|can't|cannot|don't|do not|won't|will not)\b/i.test(schedulingText);
  const callbackDate = rejectedSlot ? null : extractDateLikeText(questionRawText);
  const callbackTime = rejectedSlot ? null : recordCallbackTime(
    memory, normaliseCallbackTimeAnswer(questionRawText, assistantAskedCallbackTime), changedFields
  );

  if (callbackDate) {
    setField(memory, "callbackDate", callbackDate, changedFields);
    clearField(memory, "pendingCallbackDate", changedFields);
    setField(memory, "callbackDateNeedsClarification", false, changedFields);
    setField(memory, "callbackRequested", true, changedFields);
  }

  if (callbackTime) {
    setField(memory, "callbackTime", callbackTime, changedFields);
    setField(memory, "callbackRequested", true, changedFields);
  }

  if (assistantAskedCallbackConsent) {
    if (isAffirmativeAnswer(questionRawText) || callbackDate || callbackTime) {
      setField(memory, "callbackConsent", "yes", changedFields);
      setField(memory, "callbackRequested", true, changedFields);
    }
  }

  if (assistantAskedCallbackDay && shouldStoreRawAnswer(questionRawText)) {
    if (callbackDate) {
      setField(memory, "callbackDate", callbackDate, changedFields);
      setField(memory, "callbackRequested", true, changedFields);
    } else {
      const suggestedDay = !rejectedSlot && suggestCallbackDay(questionRawText);
      if (suggestedDay) setField(memory, "pendingCallbackDate", suggestedDay, changedFields);
      setField(memory, "callbackDateNeedsClarification", true, changedFields);
      pushNote(memory, `Unclear callback day: ${questionRawText}`, changedFields);
    }
  }

  if (assistantAskedCallbackTime && shouldStoreRawAnswer(questionRawText)) {
    if (callbackTime) {
      setField(memory, "callbackTime", callbackTime, changedFields);
      setField(memory, "callbackRequested", true, changedFields);
    } else {
      setField(memory, "callbackTimeNeedsClarification", true, changedFields);
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
    `Corrected address confirmed: ${formatValue(memory.addressCorrectionConfirmed)}`,
    `Corrected business details confirmed: ${formatValue(memory.businessDetailsCorrectionConfirmed)}`,
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
    `Website age awaiting confirmation: ${formatValue(memory.pendingWebsiteAge)}`,
    `Website age needs clarification: ${formatValue(memory.websiteAgeNeedsClarification)}`,
    `Website interest level: ${formatValue(memory.websiteInterestLevel)}`,
    `Gets enquiries online: ${formatValue(memory.onlineEnquiryStatus)}`,
    `Interested in more enquiries: ${formatValue(memory.interestInMoreEnquiries)}`,
    `Pending industry: ${formatValue(memory.pendingIndustry)}`,
    `Industry: ${formatValue(memory.industry)}`,
    `Callback consent: ${formatValue(memory.callbackConsent)}`,
    `Callback date: ${formatValue(memory.callbackDate)}`,
    `Callback date awaiting confirmation: ${formatValue(memory.pendingCallbackDate)}`,
    `Callback day needs clarification: ${formatValue(memory.callbackDateNeedsClarification)}`,
    `Callback time: ${formatValue(memory.callbackTime)}`,
    `Callback time needs clarification: ${formatValue(memory.callbackTimeNeedsClarification)}`,
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
    addressCorrectionConfirmed: memory.addressCorrectionConfirmed,
    businessDetailsCorrectionConfirmed: memory.businessDetailsCorrectionConfirmed,
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
    pendingWebsiteAge: memory.pendingWebsiteAge,
    websiteAgeNeedsClarification: memory.websiteAgeNeedsClarification,
    websiteInterestLevel: memory.websiteInterestLevel,
    onlineEnquiryStatus: memory.onlineEnquiryStatus,
    onlineEnquiryNeedsClarification: memory.onlineEnquiryNeedsClarification,
    interestInMoreEnquiries: memory.interestInMoreEnquiries,
    pendingIndustry: memory.pendingIndustry,
    industry: memory.industry,
    callbackConsent: memory.callbackConsent,
    callbackDate: memory.callbackDate,
    pendingCallbackDate: memory.pendingCallbackDate,
    callbackDateNeedsClarification: memory.callbackDateNeedsClarification,
    callbackTime: memory.callbackTime,
    callbackTimeNeedsClarification: memory.callbackTimeNeedsClarification,
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

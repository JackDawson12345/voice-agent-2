// services/session-memory.js

function createSessionMemory() {
  return {
    customerName: null,
    isBusinessOwner: null,
    businessName: null,
    businessType: null,
    timeInBusiness: null,
    hasCurrentWebsite: null,
    currentWebsite: null,
    hasCurrentSeoPackage: null,
    currentSeoProvider: null,
    mainGoal: null,
    extraNotes: [],
    isInterested: null,
    happyToTransfer: null,
    doNotCall: false,
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
  return /^(yes|yeah|yep|yeh|sure|okay|ok|that'?s fine|fine|please do|go ahead|happy to|i am|we are)\b/i.test(text);
}

function isSimpleNo(text) {
  return /^(no|nope|nah|not really|not at the moment|not now|i'?m not|we'?re not)\b/i.test(text);
}

function looksLikeMarketingProviderAnswer(text) {
  const lower = compactText(text);

  const mentionsMarketing = hasAny(lower, [
    "seo",
    "search engine",
    "google",
    "ads",
    "adwords",
    "ppc",
    "marketing",
    "online marketing",
    "social media",
    "facebook",
    "facebook ads",
    "instagram",
    "meta",
    "tiktok",
    "linkedin",
    "yell",
    "checkatrade",
    "trustatrader",
    "agency",
  ]);

  const soundsLikeTheyHaveSomething =
    /^(yes|yeah|yep|yeh|we|i|they|have|got|using|use|with|currently|already|some|a bit of|paying|paid)\b/i.test(lower) ||
    hasAny(lower, [" have some", " got some", " use ", " using ", " with "]);

  return mentionsMarketing && soundsLikeTheyHaveSomething;
}

function extractWebsite(text) {
  const match = String(text || "").match(
    /((https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z]{2,}){1,3}(\/[\w\-.~:/?#[\]@!$&'()*+,;=%]*)?)/i
  );

  return match ? cleanValue(match[1]) : null;
}

function extractAfterPatterns(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match && match[1]) {
      const value = cleanValue(match[1]);

      if (value) {
        return value;
      }
    }
  }

  return null;
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

  if (!Array.isArray(memory.extraNotes)) {
    memory.extraNotes = [];
  }

  const duplicate = memory.extraNotes.some(
    (existingNote) => compactText(existingNote) === compactText(cleanedNote)
  );

  if (!duplicate) {
    memory.extraNotes.push(cleanedNote);
    changedFields.push("extraNotes");
  }
}

function updateSessionMemoryFromTranscript(memory, transcript, context = {}) {
  const changedFields = [];
  const rawText = cleanValue(transcript);
  const speechText = normaliseSpeechText(rawText);
  const lower = rawText.toLowerCase();
  const speechLower = speechText.toLowerCase();
  const lastAssistant = getLastAssistantMessage(context.conversationHistory || []);
  const lastAssistantLower = lastAssistant.toLowerCase();

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
    setField(memory, "isInterested", "no", changedFields);
    setField(memory, "happyToTransfer", false, changedFields);
  }

  const assistantAskedBusinessOwner = hasAny(lastAssistantLower, [
    "run, own, or manage",
    "run, own or manage",
    "own or manage",
    "run or own",
    "have a business",
    "currently run",
    "currently own",
    "currently manage",
  ]);

  const assistantAskedCustomerName = hasAny(lastAssistantLower, [
    "your name",
    "take your name",
    "who am i speaking",
    "who am i speaking to",
  ]);

  const assistantAskedBusinessName = hasAny(lastAssistantLower, [
    "business name",
    "company name",
    "name of the business",
    "name of your business",
    "what is it called",
    "what's it called",
    "what is your business called",
    "what's your business called",
    "what is the business called",
  ]);

  const assistantAskedBusinessType = hasAny(lastAssistantLower, [
    "business type",
    "what type of business",
    "what does your business do",
    "what do you do",
    "what kind of business",
  ]);

  const assistantAskedTimeInBusiness = hasAny(lastAssistantLower, [
    "how long",
    "been in business",
    "been trading",
  ]);

  const assistantAskedWebsite = hasAny(lastAssistantLower, [
    "currently have a website",
    "have a website",
    "website address",
    "website at the moment",
  ]);

  const assistantAskedSeo = hasAny(lastAssistantLower, [
    "seo",
    "google marketing",
    "online marketing package",
    "marketing package",
    "search engine",
  ]);

  const assistantAskedGoal = hasAny(lastAssistantLower, [
    "improve online",
    "more enquiries",
    "better rankings",
    "local visibility",
    "anything specific",
    "what would you like",
  ]);

  const assistantAskedTransfer = hasAny(lastAssistantLower, [
    "put you through",
    "happy for me to put",
    "transfer you",
    "connect you",
    "speak to someone",
    "speak with someone",
    "member of the team",
  ]);

  const explicitCustomerName =
    extractAfterPatterns(speechText, [
      /(?:my name is|this is|i am|i'm)\s+([a-z][a-z .'-]{1,50})$/i,
      /(?:hello|hi|hiya)?\s*([a-z][a-z .'-]{1,50})\s+(?:speaking|here)$/i,
    ]) ||
    extractAfterPatterns(rawText, [
      /(?:my name is|this is|i am|i'm)\s+([a-z][a-z .'-]{1,50})$/i,
      /(?:hello|hi|hiya)?[\s,.]*([a-z][a-z .'-]{1,50})\s+(?:speaking|here)$/i,
    ]);

  const customerNameFromAnswer = assistantAskedCustomerName
    ? extractAfterPatterns(speechText, [
        /(?:my name is|i am|i'm|this is|it is|it's)\s+([a-z][a-z .'-]{1,50})$/i,
      ])
    : null;

  const customerName = explicitCustomerName || customerNameFromAnswer;

  if (customerName && !hasAny(customerName.toLowerCase(), ["not", "calling", "business", "website", "seo", "marketing", "telecoms", "internet"])) {
    setField(memory, "customerName", customerName, changedFields);
  } else if (assistantAskedCustomerName && !isSimpleYes(lower) && !isSimpleNo(lower)) {
    setField(memory, "customerName", rawText, changedFields);
  }

  const businessName = extractAfterPatterns(rawText, [
    /(?:business is called|company is called|business name is|company name is|my business is|my company is|we are called|we're called|it is called|it's called|called)\s+(.{2,80})$/i,
  ]);

  const businessNameFromDirectAnswer = assistantAskedBusinessName
    ? extractAfterPatterns(rawText, [
        /^(?:it is|it's|this is|that is|that's)\s+(.{2,80})$/i,
      ])
    : null;

  if ((businessName || businessNameFromDirectAnswer) && !assistantAskedBusinessType) {
    setField(memory, "businessName", businessName || businessNameFromDirectAnswer, changedFields);
  } else if (businessName && !assistantAskedBusinessType) {
    setField(memory, "businessName", businessName, changedFields);
  } else if (assistantAskedBusinessName && !isSimpleYes(lower) && !isSimpleNo(lower)) {
    const sameAsCustomerName =
      memory.customerName && compactText(rawText) === compactText(memory.customerName);

    const looksLikeOnlyBusinessType = hasAny(compactText(rawText), [
      "walking",
      "marketing",
      "telecoms",
      "plumbing",
      "roofing",
      "cleaning",
      "landscaping",
    ]) && rawText.split(/\s+/).length === 1;

    // If the caller repeats only their own name or gives one generic trade word,
    // avoid treating that as a reliable business name. The AI can ask once more,
    // but the transfer will not be blocked forever if the rest of the lead is good.
    if (!sameAsCustomerName && !looksLikeOnlyBusinessType) {
      setField(memory, "businessName", rawText, changedFields);
    }
  }

  const website = extractWebsite(rawText);

  if (website) {
    setField(memory, "hasCurrentWebsite", "yes", changedFields);
    setField(memory, "currentWebsite", website, changedFields);
  }

  const timeInBusiness = extractAfterPatterns(rawText, [
    /(?:for|about|around|roughly|nearly|just over|over)\s+([a-z0-9 .'-]+\s+(?:year|years|month|months|week|weeks))\b/i,
    /(?:been trading|been in business|running for|open for)\s+([a-z0-9 .'-]+)$/i,
    /\b(\d+\s*(?:year|years|month|months))\b/i,
  ]);

  if (timeInBusiness) {
    setField(memory, "timeInBusiness", timeInBusiness, changedFields);
  } else if (assistantAskedTimeInBusiness && !isSimpleYes(lower) && !isSimpleNo(lower)) {
    setField(memory, "timeInBusiness", rawText, changedFields);
  }

  if (assistantAskedBusinessOwner) {
    if (
      isSimpleYes(lower) ||
      hasAny(lower, [
        "i do",
        "we do",
        "i did",
        "we did",
        "i run",
        "i own",
        "i manage",
        "we run",
        "we own",
        "we manage",
      ])
    ) {
      setField(memory, "isBusinessOwner", "yes", changedFields);
    }

    if (isSimpleNo(lower) || hasAny(lower, ["i don't", "i do not", "we don't", "we do not"])) {
      setField(memory, "isBusinessOwner", "no", changedFields);
      setField(memory, "isInterested", "no", changedFields);
    }
  }

  if (hasAny(lower, ["i run a ", "i own a ", "we run a ", "we own a ", "i have a ", "we have a "])) {
    setField(memory, "isBusinessOwner", "yes", changedFields);
  }

  const businessType = extractAfterPatterns(rawText, [
    /(?:i run a|i own a|we run a|we own a|i have a|we have a)\s+(.{2,80})$/i,
    /(?:it is a|it's a|we are a|we're a|we do|i do)\s+(.{2,80})$/i,
  ]);

  if (businessType && !website) {
    setField(memory, "businessType", businessType, changedFields);
  } else if (assistantAskedBusinessType && !isSimpleYes(lower) && !isSimpleNo(lower)) {
    setField(memory, "businessType", rawText, changedFields);
  }

  if (assistantAskedWebsite) {
    if (isSimpleYes(lower) || hasAny(lower, ["we do", "i do", "we have", "i have", "got one", "yes we have", "yes i have"])) {
      setField(memory, "hasCurrentWebsite", "yes", changedFields);
    }

    if (isSimpleNo(lower) || hasAny(lower, ["no website", "don't have a website", "do not have a website", "haven't got one", "not got one"])) {
      setField(memory, "hasCurrentWebsite", "no", changedFields);
    }
  } else if (hasAny(lower, ["no website", "don't have a website", "do not have a website", "haven't got a website"])) {
    setField(memory, "hasCurrentWebsite", "no", changedFields);
  } else if (hasAny(lower, ["have a website", "got a website", "we have one", "i have one"])) {
    setField(memory, "hasCurrentWebsite", "yes", changedFields);
  }

  if (assistantAskedSeo) {
    if (
      isSimpleYes(lower) ||
      hasAny(lower, [
        "we do",
        "i do",
        "we have",
        "i have",
        "have some",
        "got some",
        "already have seo",
        "got seo",
        "using seo",
        "using marketing",
        "with a marketing",
        "with an agency",
      ]) ||
      looksLikeMarketingProviderAnswer(rawText)
    ) {
      setField(memory, "hasCurrentSeoPackage", "yes", changedFields);

      if (!isSimpleYes(lower)) {
        setField(memory, "currentSeoProvider", rawText, changedFields);
      }
    }

    if (isSimpleNo(lower) || hasAny(lower, ["no seo", "don't have seo", "do not have seo", "not doing seo", "no marketing package", "nothing at the moment", "not currently"])) {
      setField(memory, "hasCurrentSeoPackage", "no", changedFields);
    }
  } else if (hasAny(lower, ["already have seo", "got seo", "we do seo", "have a marketing package"]) || looksLikeMarketingProviderAnswer(rawText)) {
    setField(memory, "hasCurrentSeoPackage", "yes", changedFields);
    setField(memory, "currentSeoProvider", rawText, changedFields);
  } else if (hasAny(lower, ["no seo", "don't have seo", "do not have seo", "not doing seo", "no marketing package"])) {
    setField(memory, "hasCurrentSeoPackage", "no", changedFields);
  }

  if (assistantAskedGoal && !isSimpleYes(lower) && !isSimpleNo(lower)) {
    setField(memory, "mainGoal", rawText, changedFields);
  }

  if (
    hasAny(lower, [
      "more enquiries",
      "more leads",
      "better rankings",
      "rank higher",
      "search visibility",
      "visibility",
      "online visibility",
      "more local work",
      "new website",
      "better website",
      "google",
      "get found",
    ])
  ) {
    if (!memory.mainGoal) {
      setField(memory, "mainGoal", rawText, changedFields);
    } else {
      pushNote(memory, rawText, changedFields);
    }
  }

  if (assistantAskedTransfer) {
    if (isSimpleYes(lower) || hasAny(lower, ["put me through", "transfer me", "connect me", "that's fine", "that is fine"])) {
      setField(memory, "happyToTransfer", true, changedFields);
      setField(memory, "isInterested", "yes", changedFields);
    }

    if (isSimpleNo(lower) || hasAny(lower, ["not now", "not today", "don't transfer", "do not transfer", "rather not"])) {
      setField(memory, "happyToTransfer", false, changedFields);
    }
  }

  if (
    hasAny(lower, [
      "i'm interested",
      "i am interested",
      "we're interested",
      "we are interested",
      "sounds good",
      "sounds useful",
      "tell me more",
      "go on",
    ])
  ) {
    setField(memory, "isInterested", "yes", changedFields);
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
    setField(memory, "isInterested", "no", changedFields);
    setField(memory, "happyToTransfer", false, changedFields);
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
    `Customer name: ${formatValue(memory.customerName)}`,
    `Runs, owns, or manages a business: ${formatValue(memory.isBusinessOwner)}`,
    `Business name: ${formatValue(memory.businessName)}`,
    `Business type: ${formatValue(memory.businessType)}`,
    `Time in business: ${formatValue(memory.timeInBusiness)}`,
    `Has current website: ${formatValue(memory.hasCurrentWebsite)}`,
    `Website address: ${formatValue(memory.currentWebsite)}`,
    `Has current SEO or online marketing package: ${formatValue(memory.hasCurrentSeoPackage)}`,
    `Current SEO or marketing provider/details: ${formatValue(memory.currentSeoProvider)}`,
    `Main online goal: ${formatValue(memory.mainGoal)}`,
    `Extra notes: ${formatValue(memory.extraNotes)}`,
    `Interested: ${formatValue(memory.isInterested)}`,
    `Happy to transfer now: ${formatValue(memory.happyToTransfer)}`,
    `Do not call: ${formatValue(memory.doNotCall)}`,
  ].join("\n");
}

function formatSessionMemoryForLog(memory) {
  return {
    customerName: memory.customerName,
    isBusinessOwner: memory.isBusinessOwner,
    businessName: memory.businessName,
    businessType: memory.businessType,
    timeInBusiness: memory.timeInBusiness,
    hasCurrentWebsite: memory.hasCurrentWebsite,
    currentWebsite: memory.currentWebsite,
    hasCurrentSeoPackage: memory.hasCurrentSeoPackage,
    currentSeoProvider: memory.currentSeoProvider,
    mainGoal: memory.mainGoal,
    extraNotes: memory.extraNotes,
    isInterested: memory.isInterested,
    happyToTransfer: memory.happyToTransfer,
    doNotCall: memory.doNotCall,
    lastUpdatedAt: memory.lastUpdatedAt,
  };
}

module.exports = {
  createSessionMemory,
  updateSessionMemoryFromTranscript,
  formatSessionMemoryForPrompt,
  formatSessionMemoryForLog,
};

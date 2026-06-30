// services/session-memory.js

function createSessionMemory() {
  return {
    customerName: null,
    businessName: null,
    businessType: null,
    isInterested: null,
    wantsCallback: false,
    callbackName: null,
    callbackPhone: null,
    callbackTime: null,
    doNotCall: false,
    objections: [],
    notes: [],
    transcript: [],
    phoneDigitBuffer: "",
    pendingHalfPast: false,
  };
}

function cleanText(text) {
  return String(text || "").trim();
}

function addUnique(array, value) {
  const cleanValue = cleanText(value);

  if (!cleanValue) {
    return false;
  }

  const alreadyExists = array.some(
    (item) => item.toLowerCase() === cleanValue.toLowerCase()
  );

  if (alreadyExists) {
    return false;
  }

  array.push(cleanValue);
  return true;
}

function normaliseName(name) {
  if (!name) {
    return null;
  }

  let cleanName = name
    .replace(/[.,!?]/g, "")
    .replace(/\b(speaking|calling|here|from|at|with)\b/gi, "")
    .trim();

  const parts = cleanName.split(/\s+/).filter(Boolean);

  if (!parts.length) {
    return null;
  }

  return parts
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function extractCustomerName(transcript) {
  const patterns = [
    /\bmy name is\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    /\bi am\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    /\bi'm\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    /\bthis is\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    /\b([a-zA-Z]+(?:\s+[a-zA-Z]+)?)\s+speaking\b/i,
    /\b([a-zA-Z]+(?:\s+[a-zA-Z]+)?)\s+here\b/i,
  ];

  for (const pattern of patterns) {
    const match = transcript.match(pattern);

    if (match && match[1]) {
      const name = normaliseName(match[1]);
      const blocked = ["Hello", "Hi", "Yes", "No", "Yeah"];

      if (name && !blocked.includes(name)) {
        return name;
      }
    }
  }

  return null;
}

function extractBusinessName(transcript) {
  const patterns = [
    /\bfrom\s+([a-zA-Z0-9&' -]{2,50})(?:\.|,|$)/i,
    /\bat\s+([a-zA-Z0-9&' -]{2,50})(?:\.|,|$)/i,
    /\bwith\s+([a-zA-Z0-9&' -]{2,50})(?:\.|,|$)/i,
    /\bmy business is\s+([a-zA-Z0-9&' -]{2,50})(?:\.|,|$)/i,
    /\bthe business is\s+([a-zA-Z0-9&' -]{2,50})(?:\.|,|$)/i,
  ];

  for (const pattern of patterns) {
    const match = transcript.match(pattern);

    if (match && match[1]) {
      const businessName = match[1]
        .replace(/\b(speaking|calling|here)\b/gi, "")
        .trim();

      if (businessName.length >= 2) {
        return businessName;
      }
    }
  }

  return null;
}

function extractBusinessType(transcript) {
  const lower = transcript.toLowerCase();

  const patterns = [
    /\ba\s+([a-zA-Z -]{3,40})\s+business\b/i,
    /\ban\s+([a-zA-Z -]{3,40})\s+business\b/i,
    /\bwe do\s+([a-zA-Z -]{3,40})(?:\.|,|$)/i,
    /\bwe're\s+([a-zA-Z -]{3,40})(?:\.|,|$)/i,
    /\bwe are\s+([a-zA-Z -]{3,40})(?:\.|,|$)/i,
  ];

  for (const pattern of patterns) {
    const match = transcript.match(pattern);

    if (match && match[1]) {
      const value = match[1].trim();

      if (value.length >= 3) {
        return value;
      }
    }
  }

  const commonTypes = [
    "landscaping",
    "roofing",
    "plumbing",
    "electrical",
    "cleaning",
    "building",
    "joinery",
    "carpentry",
    "gardening",
    "beauty",
    "aesthetics",
    "taxi",
    "locksmith",
    "pest control",
  ];

  for (const type of commonTypes) {
    if (lower.includes(type)) {
      return type;
    }
  }

  return null;
}

function extractPhoneNumberFromDigits(transcript) {
  const match = transcript.match(/(\+?\d[\d\s().-]{7,}\d)/);

  if (!match) {
    return null;
  }

  return match[1].replace(/[^\d+]/g, "").trim();
}

function getDigitWordCount(transcript) {
  const digitWords = new Set([
    "zero",
    "oh",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
  ]);

  const words = transcript
    .toLowerCase()
    .replace(/[.,!?]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  return words.filter((word) => digitWords.has(word) || /^\d+$/.test(word))
    .length;
}

function wordsToDigits(transcript) {
  const wordMap = {
    zero: "0",
    oh: "0",
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

  const words = transcript
    .toLowerCase()
    .replace(/[.,!?]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  let digits = "";

  for (const word of words) {
    if (wordMap[word] !== undefined) {
      digits += wordMap[word];
      continue;
    }

    if (/^\d+$/.test(word)) {
      digits += word;
    }
  }

  return digits;
}

function wordToHour(value) {
  const map = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
  };

  if (/^\d{1,2}$/.test(value)) {
    return Number(value);
  }

  return map[value.toLowerCase()] || null;
}

function extractCallbackTime(memory, transcript) {
  const lower = transcript.toLowerCase();

  const hasTomorrow = lower.includes("tomorrow");
  const hasToday = lower.includes("today");
  const hasAfternoon = lower.includes("afternoon");
  const hasEvening = lower.includes("evening");
  const hasMorning = lower.includes("morning");

  let day = null;

  if (hasTomorrow) {
    day = "tomorrow";
  } else if (hasToday) {
    day = "today";
  } else if (lower.includes("next week")) {
    day = "next week";
  }

  if (
    lower.includes("half") &&
    !/\bhalf\s+(past\s+)?([a-zA-Z]+|\d{1,2})\b/i.test(lower)
  ) {
    memory.pendingHalfPast = true;
    return null;
  }

  const halfMatch = lower.match(/\bhalf\s+(past\s+)?([a-zA-Z]+|\d{1,2})\b/i);

  if (halfMatch) {
    const hour = wordToHour(halfMatch[2]);

    if (hour) {
      let suffix = "";

      if (hasAfternoon || hasEvening) {
        suffix = "pm";
      } else if (hasMorning) {
        suffix = "am";
      }

      return `${hour}:30${suffix}${day ? ` ${day}` : ""}`.trim();
    }
  }

  if (memory.pendingHalfPast) {
    const hourWordMatch = lower.match(
      /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})\b/i
    );

    if (hourWordMatch) {
      const hour = wordToHour(hourWordMatch[1]);

      if (hour) {
        memory.pendingHalfPast = false;

        let suffix = "";

        if (hasAfternoon || hasEvening) {
          suffix = "pm";
        } else if (hasMorning) {
          suffix = "am";
        }

        return `${hour}:30${suffix}${day ? ` ${day}` : ""}`.trim();
      }
    }
  }

  const exactTimeMatch = lower.match(/\b(\d{1,2})(:\d{2})?\s?(am|pm)\b/i);

  if (exactTimeMatch) {
    return `${exactTimeMatch[0]}${day ? ` ${day}` : ""}`.trim();
  }

  if (lower.includes("tomorrow afternoon")) {
    return "tomorrow afternoon";
  }

  if (lower.includes("tomorrow morning")) {
    return "tomorrow morning";
  }

  if (lower.includes("tomorrow evening")) {
    return "tomorrow evening";
  }

  if (lower.includes("today afternoon") || lower.includes("this afternoon")) {
    return "this afternoon";
  }

  if (lower.includes("today morning") || lower.includes("this morning")) {
    return "this morning";
  }

  if (lower.includes("today evening") || lower.includes("this evening")) {
    return "this evening";
  }

  const timeWords = [
    "tomorrow",
    "today",
    "morning",
    "afternoon",
    "evening",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "next week",
    "later",
    "anytime",
    "any time",
  ];

  for (const word of timeWords) {
    if (lower.includes(word)) {
      return word;
    }
  }

  return null;
}

function detectInterest(transcript) {
  const lower = transcript.toLowerCase();

  const doNotCallPhrases = [
    "do not call",
    "don't call",
    "stop calling",
    "remove me",
    "take me off",
    "take us off",
    "not call again",
  ];

  if (doNotCallPhrases.some((phrase) => lower.includes(phrase))) {
    return {
      doNotCall: true,
      isInterested: "no",
    };
  }

  const negativePhrases = [
    "not interested",
    "no thanks",
    "no thank you",
    "not for me",
    "not right now",
    "we're fine",
    "we are fine",
    "already sorted",
  ];

  if (negativePhrases.some((phrase) => lower.includes(phrase))) {
    return {
      doNotCall: false,
      isInterested: "no",
    };
  }

  const positivePhrases = [
    "yes",
    "yeah",
    "interested",
    "sounds good",
    "sounds interesting",
    "definitely",
    "tell me more",
    "go on",
    "what do you offer",
    "how much",
    "send me",
    "call me back",
    "callback",
    "call back",
  ];

  if (positivePhrases.some((phrase) => lower.includes(phrase))) {
    return {
      doNotCall: false,
      isInterested: "yes",
    };
  }

  return {
    doNotCall: false,
    isInterested: null,
  };
}

function detectCallbackIntent(transcript) {
  const lower = transcript.toLowerCase();

  return (
    lower.includes("call me back") ||
    lower.includes("callback") ||
    lower.includes("call back") ||
    lower.includes("ring me back") ||
    lower.includes("phone me back") ||
    lower.includes("call tomorrow") ||
    lower.includes("call today") ||
    lower.includes("call next week") ||
    lower.includes("ring tomorrow") ||
    lower.includes("ring today") ||
    lower.includes("speak tomorrow") ||
    lower.includes("speak next week")
  );
}

function detectObjection(transcript) {
  const lower = transcript.toLowerCase();

  const objections = [];

  if (lower.includes("too expensive") || lower.includes("cost too much")) {
    objections.push("Price concern");
  }

  if (lower.includes("already have") || lower.includes("already got")) {
    objections.push("Already has a provider or website");
  }

  if (lower.includes("busy") || lower.includes("not a good time")) {
    objections.push("Busy or bad timing");
  }

  if (lower.includes("no budget") || lower.includes("can't afford")) {
    objections.push("Budget concern");
  }

  if (lower.includes("send an email") || lower.includes("email me")) {
    objections.push("Asked for information by email");
  }

  if (lower.includes("not interested")) {
    objections.push("Not interested");
  }

  return objections;
}

function updateSessionMemoryFromTranscript(memory, transcript) {
  const cleanTranscript = cleanText(transcript);
  const changedFields = [];

  if (!cleanTranscript) {
    return {
      memory,
      changedFields,
    };
  }

  memory.transcript.push(cleanTranscript);

  const customerName = extractCustomerName(cleanTranscript);

  if (customerName && !memory.customerName) {
    memory.customerName = customerName;
    changedFields.push("customerName");
  }

  const businessName = extractBusinessName(cleanTranscript);

  if (businessName && !memory.businessName) {
    memory.businessName = businessName;
    changedFields.push("businessName");
  }

  const businessType = extractBusinessType(cleanTranscript);

  if (businessType && !memory.businessType) {
    memory.businessType = businessType;
    changedFields.push("businessType");
  }

  const digitPhoneNumber = extractPhoneNumberFromDigits(cleanTranscript);

  if (digitPhoneNumber && !memory.callbackPhone) {
    memory.callbackPhone = digitPhoneNumber;
    changedFields.push("callbackPhone");
  }

  const digitWordCount = getDigitWordCount(cleanTranscript);
  const spokenDigits = wordsToDigits(cleanTranscript);

  if (
    spokenDigits &&
    !memory.callbackPhone &&
    (digitWordCount >= 2 || memory.phoneDigitBuffer.length > 0)
  ) {
    memory.phoneDigitBuffer += spokenDigits;

    if (!changedFields.includes("phoneDigitBuffer")) {
      changedFields.push("phoneDigitBuffer");
    }

    if (memory.phoneDigitBuffer.length >= 10) {
      memory.callbackPhone = memory.phoneDigitBuffer;
      changedFields.push("callbackPhone");
    }
  }

  const callbackTime = extractCallbackTime(memory, cleanTranscript);

  if (callbackTime && !memory.callbackTime) {
    memory.callbackTime = callbackTime;
    changedFields.push("callbackTime");
  }

  if (callbackTime && !memory.wantsCallback) {
    memory.wantsCallback = true;
    changedFields.push("wantsCallback");
  }

  const interest = detectInterest(cleanTranscript);

  if (interest.doNotCall && !memory.doNotCall) {
    memory.doNotCall = true;
    changedFields.push("doNotCall");
  }

  if (interest.isInterested) {
    const hasPositiveLead =
      memory.isInterested === "yes" ||
      memory.wantsCallback ||
      memory.callbackPhone ||
      memory.callbackTime;

    if (interest.isInterested === "no" && hasPositiveLead) {
      // Do not downgrade a positive lead once callback details have been collected.
    } else if (memory.isInterested !== interest.isInterested) {
      memory.isInterested = interest.isInterested;
      changedFields.push("isInterested");
    }
  }

  if (detectCallbackIntent(cleanTranscript) && !memory.wantsCallback) {
    memory.wantsCallback = true;
    changedFields.push("wantsCallback");
  }

  if (memory.customerName && !memory.callbackName) {
    memory.callbackName = memory.customerName;
    changedFields.push("callbackName");
  }

  const objections = detectObjection(cleanTranscript);

  for (const objection of objections) {
    const added = addUnique(memory.objections, objection);

    if (added) {
      changedFields.push("objections");
    }
  }

  return {
    memory,
    changedFields,
  };
}

function formatSessionMemoryForPrompt(memory) {
  const lines = [];

  lines.push(`Customer name: ${memory.customerName || "unknown"}`);
  lines.push(`Business name: ${memory.businessName || "unknown"}`);
  lines.push(`Business type: ${memory.businessType || "unknown"}`);
  lines.push(`Interested: ${memory.isInterested || "unknown"}`);
  lines.push(`Wants callback: ${memory.wantsCallback ? "yes" : "unknown"}`);
  lines.push(`Callback name: ${memory.callbackName || "unknown"}`);
  lines.push(`Callback phone: ${memory.callbackPhone || "unknown"}`);
  lines.push(`Callback time: ${memory.callbackTime || "unknown"}`);
  lines.push(`Do not call: ${memory.doNotCall ? "yes" : "no"}`);

  if (memory.objections.length) {
    lines.push(`Objections: ${memory.objections.join(", ")}`);
  } else {
    lines.push("Objections: none known");
  }

  return lines.join("\n");
}

function formatSessionMemoryForLog(memory) {
  return {
    customerName: memory.customerName,
    businessName: memory.businessName,
    businessType: memory.businessType,
    isInterested: memory.isInterested,
    wantsCallback: memory.wantsCallback,
    callbackName: memory.callbackName,
    callbackPhone: memory.callbackPhone,
    callbackTime: memory.callbackTime,
    doNotCall: memory.doNotCall,
    objections: memory.objections,
    phoneDigitBuffer: memory.phoneDigitBuffer,
    pendingHalfPast: memory.pendingHalfPast,
  };
}

module.exports = {
  createSessionMemory,
  updateSessionMemoryFromTranscript,
  formatSessionMemoryForPrompt,
  formatSessionMemoryForLog,
};

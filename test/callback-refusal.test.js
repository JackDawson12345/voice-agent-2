const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  createSessionMemory,
  updateSessionMemoryFromTranscript,
  formatSessionMemoryForLog,
} = require("../services/session-memory");
const {
  buildCallbackDeclinedMessage,
  getScriptedNextQuestion,
  getNextStepInstruction,
  inferQuestionKeyFromAssistantReply,
  hasCallbackSlot,
  hasDeclinedCallback,
} = require("../services/survey-script");

const completedSurvey = {
  isBusinessOwner: "yes",
  isDecisionMaker: "yes",
  addressConfirmed: "yes",
  businessDetailsConfirmed: "yes",
  contactName: "Jack",
  websiteStatus: "no",
  websiteInterestLevel: "no",
  onlineEnquiryStatus: "yes",
  interestInMoreEnquiries: "yes",
  industry: "dog walking",
};

function answer(memory, text, expectedKey) {
  const promptText = getScriptedNextQuestion(memory);
  const promptKey = inferQuestionKeyFromAssistantReply(promptText);
  assert.equal(promptKey, expectedKey, promptText);
  updateSessionMemoryFromTranscript(memory, text, { promptKey, promptText });
}

function assertDeclined(memory) {
  assert.equal(memory.callbackConsent, "no");
  assert.equal(memory.callbackRequested, false);
  assert.equal(memory.callbackConfirmed, false);
  assert.equal(memory.callbackDate, null);
  assert.equal(memory.callbackTime, null);
  assert.equal(hasCallbackSlot(memory), false);
  assert.equal(getScriptedNextQuestion(memory), null);
  assert.match(getNextStepInstruction(memory), /declined a callback/);
  assert.match(buildCallbackDeclinedMessage(), /won't arrange a callback.*Goodbye/);
  assert.doesNotMatch(buildCallbackDeclinedMessage(), /\?/);
}

test("the log's non-owner sequence stops at No. Thank you.", () => {
  const memory = createSessionMemory();
  answer(memory, "No. I'm not.", "owner_status");
  answer(memory, "No. I'm not.", "financial_authority");
  assert.doesNotMatch(getScriptedNextQuestion(memory), /what day|what time/i);
  answer(memory, "No. Thank you.", "callback_consent");
  assertDeclined(memory);
});

for (const key of ["callback_consent", "callback_day", "callback_time"]) {
  for (const refusal of ["No.", "No. Thank you.", "No thanks.", "I don't wanna call back.", "I don't want a callback.", "I don’t want a call back.", "None."]) {
    test(`${key} accepts refusal: ${refusal}`, () => {
      const memory = Object.assign(createSessionMemory(), completedSurvey,
        key === "callback_consent" ? {} : { callbackConsent: "yes", callbackRequested: true },
        key === "callback_time" ? { callbackDate: "tomorrow" } : {});
      answer(memory, refusal, key);
      assertDeclined(memory);
      assert.equal(memory.interestInMoreEnquiries, "yes");
      assert.equal(memory.doNotCall, false);
      assert.equal(formatSessionMemoryForLog(memory).callbackRequested, false);
    });
  }
}

test("legacy combined callback/day questions also accept a refusal", () => {
  const memory = Object.assign(createSessionMemory(), { isDecisionMaker: "no" });
  updateSessionMemoryFromTranscript(memory, "No. Thank you.", {
    conversationHistory: [{
      role: "assistant",
      content: "Could we give you a call back when the owner is available? What day would suit best?",
    }],
  });
  assertDeclined(memory);
});

test("a refusal clears stale callback details and cannot be overwritten by a later fragment", () => {
  const memory = Object.assign(createSessionMemory(), {
    callbackConsent: "yes",
    callbackRequested: true,
    callbackDate: "No. Thank you",
    callbackTime: "3 pm",
    callbackConfirmed: true,
    busy: true,
  });
  updateSessionMemoryFromTranscript(memory, "I don't wanna call back.", { promptKey: "callback_time" });
  assertDeclined(memory);
  assert.equal(memory.busy, false);
  updateSessionMemoryFromTranscript(memory, "tomorrow at 4 pm", { promptKey: "callback_time" });
  assertDeclined(memory);
});

test("an explicit callback refusal is recognised outside scheduling questions", () => {
  for (const text of ["I don't want a callback", "I don't want you to call me back", "No callback please"]) {
    const memory = createSessionMemory();
    updateSessionMemoryFromTranscript(memory, text, { promptKey: "address_confirmation" });
    assertDeclined(memory);
    assert.equal(memory.addressConfirmed, null);
  }
});

test("refusal takes priority over dates or times mentioned in the same answer", () => {
  const memory = Object.assign(createSessionMemory(), completedSurvey);
  answer(memory, "No thanks, I am busy tomorrow afternoon", "callback_consent");
  assertDeclined(memory);
});

test("busy callers can decline a later call without the scheduling loop restarting", () => {
  const memory = Object.assign(createSessionMemory(), { busy: true, callbackRequested: true });
  answer(memory, "No", "callback_day");
  assertDeclined(memory);
});

test("declined callback state blocks even an old saved slot", () => {
  const memory = Object.assign(createSessionMemory(), completedSurvey, {
    callbackConsent: "no", callbackDate: "tomorrow", callbackTime: "3 pm",
  });
  assert.equal(hasDeclinedCallback(memory), true);
  assert.equal(hasCallbackSlot(memory), false);
  assert.equal(getScriptedNextQuestion(memory), null);
  assert.match(getNextStepInstruction(memory), /declined a callback/);
});

test("accepted callbacks still collect a day and time", () => {
  for (const startingMemory of [completedSurvey, {
    isBusinessOwner: "no", authorisedDecisionMaker: "no", isDecisionMaker: "no",
  }]) {
    const memory = Object.assign(createSessionMemory(), startingMemory);
    answer(memory, "Yes", "callback_consent");
    answer(memory, "Tomorrow", "callback_day");
    answer(memory, "3 pm", "callback_time");
    assert.equal(memory.callbackConsent, "yes");
    assert.equal(memory.callbackRequested, true);
    assert.equal(memory.callbackDate, "Tomorrow");
    assert.equal(memory.callbackTime, "3 pm");
    assert.equal(hasCallbackSlot(memory), true);
  }
});

test("No with a replacement slot can reschedule instead of declining", () => {
  const memory = Object.assign(createSessionMemory(), completedSurvey, {
    callbackConsent: "yes", callbackRequested: true,
  });
  answer(memory, "No, Friday at 3 pm instead", "callback_day");
  assert.equal(memory.callbackConsent, "yes");
  assert.equal(memory.callbackDate, "Friday");
  assert.equal(memory.callbackTime, "3 pm");
  assert.equal(hasCallbackSlot(memory), true);
});

test("uncertainty or a rejected day does not become an appointment", () => {
  for (const text of ["I don't know yet", "Not tomorrow", "I'll check my diary"]) {
    const memory = Object.assign(createSessionMemory(), completedSurvey, { callbackConsent: "yes" });
    answer(memory, text, "callback_day");
    assert.equal(memory.callbackDate, null);
    assert.equal(memory.callbackConsent, "yes");
    assert.equal(hasCallbackSlot(memory), false);
    assert.equal(inferQuestionKeyFromAssistantReply(getScriptedNextQuestion(memory)), "callback_day");
  }
});

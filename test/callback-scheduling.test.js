const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createSessionMemory, updateSessionMemoryFromTranscript } = require("../services/session-memory");
const { getScriptedNextQuestion, inferQuestionKeyFromAssistantReply, hasCallbackSlot } = require("../services/survey-script");

function schedulingMemory(fields = {}) {
  return Object.assign(createSessionMemory(), {
    isBusinessOwner: "yes", isDecisionMaker: "yes", addressConfirmed: "yes",
    businessDetailsConfirmed: "yes", contactName: "Jack", websiteStatus: "yes",
    websiteAge: "two years", onlineEnquiryStatus: "yes", interestInMoreEnquiries: "yes",
    industry: "dog walking", callbackConsent: "yes", callbackRequested: true,
  }, fields);
}

function answer(memory, text, expectedKey) {
  const promptText = getScriptedNextQuestion(memory);
  const promptKey = inferQuestionKeyFromAssistantReply(promptText);
  assert.equal(promptKey, expectedKey, promptText);
  updateSessionMemoryFromTranscript(memory, text, { promptKey, promptText });
}

test("the log's Rider and Ten PM sequence confirms Friday and asks for a daytime replacement", () => {
  const memory = schedulingMemory();
  answer(memory, "Rider.", "callback_day");
  assert.equal(memory.callbackDate, null);
  assert.equal(memory.pendingCallbackDate, "Friday");
  assert.equal(getScriptedNextQuestion(memory), "Did you say Friday for the callback?");
  answer(memory, "Yes.", "callback_day_confirmation");
  assert.equal(memory.callbackDate, "Friday");
  assert.equal(memory.pendingCallbackDate, null);
  assert.match(getScriptedNextQuestion(memory), /between 9am and 5pm/);
  answer(memory, "Ten PM.", "callback_time");
  assert.equal(memory.callbackTime, null);
  assert.equal(hasCallbackSlot(memory), false);
  assert.equal(memory.callbackConfirmed, false);
  assert.match(getScriptedNextQuestion(memory), /specific time between 9am and 5pm/);
  answer(memory, "Ten AM.", "callback_time");
  assert.equal(memory.callbackTime, "ten am");
  assert.equal(memory.callbackTimeNeedsClarification, false);
  assert.equal(hasCallbackSlot(memory), true);
});

test("rejecting a suggested Friday keeps consent and accepts another day", () => {
  const memory = schedulingMemory();
  answer(memory, "Rider", "callback_day");
  answer(memory, "No", "callback_day_confirmation");
  assert.equal(memory.pendingCallbackDate, null);
  assert.equal(memory.callbackDate, null);
  assert.equal(memory.callbackConsent, "yes");
  assert.equal(memory.callbackRequested, true);
  answer(memory, "Next Monday", "callback_day");
  assert.equal(memory.callbackDate, "Next Monday");
});

test("a correction can replace the suggested day and include a valid time", () => {
  const memory = schedulingMemory();
  answer(memory, "Next rider", "callback_day");
  assert.equal(memory.pendingCallbackDate, "next Friday");
  answer(memory, "No, Thursday at 3 pm", "callback_day_confirmation");
  assert.equal(memory.callbackDate, "Thursday");
  assert.equal(memory.callbackTime, "3 pm");
  assert.equal(hasCallbackSlot(memory), true);
});

test("an uncertain confirmation cannot book Friday and explicit refusal clears the suggestion", () => {
  const memory = schedulingMemory();
  answer(memory, "Rider", "callback_day");
  answer(memory, "Maybe", "callback_day_confirmation");
  assert.equal(memory.callbackDate, null);
  assert.equal(hasCallbackSlot(memory), false);
  answer(memory, "I don't want a callback", "callback_day_confirmation");
  assert.equal(memory.pendingCallbackDate, null);
  assert.equal(memory.callbackConsent, "no");
  assert.equal(getScriptedNextQuestion(memory), null);
});

test("unrelated words and numbers do not turn into a callback", () => {
  for (const text of ["Rider", "Ten"]) {
    const memory = createSessionMemory();
    updateSessionMemoryFromTranscript(memory, text, { promptKey: "industry" });
    assert.equal(memory.callbackDate, null);
    assert.equal(memory.pendingCallbackDate, null);
    assert.equal(memory.callbackTime, null);
    assert.equal(memory.callbackRequested, null);
  }
});

test("an unclear day prompts a clearer question without inventing a date", () => {
  const memory = schedulingMemory();
  answer(memory, "I'll check my diary", "callback_day");
  assert.equal(memory.callbackDate, null);
  assert.equal(memory.pendingCallbackDate, null);
  assert.match(getScriptedNextQuestion(memory), /Please say the day/);
});

for (const time of ["9 am", "5 pm", "Ten AM.", "10 a.m.", "3 p.m.", "16:30", "17:00", "half past four", "quarter to five", "noon", "ten", "3", "10 in the morning"]) {
  test(`a time within business hours can be booked: ${time}`, () => {
    const memory = schedulingMemory({ callbackDate: "Friday" });
    answer(memory, time, "callback_time");
    assert.equal(hasCallbackSlot(memory), true, memory.callbackTime);
    assert.equal(memory.callbackTimeNeedsClarification, false);
  });
}

for (const time of ["Ten PM", "8:59 am", "5:01 pm", "18:00", "six", "half past five", "quarter to nine", "25:00", "10:99 am", "13 pm", "evening", "between 4 pm and 6 pm", "4pm to 6pm", "after 5 pm", "10 in the evening", "half past ten pm"]) {
  test(`an out-of-hours or unclear time cannot be booked: ${time}`, () => {
    const memory = schedulingMemory({ callbackDate: "Friday" });
    answer(memory, time, "callback_time");
    assert.equal(memory.callbackTime, null);
    assert.equal(hasCallbackSlot(memory), false);
    assert.equal(memory.callbackConsent, "yes");
    assert.match(getScriptedNextQuestion(memory), /between 9am and 5pm/);
  });
}

test("busy and non-decision-maker flows both offer the 9am-5pm window", () => {
  for (const fields of [{ busy: true }, { isBusinessOwner: "no", isDecisionMaker: "no", authorisedDecisionMaker: "no" }]) {
    const memory = schedulingMemory({ ...fields, callbackDate: "Friday" });
    assert.match(getScriptedNextQuestion(memory), /between 9am and 5pm/);
    answer(memory, "10 pm", "callback_time");
    assert.equal(hasCallbackSlot(memory), false);
    answer(memory, "10 am", "callback_time");
    assert.equal(hasCallbackSlot(memory), true);
  }
});

test("an out-of-hours callback requested during the survey still requires a valid replacement", () => {
  for (const promptKey of ["business_name", "website_age", "owner_status"]) {
    const memory = schedulingMemory();
    updateSessionMemoryFromTranscript(memory, "Call me back Friday at 10 pm", { promptKey });
    assert.equal(memory.callbackDate, "Friday");
    assert.equal(memory.callbackTime, null);
    assert.equal(hasCallbackSlot(memory), false);
    assert.match(getScriptedNextQuestion(memory), /between 9am and 5pm/);
  }
});

test("stale saved out-of-hours slots cannot be confirmed", () => {
  const memory = schedulingMemory({ callbackDate: "Friday", callbackTime: "ten pm" });
  assert.equal(hasCallbackSlot(memory), false);
  assert.match(getScriptedNextQuestion(memory), /between 9am and 5pm/);
});

test("wrong-number and do-not-call responses still stop the day confirmation flow", () => {
  for (const [text, field] of [["Wrong number", "wrongNumber"], ["Do not call me", "doNotCall"]]) {
    const memory = schedulingMemory();
    answer(memory, "Rider", "callback_day");
    answer(memory, text, "callback_day_confirmation");
    assert.equal(memory[field], true);
    assert.equal(getScriptedNextQuestion(memory), null);
    assert.equal(hasCallbackSlot(memory), false);
  }
});

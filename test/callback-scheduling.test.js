const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createSessionMemory, updateSessionMemoryFromTranscript } = require("../services/session-memory");
const { getScriptedNextQuestion, inferQuestionKeyFromAssistantReply, hasCallbackSlot,
  buildCallbackConfirmationMessage } = require("../services/survey-script");
const { callbackTimeMinutes } = require("../services/callback-time");

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

for (const text of ["Anytime.", "Any time", "Anytime is fine", "Any time works for me", "Whenever", "Whenever you like"]) {
  test(`flexible availability completes the callback time: ${text}`, () => {
    const memory = schedulingMemory({ callbackDate: "Friday", callbackTimeNeedsClarification: true });
    answer(memory, text, "callback_time");
    assert.equal(memory.callbackTime, "anytime");
    assert.equal(memory.callbackTimeNeedsClarification, false);
    assert.equal(hasCallbackSlot(memory), true);
    assert.match(buildCallbackConfirmationMessage(memory), /Friday, anytime between 9am and 5pm/);
    assert.equal(callbackTimeMinutes(memory.callbackTime), null, "Do not invent an hour for flexible availability");
  });
}

test("anytime works in the non-decision-maker, busy and combined day/time flows", () => {
  for (const fields of [{ busy: true }, { isBusinessOwner: "no", isDecisionMaker: "no", authorisedDecisionMaker: "no" }]) {
    const memory = schedulingMemory(fields);
    answer(memory, "Friday", "callback_day");
    answer(memory, "Anytime", "callback_time");
    assert.equal(hasCallbackSlot(memory), true);
  }
  for (const text of ["Friday anytime", "Any time on Friday", "Call me back Friday anytime"]) {
    const memory = schedulingMemory();
    answer(memory, text, "callback_day");
    assert.equal(memory.callbackDate, "Friday");
    assert.equal(memory.callbackTime, "anytime");
    assert.equal(hasCallbackSlot(memory), true);
  }
});

test("unrelated and restricted anytime answers do not book an unrestricted callback", () => {
  const unrelated = createSessionMemory();
  updateSessionMemoryFromTranscript(unrelated, "Anytime", { promptKey: "industry" });
  assert.equal(unrelated.callbackTime, null);
  assert.equal(unrelated.callbackRequested, null);
  for (const text of ["Not anytime", "Anytime after 5pm", "Any time before nine", "Anytime Friday morning", "Anytime except lunchtime", "Anytime but Friday"]) {
    const memory = schedulingMemory({ callbackDate: "Friday" });
    answer(memory, text, "callback_time");
    assert.equal(memory.callbackTime, null, text);
    assert.equal(hasCallbackSlot(memory), false, text);
  }
});

for (const [text, expected] of [
  ["3pm", 900], ["3p.m.", 900], ["3 p m", 900], ["Three P.M.", 900],
  ["Friday at 3p.m.", 900], ["3.30pm", 930], ["3 30 PM", 930],
  ["Three thirty PM", 930], ["Three forty-five PM", 945], ["Three oh five PM", 905],
  ["Ten fifteen AM", 615], ["15 30", 930], ["At three thirty in the afternoon", 930],
]) {
  test(`time transcription preserves the full hour and minutes: ${text}`, () => {
    const memory = schedulingMemory({ callbackDate: "Friday" });
    answer(memory, text, "callback_time");
    assert.equal(callbackTimeMinutes(memory.callbackTime), expected, memory.callbackTime);
    assert.equal(hasCallbackSlot(memory), true);
  });
}

test("a missing hour asks a targeted question, then combines the answer with the heard PM", () => {
  const memory = schedulingMemory({ callbackDate: "Friday" });
  answer(memory, "PM.", "callback_time");
  assert.equal(memory.callbackTime, null);
  assert.equal(memory.pendingCallbackMeridiem, "pm");
  assert.equal(hasCallbackSlot(memory), false);
  assert.match(getScriptedNextQuestion(memory), /only caught PM.*say the hour/);
  answer(memory, "Three", "callback_time");
  assert.equal(callbackTimeMinutes(memory.callbackTime), 900);
  assert.equal(memory.pendingCallbackMeridiem, null);
  assert.equal(memory.callbackTimeNeedsClarification, false);
  assert.equal(hasCallbackSlot(memory), true);
});

test("missing AM is retained without turning three AM into a daytime booking", () => {
  const memory = schedulingMemory({ callbackDate: "Friday" });
  answer(memory, "A.M.", "callback_time");
  answer(memory, "Three", "callback_time");
  assert.equal(memory.callbackTime, null);
  assert.equal(hasCallbackSlot(memory), false);
  answer(memory, "Anytime", "callback_time");
  assert.equal(memory.callbackTime, "anytime");
  assert.equal(memory.pendingCallbackMeridiem, null);
});

test("a full replacement or refusal clears a pending meridiem", () => {
  for (const replacement of ["10 AM", "Anytime", "I don't want a callback"]) {
    const memory = schedulingMemory({ callbackDate: "Friday" });
    answer(memory, "PM", "callback_time");
    answer(memory, replacement, "callback_time");
    assert.equal(memory.pendingCallbackMeridiem, null);
    assert.equal(memory.callbackTimeNeedsClarification, false);
    assert.equal(hasCallbackSlot(memory), replacement !== "I don't want a callback");
  }
});

test("a missing meridiem's hour answer can include minutes or an explicit 24-hour replacement", () => {
  for (const [period, time, expected] of [
    ["AM", "Ten thirty", 630], ["AM", "Three thirty", null],
    ["PM", "Quarter past three", 915], ["PM", "13:30", 810],
  ]) {
    const memory = schedulingMemory({ callbackDate: "Friday" });
    answer(memory, period, "callback_time");
    answer(memory, time, "callback_time");
    assert.equal(callbackTimeMinutes(memory.callbackTime), expected, `${period} then ${time}`);
    assert.equal(hasCallbackSlot(memory), expected !== null);
    assert.equal(memory.pendingCallbackMeridiem, null);
  }
});

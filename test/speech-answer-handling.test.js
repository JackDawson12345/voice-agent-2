const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createSessionMemory, updateSessionMemoryFromTranscript } = require("../services/session-memory");
const { getScriptedNextQuestion, inferQuestionKeyFromAssistantReply, hasWebsiteBranchDetail } = require("../services/survey-script");

function websiteMemory() {
  return Object.assign(createSessionMemory(), {
    isBusinessOwner: "yes", isDecisionMaker: "yes", addressConfirmed: "yes",
    businessDetailsConfirmed: "yes", contactName: "Jack", websiteStatus: "yes",
  });
}

function answer(memory, text, key) {
  const promptText = getScriptedNextQuestion(memory);
  const promptKey = inferQuestionKeyFromAssistantReply(promptText);
  assert.equal(promptKey, key, promptText);
  updateSessionMemoryFromTranscript(memory, text, { promptKey, promptText });
}

for (const [text, expected] of [
  ["Yes, two years", "two years"], ["I've had it for two years", "two years"],
  ["We have had it for 3 months", "3 months"], ["Two. Years.", "Two Years"],
  ["Around 2.5 years", "2.5 years"], ["Twenty two years", "Twenty two years"],
  ["A couple of years", "A couple of years"], ["One and a half years", "One and a half years"],
  ["Two years and six months", "Two years and six months"],
]) {
  test(`a complete duration is saved: ${text}`, () => {
    const memory = websiteMemory();
    answer(memory, text, "website_age");
    assert.equal(memory.websiteAge, expected);
    assert.equal(inferQuestionKeyFromAssistantReply(getScriptedNextQuestion(memory)), "online_enquiries");
    assert.equal(memory.callbackRequested, null);
  });
}

for (const text of ["Two yes", "Two. Yes.", "2 yes", "About two yes"]) {
  test(`a likely misheard duration waits for confirmation: ${text}`, () => {
    const memory = websiteMemory();
    answer(memory, text, "website_age");
    assert.equal(memory.websiteAge, null);
    assert.equal(hasWebsiteBranchDetail(memory), false);
    assert.match(getScriptedNextQuestion(memory), /Did you say.*(?:two|2) years/i);
    answer(memory, "Yes, that's correct.", "website_age_confirmation");
    assert.match(memory.websiteAge, /^(?:two|2) years$/i);
    assert.equal(memory.pendingWebsiteAge, null);
    assert.equal(hasWebsiteBranchDetail(memory), true);
  });
}

test("rejecting the proposed duration asks for the unit and accepts a correction", () => {
  const memory = websiteMemory();
  answer(memory, "Two yes", "website_age");
  answer(memory, "No", "website_age_confirmation");
  assert.equal(memory.websiteAge, null);
  assert.equal(memory.pendingWebsiteAge, null);
  assert.match(getScriptedNextQuestion(memory), /how many months or years/);
  answer(memory, "Six months", "website_age");
  assert.equal(memory.websiteAge, "Six months");
});

test("a correction supplied during confirmation replaces the proposed duration", () => {
  const memory = websiteMemory();
  answer(memory, "Two yes", "website_age");
  answer(memory, "No, three years", "website_age_confirmation");
  assert.equal(memory.websiteAge, "three years");
  assert.equal(memory.pendingWebsiteAge, null);
});

for (const text of ["Yes", "Ball. Yes.", "Two", "Years", "Not two years"]) {
  test(`an incomplete duration is clarified without inventing a value: ${text}`, () => {
    const memory = websiteMemory();
    answer(memory, text, "website_age");
    assert.equal(memory.websiteAge, null);
    assert.equal(memory.pendingWebsiteAge, null);
    assert.match(getScriptedNextQuestion(memory), /how many months or years/);
  });
}

test("a yes embedded in unclear speech cannot confirm a proposed duration", () => {
  const memory = websiteMemory();
  answer(memory, "Two yes", "website_age");
  answer(memory, "Ball. Yes.", "website_age_confirmation");
  assert.equal(memory.websiteAge, null);
});

test("duration interpretation does not turn a website-status yes into years", () => {
  const memory = websiteMemory();
  memory.websiteStatus = null;
  answer(memory, "Yes", "website_status");
  assert.equal(memory.websiteStatus, "yes");
  assert.equal(memory.websiteAge, null);
  assert.equal(memory.pendingWebsiteAge, null);
});

test("presence acknowledgements preserve the business correction from the log", () => {
  const memory = websiteMemory();
  memory.businessDetailsConfirmed = null;
  memory.businessName = "Old Business";
  memory.phoneNumber = "01632000111";
  updateSessionMemoryFromTranscript(memory, "Yes. I'm still here. The business name is wrong.", {
    promptKey: "business_details_confirmation",
    promptText: "I have your business name as Old Business, is that right?",
  });
  assert.equal(memory.businessDetailsConfirmed, "no");
  assert.equal(memory.businessName, null);
  assert.equal(memory.phoneNumber, null);
  assert.equal(getScriptedNextQuestion(memory), "Could you confirm the correct business name?");
});

test("presence acknowledgements preserve duration answers and callback refusals", () => {
  const memory = websiteMemory();
  answer(memory, "Yes, I'm still here. I've had it for two years.", "website_age");
  assert.equal(memory.websiteAge, "two years");
  updateSessionMemoryFromTranscript(memory, "Yes. I'm still here. I don't want a callback.", { promptKey: "callback_consent" });
  assert.equal(memory.callbackConsent, "no");
});

for (const text of ["Yes, I'm still here.", "I'm here."]) {
  test(`presence alone is not a survey answer or name: ${text}`, () => {
    const memory = createSessionMemory();
    updateSessionMemoryFromTranscript(memory, text, { promptKey: "owner_status" });
    assert.equal(memory.isBusinessOwner, null);
    assert.equal(memory.contactName, null);
    updateSessionMemoryFromTranscript(memory, text, { promptKey: "business_details_confirmation" });
    assert.equal(memory.businessDetailsConfirmed, null);
  });
}

test("callback refusals and explicit scheduling still work during duration clarification", () => {
  const memory = websiteMemory();
  answer(memory, "Call me back tomorrow at 3 pm", "website_age");
  assert.equal(memory.callbackDate, "tomorrow");
  assert.equal(memory.callbackTime, "3 pm");
  updateSessionMemoryFromTranscript(memory, "I don't want a callback", { promptKey: "website_age" });
  assert.equal(memory.callbackConsent, "no");
  assert.equal(memory.callbackDate, null);
});

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  createSessionMemory,
  updateSessionMemoryFromTranscript,
  formatSessionMemoryForLog,
  formatSessionMemoryForPrompt,
} = require("../services/session-memory");
const {
  getScriptedNextQuestion,
  inferQuestionKeyFromAssistantReply,
  getNextStepInstruction,
} = require("../services/survey-script");

const profile = {
  customer: {
    businessName: "Example Dog Walking",
    phoneNumber: "01632000111",
    address: "100 Old Road",
    town: "Middlesbrough",
    postcode: "TS6 0DS",
  },
};

function conversation(overrides = {}, callProfile = profile, usePromptKey = true) {
  const memory = Object.assign(createSessionMemory(), {
    isBusinessOwner: "yes",
    isDecisionMaker: "yes",
    phoneNumber: callProfile.customer?.phoneNumber || null,
  }, overrides);
  const history = [];
  return {
    memory,
    next: () => getScriptedNextQuestion(memory, callProfile),
    answer(text, expectedKey) {
      const promptText = getScriptedNextQuestion(memory, callProfile);
      const promptKey = inferQuestionKeyFromAssistantReply(promptText);
      assert.equal(promptKey, expectedKey, promptText);
      history.push({ role: "assistant", content: promptText });
      updateSessionMemoryFromTranscript(memory, text, {
        callProfile,
        conversationHistory: history,
        ...(usePromptKey ? { promptKey, promptText } : {}),
      });
      history.push({ role: "user", content: text });
      return memory;
    },
  };
}

for (const rejection of ["No.", "Oh, that's wrong.", "That's not correct.", "That isn't right.", "No, that is not correct."]) {
  test(`address rejection is recorded without becoming an address: ${rejection}`, () => {
    const call = conversation();
    call.answer(rejection, "address_confirmation");
    assert.equal(call.memory.addressConfirmed, "no");
    assert.equal(call.memory.businessAddress, null);
    assert.equal(call.memory.postcode, null);
    assert.equal(call.next(), "Could you confirm the correct address for the business?");
    call.answer("No.", "business_address");
    assert.equal(call.memory.businessAddress, null);
    call.answer("Oh,", "business_address");
    assert.equal(call.memory.businessAddress, null);
  });
}

for (const usePromptKey of [true, false]) {
  test(`address corrections require read-back and retain no (prompt key: ${usePromptKey})`, () => {
    const call = conversation({}, profile, usePromptKey);
    call.answer("No.", "address_confirmation");
    call.answer("It's 22 New Street, York.", "business_address");
    assert.equal(call.memory.businessAddress, "22 New Street, York");
    call.answer("YO1 7HD", "postcode");
    assert.equal(call.memory.addressCorrectionConfirmed, false);
    assert.match(call.next(), /22 New Street, York.*YO1 7HD/);
    assert.doesNotMatch(call.next(), /Old Road|TS6 0DS/);
    assert.match(getNextStepInstruction(call.memory, profile), /updated address/);
    call.answer("Yes, that's correct.", "address_correction_confirmation");
    assert.equal(call.memory.addressConfirmed, "no");
    assert.equal(call.memory.addressCorrectionConfirmed, true);
    assert.equal(inferQuestionKeyFromAssistantReply(call.next()), "business_details_confirmation");
    assert.equal(formatSessionMemoryForLog(call.memory).addressConfirmed, "no");
    assert.match(formatSessionMemoryForPrompt(call.memory), /Corrected address confirmed: Yes/);
  });
}

test("a correction supplied with no is captured and read back", () => {
  const call = conversation();
  call.answer("No, it's 22 New Street, York, and the postcode is YO1 7HD.", "address_confirmation");
  assert.equal(call.memory.businessAddress, "22 New Street, York");
  assert.equal(call.memory.postcode, "YO1 7HD");
  assert.equal(call.memory.addressConfirmed, "no");
  call.answer("Yes.", "address_correction_confirmation");
  assert.equal(call.memory.businessAddress, "22 New Street, York");
});

test("a postcode-only correction does not become the street address", () => {
  const call = conversation();
  call.answer("No, the postcode is YO1 7HD.", "address_confirmation");
  assert.equal(call.memory.businessAddress, null);
  assert.equal(call.memory.postcode, "YO1 7HD");
  call.answer("22 New Street, York", "business_address");
  call.answer("No, that's wrong.", "address_correction_confirmation");
  assert.equal(call.memory.addressCorrectionConfirmed, false);
  assert.equal(call.memory.businessAddress, null);
  assert.equal(call.memory.postcode, null);
  call.answer("24 New Street, York, YO1 7HD", "business_address");
  call.answer("Yes.", "address_correction_confirmation");
  assert.equal(call.memory.businessAddress, "24 New Street, York");
});

for (const rejection of ["No.", "Oh, that's wrong.", "That's not correct."]) {
  test(`business detail rejection collects and confirms a new name and number: ${rejection}`, () => {
    const call = conversation({ addressConfirmed: "yes" });
    call.answer(rejection, "business_details_confirmation");
    assert.equal(call.memory.businessDetailsConfirmed, "no");
    assert.equal(call.memory.businessName, null);
    assert.equal(call.memory.phoneNumber, null);
    assert.equal(call.memory.wrongNumber, false);
    call.answer("It's New Dog Walking.", "business_name");
    call.answer("01632 000222", "business_phone");
    assert.equal(call.memory.businessDetailsCorrectionConfirmed, false);
    assert.match(call.next(), /New Dog Walking.*01632000222/);
    call.answer("Yes.", "business_details_correction_confirmation");
    assert.equal(call.memory.businessDetailsConfirmed, "no");
    assert.equal(call.memory.businessDetailsCorrectionConfirmed, true);
    assert.equal(call.memory.businessName, "New Dog Walking");
    assert.equal(call.memory.phoneNumber, "01632000222");
    assert.equal(inferQuestionKeyFromAssistantReply(call.next()), "contact_name");
  });
}

test("an explicit business name and phone correction are kept separate", () => {
  const call = conversation({ addressConfirmed: "yes" });
  call.answer("No, the business name is New Dog Walking and the phone number is 01632 000222.", "business_details_confirmation");
  assert.equal(call.memory.businessName, "New Dog Walking");
  assert.equal(call.memory.phoneNumber, "01632000222");
  call.answer("No.", "business_details_correction_confirmation");
  assert.equal(call.memory.businessName, null);
  assert.equal(call.memory.phoneNumber, null);
  assert.equal(inferQuestionKeyFromAssistantReply(call.next()), "business_name");
});

test("phone-only correction cannot be mistaken for a business name", () => {
  const call = conversation({ addressConfirmed: "yes" });
  call.answer("No, the number is 01632 000222.", "business_details_confirmation");
  assert.equal(call.memory.businessName, null);
  assert.equal(call.memory.phoneNumber, "01632000222");
  call.answer("New Dog Walking", "business_name");
  call.answer("Yes.", "business_details_correction_confirmation");
  assert.equal(call.memory.phoneNumber, "01632000222");
});

test("yes answers still confirm the supplied details and advance", () => {
  const call = conversation();
  call.answer("Yes, that's right.", "address_confirmation");
  assert.equal(call.memory.addressConfirmed, "yes");
  assert.equal(call.memory.businessAddress, profile.customer.address);
  call.answer("Yes.", "business_details_confirmation");
  assert.equal(call.memory.businessDetailsConfirmed, "yes");
  assert.equal(call.memory.businessName, profile.customer.businessName);
  assert.equal(call.memory.phoneNumber, profile.customer.phoneNumber);
  assert.equal(inferQuestionKeyFromAssistantReply(call.next()), "contact_name");
});

test("unknown details can be collected and confirmed without a saved profile", () => {
  const call = conversation({}, { customer: {} });
  call.answer("22 New Street, York", "business_address");
  call.answer("YO1 7HD", "postcode");
  call.answer("Yes", "address_correction_confirmation");
  call.answer("New Dog Walking", "business_name");
  call.answer("01632000222", "business_phone");
  call.answer("Yes", "business_details_correction_confirmation");
  assert.equal(call.memory.addressConfirmed, "yes");
  assert.equal(call.memory.businessDetailsConfirmed, "yes");
});

test("wrong-number and do-not-call requests still stop the detail flow", () => {
  for (const text of ["You have the wrong number.", "Do not call me again."]) {
    const call = conversation();
    call.answer(text, "address_confirmation");
    assert.equal(call.next(), null);
    assert.equal(call.memory.businessAddress, null);
  }
});

test("ordinary negative survey answers remain no and follow their survey branches", () => {
  const call = conversation({ addressConfirmed: "yes", businessDetailsConfirmed: "yes", contactName: "Alex" });
  call.answer("No", "website_status");
  assert.equal(call.memory.websiteStatus, "no");
  call.answer("No", "website_interest");
  assert.equal(call.memory.websiteInterestLevel, "no");
  call.answer("No", "online_enquiries");
  assert.equal(call.memory.onlineEnquiryStatus, "no");
  call.answer("No", "more_enquiries");
  assert.equal(call.memory.interestInMoreEnquiries, "no");
  assert.equal(inferQuestionKeyFromAssistantReply(call.next()), "industry");
});

test("confirming while repeating corrected values still advances", () => {
  const call = conversation();
  call.answer("No, it's 22 New Street, YO1 7HD", "address_confirmation");
  call.answer("Yes, 22 New Street, YO1 7HD", "address_correction_confirmation");
  assert.equal(call.memory.addressCorrectionConfirmed, true);
  call.answer("No, it is New Dog Walking", "business_details_confirmation");
  assert.equal(call.memory.businessName, "New Dog Walking");
  call.answer("01632000222", "business_phone");
  call.answer("Yes, the number is 01632 000222", "business_details_correction_confirmation");
  assert.equal(call.memory.businessDetailsCorrectionConfirmed, true);
});

test("a spoken postcode cannot become the address while collecting corrections", () => {
  const call = conversation();
  call.answer("No", "address_confirmation");
  call.answer("T S seven zero A B", "business_address");
  assert.equal(call.memory.businessAddress, null);
  assert.equal(call.memory.postcode, "TS7 0AB");
  call.answer("Rose Cottage", "business_address");
  call.answer("Yes", "address_correction_confirmation");
  assert.equal(call.memory.addressCorrectionConfirmed, true);
});

test("business names can include phone or number as ordinary words", () => {
  for (const name of ["Number One Plumbing", "Mobile Dog Walking"]) {
    const call = conversation({ addressConfirmed: "yes" });
    call.answer("No", "business_details_confirmation");
    call.answer(name, "business_name");
    assert.equal(call.memory.businessName, name);
    assert.equal(inferQuestionKeyFromAssistantReply(call.next()), "business_phone");
  }
});

test("a callback request during detail correction still captures the day and time", () => {
  const call = conversation();
  call.answer("No", "address_confirmation");
  call.answer("Call me back tomorrow at 10 am", "business_address");
  assert.equal(call.memory.busy, true);
  assert.equal(call.memory.callbackDate, "tomorrow");
  assert.equal(call.memory.callbackTime, "10 am");
  assert.equal(call.memory.businessAddress, null);
});

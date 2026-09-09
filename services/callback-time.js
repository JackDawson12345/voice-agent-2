// Callbacks use the business's local clock, from 9am through 5pm inclusive.
function callbackTimeMinutes(value) {
  const hours = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
  const text = String(value || "").toLowerCase()
    .replace(/\b([ap])\.?\s*m\.?/g, "$1m")
    .replace(/\bnoon\b/, "12 pm")
    .replace(/\bmidnight\b/, "12 am")
    .replace(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, (word) => hours.indexOf(word))
    .replace(/^at\s+/, "")
    .trim();
  const match = text.match(/^(?:(half)(?:\s+past)?\s+|quarter\s+(past|to)\s+)?(\d{1,2})(?::(\d{2}))?(?:\s*o['’]?clock)?\s*(am|pm)?$/);
  if (!match) return null;
  let hour = Number(match[3]);
  const minute = Number(match[4] || 0);
  const meridiem = match[5];
  if (minute > 59 || hour > 23 || (meridiem && (hour < 1 || hour > 12))) return null;
  if ((match[1] || match[2]) && match[4]) return null;
  if (meridiem) {
    hour = hour % 12 + (meridiem === "pm" ? 12 : 0);
  } else if (hour >= 1 && hour <= 5) {
    // In the offered 9am-5pm window, "three" means 3pm.
    hour += 12;
  }
  const offset = match[1] ? 30 : match[2] === "past" ? 15 : match[2] === "to" ? -15 : minute;
  return hour * 60 + offset;
}

function isCallbackTimeWithinHours(value) {
  const minutes = callbackTimeMinutes(value);
  return minutes !== null && minutes >= 9 * 60 && minutes <= 17 * 60;
}

function formatCallbackClock(value) {
  const minutes = callbackTimeMinutes(value);
  if (minutes === null) return null;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${hour % 12 || 12}${minute ? `:${String(minute).padStart(2, "0")}` : ""} ${hour >= 12 ? "pm" : "am"}`;
}

module.exports = { callbackTimeMinutes, isCallbackTimeWithinHours, formatCallbackClock };

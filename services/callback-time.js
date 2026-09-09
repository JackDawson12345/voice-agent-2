const hours = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

function normaliseCallbackTimeText(value) {
  const hourPattern = `(?:${hours.slice(1).join("|")}|\\d{1,2})`;
  const units = "(?:one|two|three|four|five|six|seven|eight|nine)";
  const minutes = `(?:(?:twenty|thirty|forty|fifty)(?:[ -]${units})?|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|(?:oh|zero)[ -]${units}|\\d{2})`;
  return String(value || "").toLowerCase()
    // Also accept attached/dotted forms such as "3p.m." and "3p m".
    .replace(/(?<![a-z])([ap])\.?\s*m\.?(?![a-z])/g, "$1m")
    .replace(/(\d)(am|pm)\b/g, "$1 $2")
    .replace(/\b(\d{1,2})\.(\d{2})\b/g, "$1:$2")
    .replace(new RegExp(`\\b(${hourPattern})\\s+(${minutes})\\b`, "g"), (_, hour, minute) => {
      const parts = minute.split(/[ -]/);
      const values = { oh: 0, zero: 0, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
        fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
        nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50 };
      const count = parts.reduce((total, part) => total + (values[part] ??
        (hours.includes(part) ? hours.indexOf(part) : Number(part))), 0);
      return `${hours.includes(hour) ? hours.indexOf(hour) : hour}:${String(count).padStart(2, "0")}`;
    })
    .replace(/\s+/g, " ")
    .replace(/^[\s,.;!?]+|[\s,.;!?]+$/g, "");
}

function isAnytimeCallbackTime(value) {
  return /^any\s*time$/.test(normaliseCallbackTimeText(value));
}

// Callbacks use the business's local clock, from 9am through 5pm inclusive.
function callbackTimeMinutes(value) {
  const text = normaliseCallbackTimeText(value)
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
  // "Anytime" retains the caller's flexibility across the offered window.
  if (isAnytimeCallbackTime(value)) return true;
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

module.exports = { callbackTimeMinutes, isCallbackTimeWithinHours, formatCallbackClock,
  isAnytimeCallbackTime, normaliseCallbackTimeText };

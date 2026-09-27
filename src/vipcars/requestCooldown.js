const MAX_DATE_MS = 8_640_000_000_000_000;
const MONTHS = new Map([
  ["Jan", 0], ["Feb", 1], ["Mar", 2], ["Apr", 3], ["May", 4], ["Jun", 5],
  ["Jul", 6], ["Aug", 7], ["Sep", 8], ["Oct", 9], ["Nov", 10], ["Dec", 11]
]);
const SHORT_WEEKDAYS = new Map([
  ["Sun", 0], ["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6]
]);
const LONG_WEEKDAYS = new Map([
  ["Sunday", 0], ["Monday", 1], ["Tuesday", 2], ["Wednesday", 3],
  ["Thursday", 4], ["Friday", 5], ["Saturday", 6]
]);

function validNow(now) {
  return Number.isSafeInteger(now) && Math.abs(now) <= MAX_DATE_MS;
}

function buildHttpDate({ weekday, day, month, year, hour, minute, second }) {
  if (year < 1601 || year > 9999 || month === undefined ||
      day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day ||
      date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second ||
      date.getUTCDay() !== weekday) return null;
  return date.getTime();
}

function parseHttpDate(value, now) {
  let match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  if (match) {
    return buildHttpDate({ weekday: SHORT_WEEKDAYS.get(match[1]), day: Number(match[2]),
      month: MONTHS.get(match[3]), year: Number(match[4]), hour: Number(match[5]),
      minute: Number(match[6]), second: Number(match[7]) });
  }

  match = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  if (match) {
    const currentYear = new Date(now).getUTCFullYear();
    let year = Math.floor(currentYear / 100) * 100 + Number(match[4]);
    if (year > currentYear + 50) year -= 100;
    return buildHttpDate({ weekday: LONG_WEEKDAYS.get(match[1]), day: Number(match[2]),
      month: MONTHS.get(match[3]), year, hour: Number(match[5]), minute: Number(match[6]),
      second: Number(match[7]) });
  }

  match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value);
  if (!match) return null;
  return buildHttpDate({ weekday: SHORT_WEEKDAYS.get(match[1]), day: Number(match[3]),
    month: MONTHS.get(match[2]), year: Number(match[7]), hour: Number(match[4]),
    minute: Number(match[5]), second: Number(match[6]) });
}

function parseRetryAfter(value, now = Date.now()) {
  if (!validNow(now) || (typeof value !== "string" && typeof value !== "number")) return null;
  const text = String(value).trim();
  if (!text) return null;

  if (/^\d+$/.test(text)) {
    const retryAt = BigInt(now) + BigInt(text) * 1000n;
    return retryAt <= BigInt(MAX_DATE_MS) ? Number(retryAt) : null;
  }

  const parsed = parseHttpDate(text, now);
  return parsed === null ? null : Math.max(now, parsed);
}

function retryAfterHeader(headers) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    return headers.get("retry-after") ?? headers.get("Retry-After");
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "retry-after") return value;
  }
  return null;
}

function createCooldownError(status, headers, now = Date.now()) {
  if (!Number.isInteger(status) || status < 400 || !validNow(now)) return null;
  const retryAt = parseRetryAfter(retryAfterHeader(headers), now);
  if (retryAt === null || retryAt <= now) return null;
  const error = new Error(`HTTP ${status} cooldown until ${new Date(retryAt).toISOString()}.`);
  error.name = "ServerCooldownError";
  error.code = "SERVER_COOLDOWN";
  error.retryable = true;
  error.status = status;
  error.retryAt = retryAt;
  return error;
}

module.exports = { createCooldownError, parseRetryAfter };

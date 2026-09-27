const assert = require("node:assert/strict");

const { createCooldownError, parseRetryAfter } = require("../src/vipcars/requestCooldown");

function main() {
  const now = Date.UTC(2026, 8, 27, 10, 0, 0);

  assert.equal(parseRetryAfter("1769", now), now + 1_769_000);
  assert.equal(parseRetryAfter(" 0 ", now), now);
  assert.equal(parseRetryAfter(12, now), now + 12_000);
  assert.equal(parseRetryAfter("42", now), now + 42_000);

  const futureDate = "Sun, 27 Sep 2026 10:30:00 GMT";
  assert.equal(parseRetryAfter(futureDate, now), Date.UTC(2026, 8, 27, 10, 30, 0));
  assert.equal(parseRetryAfter("Sunday, 27-Sep-26 10:30:00 GMT", now), Date.UTC(2026, 8, 27, 10, 30, 0));
  assert.equal(parseRetryAfter("Sun Sep 27 10:30:00 2026", now), Date.UTC(2026, 8, 27, 10, 30, 0));
  assert.equal(parseRetryAfter("Sun, 27 Sep 2026 09:30:00 GMT", now), now);

  for (const invalid of [
    null,
    undefined,
    "",
    "   ",
    "-1",
    "+1",
    "1.5",
    "garbage",
    "42 GMT",
    "Sun, 31 Feb 2027 10:30:00 GMT",
    "Mon, 27 Sep 2026 10:30:00 GMT",
    "Sun, 27 Sep 2026 25:00:00 GMT",
    "999999999999999999999999999999999999"
  ]) {
    assert.equal(parseRetryAfter(invalid, now), null, `expected invalid Retry-After: ${String(invalid)}`);
  }
  assert.equal(parseRetryAfter("1", Number.NaN), null);

  const retryAt = now + 1_769_000;
  const observed = createCooldownError(400, {
    "Retry-After": "1769",
    Server: "cloudflare",
    "CF-Ray": "private-ray-value",
    Cookie: "private-cookie"
  }, now);
  assert.ok(observed instanceof Error);
  assert.equal(observed.name, "ServerCooldownError");
  assert.equal(observed.code, "SERVER_COOLDOWN");
  assert.equal(observed.retryable, true);
  assert.equal(observed.status, 400);
  assert.equal(observed.retryAt, retryAt);
  assert.equal(observed.message, `HTTP 400 cooldown until ${new Date(retryAt).toISOString()}.`);
  assert.doesNotMatch(observed.message, /1769|cloudflare|cf-ray|private|cookie|retry-after/i);

  const mixedCase = createCooldownError(429, { "rEtRy-AfTeR": futureDate }, now);
  assert.equal(mixedCase.retryAt, Date.UTC(2026, 8, 27, 10, 30, 0));
  assert.equal(mixedCase.message, "HTTP 429 cooldown until 2026-09-27T10:30:00.000Z.");

  const headerBag = {
    get(name) {
      return name.toLowerCase() === "retry-after" ? "60" : null;
    }
  };
  assert.equal(createCooldownError(503, headerBag, now).retryAt, now + 60_000);

  assert.equal(createCooldownError(399, { "retry-after": "60" }, now), null);
  assert.equal(createCooldownError(400, {}, now), null);
  assert.equal(createCooldownError(400, { "retry-after": "garbage" }, now), null);
  assert.equal(createCooldownError(400, { "retry-after": "0" }, now), null);
  assert.equal(createCooldownError(400, { "retry-after": "Sun, 27 Sep 2026 09:30:00 GMT" }, now), null);

  console.log("All VipCars request cooldown tests passed.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}

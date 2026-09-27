const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const { validatePageSearch } = require("../src/vipcars/searchContract");

const EXPECTED_URL = [
  "https://www.vipcars.com/search/?pickup_country=119",
  "pickup_city=1744",
  "pickup_location=10921",
  "dropoff_country=119",
  "dropoff_city=1744",
  "dropoff_location=10921",
  "pickup_date=2026-10-02",
  "pickup_time=10%3A00",
  "dropoff_date=2026-10-04",
  "dropoff_time=10%3A00",
  "currency=EUR"
].join("&");

const EXPECTED_FIELDS = {
  pickup_country: "119",
  pickup_city: "1744",
  pickup_location: "10921",
  dropoff_country: "119",
  dropoff_city: "1744",
  dropoff_location: "10921",
  pickup_date: "2026-10-02",
  dropoff_date: "2026-10-04",
  pickup_time: "10:00",
  dropoff_time: "10:00",
  currency: "EUR"
};

function searchForm(overrides = {}, currencyInputs = ["EUR"]) {
  const values = { ...EXPECTED_FIELDS, ...overrides };
  const currencyHtml = currencyInputs
    .map((value) => `<input name="currency" value="${value}">`)
    .join("");

  return `<!doctype html><html><body>
    <input id="pickup_country" value="${values.pickup_country}">
    <input id="pickup_city" value="${values.pickup_city}">
    <input id="pickup_location" value="${values.pickup_location}">
    <input id="dropoff_country" value="${values.dropoff_country}">
    <input id="dropoff_city" value="${values.dropoff_city}">
    <input id="dropoff_location" value="${values.dropoff_location}">
    <input id="pickdate" value="${values.pickup_date}">
    <input id="dropdate" value="${values.dropoff_date}">
    <input id="time_pickup" value="${values.pickup_time}">
    <input id="time_dropoff" value="${values.dropoff_time}">
    ${currencyHtml}
  </body></html>`;
}

async function withPage(browser, html, callback) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await callback(page);
  } finally {
    await page.close();
  }
}

async function expectMismatch(action, field, reason = "mismatch") {
  await assert.rejects(action, (error) => {
    assert.equal(error.name, "SearchContractError");
    assert.equal(error.code, "SEARCH_CONTRACT_MISMATCH");
    assert.equal(error.retryable, false);
    assert.ok(Array.isArray(error.mismatches));
    assert.ok(
      error.mismatches.some((item) => item.field === field && item.reason === reason),
      `expected ${field} ${reason} mismatch`
    );
    return true;
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const tests = [];
  const test = (name, callback) => tests.push({ name, callback });

  for (const sourceError of [
    new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation"),
    Object.assign(new Error("page.evaluate: browser process exited"), { name: "TargetClosedError" }),
    new Error("page.evaluate: Page closed")
  ]) {
    test(`makes ${sourceError.name}: ${sourceError.message} retryable`, async () => {
      const page = { evaluate: async () => { throw sourceError; } };
      await assert.rejects(() => validatePageSearch(page, EXPECTED_URL), (error) => {
        assert.equal(error.code, "SEARCH_CONTRACT_UNAVAILABLE");
        assert.equal(error.retryable, true);
        assert.equal(error.cause, sourceError);
        return true;
      });
    });
  }

  test("rethrows an unknown page evaluation failure unchanged", async () => {
    const sourceError = new Error("Unexpected selector engine failure");
    const page = { evaluate: async () => { throw sourceError; } };
    await assert.rejects(() => validatePageSearch(page, EXPECTED_URL), (error) => error === sourceError);
  });

  test("returns all eleven DOM-derived search fields", () => withPage(
    browser,
    searchForm({}, ["", "EUR"]),
    async (page) => {
      const actual = await validatePageSearch(page, EXPECTED_URL);
      assert.deepEqual(actual, EXPECTED_FIELDS);
      assert.equal(Object.keys(actual).length, 11);
    }
  ));

  test("rejects the wrong pickup date", () => withPage(
    browser,
    searchForm({ pickup_date: "2026-10-03" }),
    (page) => expectMismatch(() => validatePageSearch(page, EXPECTED_URL), "pickup_date")
  ));

  test("rejects the wrong pickup time", () => withPage(
    browser,
    searchForm({ pickup_time: "11:00" }),
    (page) => expectMismatch(() => validatePageSearch(page, EXPECTED_URL), "pickup_time")
  ));

  test("rejects the wrong airport location", () => withPage(
    browser,
    searchForm({ pickup_location: "99999" }),
    (page) => expectMismatch(() => validatePageSearch(page, EXPECTED_URL), "pickup_location")
  ));

  test("rejects a missing required search field", () => withPage(
    browser,
    searchForm().replace('<input id="dropoff_city" value="1744">', ""),
    (page) => expectMismatch(() => validatePageSearch(page, EXPECTED_URL), "dropoff_city", "missing")
  ));

  test("rejects a missing currency input", () => withPage(
    browser,
    searchForm({}, []),
    (page) => expectMismatch(() => validatePageSearch(page, EXPECTED_URL), "currency", "missing")
  ));

  test("rejects a non-EUR page currency", () => withPage(
    browser,
    searchForm({}, ["PLN"]),
    (page) => expectMismatch(() => validatePageSearch(page, EXPECTED_URL), "currency")
  ));

  test("rejects conflicting non-empty currency inputs", () => withPage(
    browser,
    searchForm({}, ["EUR", "", "PLN"]),
    (page) => expectMismatch(() => validatePageSearch(page, EXPECTED_URL), "currency", "conflict")
  ));

  try {
    for (const { name, callback } of tests) {
      try {
        await callback();
        console.log(`PASS ${name}`);
      } catch (error) {
        console.error(`FAIL ${name}`);
        console.error(error instanceof Error ? error.stack : String(error));
        process.exitCode = 1;
      }
    }
  } finally {
    await browser.close();
  }

  if (!process.exitCode) {
    console.log("All VipCars search contract tests passed.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});

const assert = require("node:assert/strict");

const { loadConfig } = require("../src/vipcars/config");
const { parseMoney, toCsv } = require("../src/vipcars/utils");
const { buildHtmlReport, parseCsv } = require("../src/vipcars/reportHtml");
const { slugifyLocation } = require("../src/vipcars/scraper");

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}

runTest("loadConfig accepts CLI locations and dates", () => {
  const config = loadConfig([
    "--location", "Warsaw",
    "--pickup-date", "2026-05-15",
    "--pickup-time", "10:00",
    "--dropoff-date", "2026-05-17",
    "--dropoff-time", "10:00"
  ]);
  assert.deepEqual(config.locations, ["Warsaw"]);
  assert.equal(config.baseUrl, "https://www.vipcars.com");
  assert.equal(config.currency, "EUR");
});

runTest("parseMoney handles VipCars price labels", () => {
  assert.deepEqual(parseMoney("EUR 26.13"), { value: 26.13, currency: "EUR", raw: "EUR 26.13" });
});

runTest("slugifyLocation builds VipCars landing slugs", () => {
  assert.equal(slugifyLocation("Kraków Balice"), "krakow-balice");
});

runTest("CSV and HTML report render top offers", () => {
  const csv = toCsv([
    {
      location: "Warsaw",
      duration_days: 2,
      pickup_date: "2026-05-15",
      dropoff_date: "2026-05-17",
      provider: "Thrifty",
      provider_rating: "",
      total_price: 52.26,
      price_per_day: 26.13,
      currency: "EUR",
      source: "landing"
    }
  ]);
  const rows = parseCsv(csv);
  const html = buildHtmlReport(rows, "2026-05-15T00:00:00.000Z");
  assert.match(html, /VipCars report/);
  assert.match(html, /Thrifty/);
  assert.match(html, /52\.26 EUR/);
});

runTest("HTML report applies all MM highlight colors", () => {
  const html = buildHtmlReport([
    {
      location: "Warsaw",
      duration_days: "2",
      pickup_date: "2026-05-15",
      dropoff_date: "2026-05-17",
      provider: "MM Cars Rental",
      provider_rating: "",
      total_price: "100",
      currency: "EUR"
    },
    {
      location: "Warsaw",
      duration_days: "2",
      pickup_date: "2026-05-15",
      dropoff_date: "2026-05-17",
      provider: "Alamo",
      provider_rating: "",
      total_price: "120",
      currency: "EUR"
    },
    {
      location: "Krakow",
      duration_days: "2",
      pickup_date: "2026-05-15",
      dropoff_date: "2026-05-17",
      provider: "Alamo",
      provider_rating: "",
      total_price: "100",
      currency: "EUR"
    },
    {
      location: "Krakow",
      duration_days: "2",
      pickup_date: "2026-05-15",
      dropoff_date: "2026-05-17",
      provider: "MM Cars Rental",
      provider_rating: "",
      total_price: "101.5",
      currency: "EUR"
    }
  ], "2026-05-15T00:00:00.000Z");

  assert.match(html, /mm mm-top1-gap/);
  assert.match(html, /mm mm-close/);
  assert.match(html, /badge close/);
  assert.match(html, /badge good/);
  assert.match(html, /2\.5 EUR\/day/);
});

if (!process.exitCode) {
  console.log("All VipCars tests passed.");
}

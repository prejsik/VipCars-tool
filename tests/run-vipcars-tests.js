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
});

runTest("parseMoney handles VipCars price labels", () => {
  assert.deepEqual(parseMoney("PLN 26.13"), { value: 26.13, currency: "PLN", raw: "PLN 26.13" });
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
      currency: "PLN",
      source: "landing"
    }
  ]);
  const rows = parseCsv(csv);
  const html = buildHtmlReport(rows, "2026-05-15T00:00:00.000Z");
  assert.match(html, /VipCars report/);
  assert.match(html, /Thrifty/);
  assert.match(html, /52\.26 PLN/);
});

if (!process.exitCode) {
  console.log("All VipCars tests passed.");
}

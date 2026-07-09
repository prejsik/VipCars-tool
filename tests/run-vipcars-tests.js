const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadConfig } = require("../src/vipcars/config");
const { mergeCsvFiles } = require("../src/vipcars/mergeCsv");
const { parseMoney, toCsv } = require("../src/vipcars/utils");
const { buildHtmlReport, parseCsv } = require("../src/vipcars/reportHtml");
const {
  VipCarsScraper,
  isAutomaticTransmissionCandidate,
  resolveVipCarsLocation,
  slugifyLocation
} = require("../src/vipcars/scraper");

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

async function runAsyncTest(name, fn) {
  try {
    await fn();
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
  assert.equal(config.pickupRollingDays, 0);
});

runTest("loadConfig builds rolling pickup dates", () => {
  const config = loadConfig([
    "--location", "Warsaw",
    "--pickup-date", "2026-05-15",
    "--pickup-time", "10:00",
    "--dropoff-date", "2026-05-17",
    "--dropoff-time", "10:00",
    "--pickup-rolling-days", "3",
    "--durations-days", "2,3,4"
  ]);
  const dayNumber = (isoDate) => Date.parse(`${isoDate}T00:00:00Z`) / 86400000;
  assert.equal(config.pickupRollingDays, 3);
  assert.equal(config.pickupDateOptions.length, 3);
  assert.equal(dayNumber(config.pickupDateOptions[1]) - dayNumber(config.pickupDateOptions[0]), 1);
  assert.equal(dayNumber(config.pickupDateOptions[2]) - dayNumber(config.pickupDateOptions[1]), 1);
  assert.deepEqual(config.durationDays, [2, 3, 4]);
});

runTest("loadConfig skips today when pickup time has passed", () => {
  const today = new Date();
  const todayIso = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0")
  ].join("-");
  const rollingConfig = loadConfig([
    "--location", "Warsaw",
    "--pickup-date", "2026-05-15",
    "--pickup-time", "00:00",
    "--dropoff-date", "2026-05-17",
    "--dropoff-time", "10:00",
    "--pickup-rolling-days", "2"
  ]);
  const weekdayConfig = loadConfig([
    "--location", "Warsaw",
    "--pickup-date", "2026-05-15",
    "--pickup-time", "00:00",
    "--dropoff-date", "2026-05-17",
    "--dropoff-time", "10:00",
    "--pickup-weekday", String(today.getDay())
  ]);

  assert.notEqual(rollingConfig.pickupDateOptions[0], todayIso);
  assert.notEqual(weekdayConfig.pickupDateOptions[0], todayIso);
});

runTest("loadConfig chunks rolling pickup dates", () => {
  const firstChunk = loadConfig([
    "--location", "Warsaw",
    "--pickup-date", "2026-05-15",
    "--pickup-time", "10:00",
    "--dropoff-date", "2026-05-17",
    "--dropoff-time", "10:00",
    "--pickup-rolling-days", "9",
    "--pickup-chunk-index", "1",
    "--pickup-chunk-total", "3"
  ]);
  const secondChunk = loadConfig([
    "--location", "Warsaw",
    "--pickup-date", "2026-05-15",
    "--pickup-time", "10:00",
    "--dropoff-date", "2026-05-17",
    "--dropoff-time", "10:00",
    "--pickup-rolling-days", "9",
    "--pickup-chunk-index", "2",
    "--pickup-chunk-total", "3"
  ]);
  const thirdChunk = loadConfig([
    "--location", "Warsaw",
    "--pickup-date", "2026-05-15",
    "--pickup-time", "10:00",
    "--dropoff-date", "2026-05-17",
    "--dropoff-time", "10:00",
    "--pickup-rolling-days", "9",
    "--pickup-chunk-index", "3",
    "--pickup-chunk-total", "3"
  ]);

  assert.equal(firstChunk.pickupDateOptions.length, 3);
  assert.equal(secondChunk.pickupDateOptions.length, 3);
  assert.equal(thirdChunk.pickupDateOptions.length, 3);
  assert.equal(new Set([
    ...firstChunk.pickupDateOptions,
    ...secondChunk.pickupDateOptions,
    ...thirdChunk.pickupDateOptions
  ]).size, 9);
});

runTest("CLI pickup weekdays and durations override config defaults", () => {
  const config = loadConfig([
    "--config", "vipcars.config.example.json",
    "--pickup-weekday", "friday",
    "--duration-days", "2"
  ]);
  assert.equal(config.pickupRollingDays, 0);
  assert.equal(config.pickupDateOptions.length, 1);
  assert.deepEqual(config.durationDays, [2]);
});

runTest("CLI locations override config defaults", () => {
  const config = loadConfig([
    "--config", "vipcars.config.example.json",
    "--locations", "Katowice",
    "--pickup-weekday", "friday",
    "--duration-days", "2"
  ]);

  assert.deepEqual(config.locations, ["Katowice"]);
});

runTest("CLI output paths override config defaults", () => {
  const config = loadConfig([
    "--config", "vipcars.config.example.json",
    "--output-csv", "output/vipcars-results-chunk-1.csv",
    "--artifacts-dir", "artifacts/vipcars/chunk-1"
  ]);

  assert.equal(path.basename(config.outputCsv), "vipcars-results-chunk-1.csv");
  assert.match(config.artifactsDir.replace(/\\/g, "/"), /artifacts\/vipcars\/chunk-1$/);
});

runTest("parseMoney handles VipCars price labels", () => {
  assert.deepEqual(parseMoney("EUR 26.13"), { value: 26.13, currency: "EUR", raw: "EUR 26.13" });
});

runTest("slugifyLocation builds VipCars landing slugs", () => {
  assert.equal(slugifyLocation("Kraków Balice"), "krakow-balice");
});

runTest("resolveVipCarsLocation maps Katowice to KTW", () => {
  assert.deepEqual(resolveVipCarsLocation("Katowice"), {
    name: "Katowice Pyrzowice Airport [KTW]",
    code: "KTW",
    countryId: "119",
    cityId: "1735",
    locationId: "667"
  });
});

runTest("buildSearchUrl uses exact VipCars search parameters", () => {
  const config = loadConfig([
    "--location", "Katowice",
    "--pickup-date", "2026-05-23",
    "--pickup-time", "10:00",
    "--dropoff-date", "2026-05-25",
    "--dropoff-time", "10:00",
    "--currency", "EUR"
  ]);
  const url = new URL(new VipCarsScraper(config).buildSearchUrl("Katowice"));
  assert.equal(url.pathname, "/search/");
  assert.equal(url.searchParams.get("pickup_location"), "667");
  assert.equal(url.searchParams.get("dropoff_location"), "667");
  assert.equal(url.searchParams.get("pickup_date"), "2026-05-23");
  assert.equal(url.searchParams.get("pickup_time"), "10:00");
  assert.equal(url.searchParams.get("dropoff_date"), "2026-05-25");
  assert.equal(url.searchParams.get("dropoff_time"), "10:00");
  assert.equal(url.searchParams.get("currency"), "EUR");
});

runTest("VipCars offers require automatic transmission", () => {
  assert.equal(isAutomaticTransmissionCandidate({
    automatic: true,
    transmission: "Automatic Transmission",
    carName: "Skoda Fabia Automatic or Similar"
  }), true);
  assert.equal(isAutomaticTransmissionCandidate({
    automatic: false,
    transmission: "Manual Transmission",
    carName: "Citroen C3 or Similar"
  }), false);
  assert.equal(isAutomaticTransmissionCandidate({
    transmission: "",
    carName: "Dacia Jogger Automatic or Similar"
  }), true);
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
      source: "search"
    }
  ]);
  const rows = parseCsv(csv);
  const html = buildHtmlReport(rows, "2026-05-15T00:00:00.000Z");
  assert.match(html, /VipCars report/);
  assert.match(html, /Thrifty/);
  assert.match(html, /26\.13 EUR\/day/);
  assert.doesNotMatch(html, /52\.26 EUR/);

  const fallbackHtml = buildHtmlReport([{
    location: "Krakow",
    duration_days: "3",
    pickup_date: "2026-05-15",
    dropoff_date: "2026-05-18",
    provider: "Alamo",
    provider_rating: "",
    total_price: "90",
    price_per_day: "",
    currency: "EUR"
  }], "2026-05-15T00:00:00.000Z");
  assert.match(fallbackHtml, /30\.00 EUR\/day/);
});

runTest("mergeCsvFiles combines chunk result files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vipcars-merge-"));
  const chunkOne = path.join(tempDir, "one");
  const chunkTwo = path.join(tempDir, "two");
  fs.mkdirSync(chunkOne);
  fs.mkdirSync(chunkTwo);

  fs.writeFileSync(path.join(chunkOne, "vipcars-results-chunk-1.csv"), toCsv([
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
      source: "search"
    }
  ]), "utf8");
  fs.writeFileSync(path.join(chunkTwo, "vipcars-results-chunk-2.csv"), toCsv([
    {
      location: "Krakow",
      duration_days: 3,
      pickup_date: "2026-05-16",
      dropoff_date: "2026-05-19",
      provider: "Alamo",
      provider_rating: "",
      total_price: 90,
      price_per_day: 30,
      currency: "EUR",
      source: "landing"
    }
  ]), "utf8");

  const outputPath = path.join(tempDir, "merged.csv");
  const summary = mergeCsvFiles(tempDir, outputPath);
  const mergedRows = parseCsv(fs.readFileSync(outputPath, "utf8"));
  assert.equal(summary.files.length, 2);
  assert.equal(summary.rowCount, 2);
  assert.equal(mergedRows.length, 2);
  assert.deepEqual(mergedRows.map((row) => row.location), ["Warsaw", "Krakow"]);
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
    },
    {
      location: "Gdansk",
      duration_days: "2",
      pickup_date: "2026-05-15",
      dropoff_date: "2026-05-17",
      provider: "Alamo",
      provider_rating: "",
      price_per_day: "20",
      currency: "EUR"
    },
    {
      location: "Gdansk",
      duration_days: "2",
      pickup_date: "2026-05-15",
      dropoff_date: "2026-05-17",
      provider: "Hertz",
      provider_rating: "",
      price_per_day: "22",
      currency: "EUR"
    },
    {
      location: "Gdansk",
      duration_days: "2",
      pickup_date: "2026-05-15",
      dropoff_date: "2026-05-17",
      provider: "MM Cars Rental",
      provider_rating: "",
      price_per_day: "24",
      currency: "EUR"
    },
    {
      location: "Wroclaw",
      duration_days: "2",
      pickup_date: "2026-05-15",
      dropoff_date: "2026-05-17",
      provider: "Alamo",
      provider_rating: "",
      price_per_day: "20",
      currency: "EUR"
    },
    {
      location: "Wroclaw",
      duration_days: "2",
      pickup_date: "2026-05-15",
      dropoff_date: "2026-05-17",
      provider: "Hertz",
      provider_rating: "",
      price_per_day: "23",
      currency: "EUR"
    },
    {
      location: "Wroclaw",
      duration_days: "2",
      pickup_date: "2026-05-15",
      dropoff_date: "2026-05-17",
      provider: "Avis",
      provider_rating: "",
      price_per_day: "26",
      currency: "EUR"
    },
    {
      location: "Wroclaw",
      duration_days: "2",
      pickup_date: "2026-05-15",
      dropoff_date: "2026-05-17",
      provider: "MM Cars Rental",
      provider_rating: "",
      price_per_day: "28",
      currency: "EUR"
    }
  ], "2026-05-15T00:00:00.000Z");

  assert.match(html, /mm mm-top1-gap/);
  assert.match(html, /mm mm-close/);
  assert.match(html, /badge close/);
  assert.match(html, /badge good/);
  assert.match(html, /top4_rate_per_day/);
  assert.match(html, /\.mm-close \{ background: var\(--red-bg\)/);
  assert.match(html, /\.mm-top1-gap \{ background: var\(--blue-bg\)/);
  assert.match(html, /2\.5 EUR\/day/);
});

runAsyncTest("VipCars retries timeouts at most twice", async () => {
  const timeoutScraper = new VipCarsScraper({});
  let timeoutAttempts = 0;
  timeoutScraper.runSingleLocation = async () => {
    timeoutAttempts += 1;
    return { ok: false, error: new Error("page.waitForSelector: Timeout 45000ms exceeded.") };
  };

  const timeoutOutcome = await timeoutScraper.runLocationWithRetries({}, "Warsaw");
  assert.equal(timeoutOutcome.ok, false);
  assert.equal(timeoutAttempts, 3);

  const nonTimeoutScraper = new VipCarsScraper({});
  let nonTimeoutAttempts = 0;
  nonTimeoutScraper.runSingleLocation = async () => {
    nonTimeoutAttempts += 1;
    return { ok: false, error: new Error("No automatic-transmission VipCars search result cards were found.") };
  };

  await nonTimeoutScraper.runLocationWithRetries({}, "Warsaw");
  assert.equal(nonTimeoutAttempts, 1);
}).then(() => {
  if (!process.exitCode) {
    console.log("All VipCars tests passed.");
  }
});

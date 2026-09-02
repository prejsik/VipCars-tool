const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadConfig } = require("../src/vipcars/config");
const { mergeCoverageFiles } = require("../src/vipcars/coverage");
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
  assert.deepEqual(parseMoney("Pay Now PLN 90.60"), { value: 90.6, currency: "PLN", raw: "Pay Now PLN 90.60" });
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
      pay_now_amount: 4.32,
      pay_now_currency: "EUR",
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
  assert.match(html, /Scenariusze: 1 \| sprawdzenia lokalizacji: 1 \| brak MM Cars Rental: 1/);
  assert.match(html, /id="filter-date"/);
  assert.match(html, /id="filter-location"/);
  assert.match(html, /id="filter-duration"/);
  assert.match(html, /id="filter-state"/);
  assert.match(html, /data-mm-state="missing"/);
  assert.match(html, /Tylko automaty/);
  assert.match(html, /Pozycja MM/);
  assert.match(html, /@media \(max-width: 1200px\)/);

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

runAsyncTest("VipCars extracts Pay Now from the same offer card", async () => {
  const scraper = new VipCarsScraper({
    currency: "EUR",
    currentDurationDays: 2,
    pickupDate: "2026-09-04",
    dropoffDate: "2026-09-06"
  });
  const page = {
    evaluate: async () => [{
      provider: "MM Cars Rental",
      rating: "9.2",
      priceText: "EUR 28.67",
      payNowText: "Pay Now EUR 4.32",
      location: "Warsaw",
      carName: "Hyundai i30 Wagon Automatic",
      transmission: "Automatic",
      automatic: true
    }]
  };

  const offers = await scraper.extractSearchOffers(page, "Warsaw");
  assert.equal(offers.length, 1);
  assert.equal(offers[0].pay_now_amount, 4.32);
  assert.equal(offers[0].pay_now_currency, "EUR");
  assert.match(toCsv(offers).split("\n")[0], /pay_now_amount,pay_now_currency/);
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

runTest("mergeCoverageFiles combines chunk coverage", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vipcars-coverage-merge-"));
  const chunkOne = path.join(tempDir, "chunk-1");
  const chunkTwo = path.join(tempDir, "chunk-2");
  fs.mkdirSync(chunkOne);
  fs.mkdirSync(chunkTwo);
  const header = "location,duration_days,pickup_date,dropoff_date,status,result_count,error";
  fs.writeFileSync(path.join(chunkOne, "vipcars-coverage-chunk-1.csv"), [
    header,
    "Warsaw,2,2026-09-01,2026-09-03,complete,4,"
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(chunkTwo, "vipcars-coverage-chunk-2.csv"), [
    header,
    "Krakow,2,2026-09-02,2026-09-04,incomplete,0,timeout"
  ].join("\n"), "utf8");

  const outputPath = path.join(tempDir, "vipcars-coverage.csv");
  const summary = mergeCoverageFiles(tempDir, outputPath);
  const rows = parseCsv(fs.readFileSync(outputPath, "utf8"));
  assert.equal(summary.files.length, 2);
  assert.equal(summary.rowCount, 2);
  assert.deepEqual(rows.map((row) => [row.location, row.status, row.result_count]), [
    ["Warsaw", "complete", "4"],
    ["Krakow", "incomplete", "0"]
  ]);
});

runTest("Telegram alert lists only attempted pickup dates without MM Cars Rental", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vipcars-telegram-alert-"));
  const csvPath = path.join(tempDir, "vipcars-results.csv");
  const coveragePath = path.join(tempDir, "vipcars-coverage.csv");
  const alertScriptPath = path.join(__dirname, "..", "src", "vipcars", "telegramAlert.js");

  fs.writeFileSync(csvPath, toCsv([
    {
      location: "Warsaw",
      duration_days: 2,
      pickup_date: "2026-09-01",
      dropoff_date: "2026-09-03",
      provider: "Thrifty",
      price_per_day: 26,
      currency: "EUR"
    },
    {
      location: "Katowice",
      duration_days: 5,
      pickup_date: "2026-09-02",
      dropoff_date: "2026-09-07",
      provider: "MM Cars Rental",
      price_per_day: 31,
      currency: "EUR"
    }
  ]), "utf8");
  fs.writeFileSync(coveragePath, [
    "location,duration_days,pickup_date,dropoff_date,status,error",
    "Warsaw,2,2026-09-01,2026-09-03,complete,",
    "Krakow,2,2026-09-01,2026-09-03,complete,",
    "Katowice,5,2026-09-02,2026-09-07,complete,",
    "Warsaw,2,2026-09-03,2026-09-05,incomplete,timeout"
  ].join("\n"), "utf8");

  const result = spawnSync(process.execPath, [alertScriptPath, csvPath, coveragePath], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), [
    "ALERT MM CARS RENTAL",
    "Brak MM - pełne dane:",
    "- 2026-09-01",
    "",
    "Nie można potwierdzić - niepełne dane:",
    "- 2026-09-03"
  ].join("\n"));
  assert.doesNotMatch(result.stdout, /2026-09-02/);

  fs.writeFileSync(csvPath, toCsv([{
    location: "Warsaw",
    duration_days: 2,
    pickup_date: "2026-09-04",
    dropoff_date: "2026-09-06",
    provider: "mm cars rental",
    price_per_day: 30,
    currency: "EUR"
  }]), "utf8");
  fs.writeFileSync(coveragePath, [
    "location,duration_days,pickup_date,dropoff_date,status,error",
    "Warsaw,2,2026-09-04,2026-09-06,complete,"
  ].join("\n"), "utf8");

  const noAlertResult = spawnSync(process.execPath, [alertScriptPath, csvPath, coveragePath], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8"
  });
  assert.equal(noAlertResult.status, 0, noAlertResult.stderr);
  assert.equal(noAlertResult.stdout, "");
});

runTest("coverage plan records every planned location check", () => {
  const { applyScenarioChecks, createCoveragePlan } = require("../src/vipcars/coverage");
  const coverage = createCoveragePlan({
    pickupDateOptions: ["2026-09-01"],
    durationDays: [2, 3],
    locations: ["Warsaw", "Krakow"]
  });

  assert.equal(coverage.length, 4);
  assert.deepEqual(coverage.map((row) => [row.status, row.result_count]), [
    ["pending", 0],
    ["pending", 0],
    ["pending", 0],
    ["pending", 0]
  ]);

  applyScenarioChecks(coverage, "2026-09-01", 2, [
    { location: "Warsaw", status: "complete", resultCount: 3 },
    { location: "Krakow", status: "incomplete", error: "timeout" }
  ]);
  assert.deepEqual(coverage.slice(0, 2).map((row) => [row.location, row.status, row.result_count]), [
    ["Warsaw", "complete", 3],
    ["Krakow", "incomplete", 0]
  ]);
});

runTest("HTML report marks incomplete coverage", () => {
  const html = buildHtmlReport([{
    location: "Warsaw",
    duration_days: "2",
    pickup_date: "2026-09-01",
    dropoff_date: "2026-09-03",
    provider: "Thrifty",
    price_per_day: "25",
    currency: "EUR"
  }], "2026-09-01T00:00:00.000Z", [
    { location: "Warsaw", duration_days: "2", pickup_date: "2026-09-01", status: "complete", result_count: "1" },
    { location: "Krakow", duration_days: "2", pickup_date: "2026-09-01", status: "incomplete", result_count: "0" }
  ]);

  assert.match(html, /Raport częściowy: 1 z 2 kontroli nie ma kompletnych danych/);
  assert.match(html, /kontrole planowane: 2 \| z ofertami: 1 \| bez ofert: 0 \| niepełne: 1/);
});

runTest("schedule gate selects exactly one cron on DST transition dates", () => {
  const { selectScheduleForWarsawDate } = require("../src/vipcars/scheduleGate");
  assert.equal(selectScheduleForWarsawDate("2026-01-15"), "30 1 * * *");
  assert.equal(selectScheduleForWarsawDate("2026-07-15"), "30 0 * * *");
  assert.equal(selectScheduleForWarsawDate("2026-03-29"), "30 1 * * *");
  assert.equal(selectScheduleForWarsawDate("2026-10-25"), "30 1 * * *");
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
  assert.match(html, /Top 4 EUR\/d/);
  assert.match(html, /MM EUR\/d/);
  assert.match(html, /Tańsze oferty/);
  assert.match(html, /data-mm-state="top1-gap"/);
  assert.match(html, /data-mm-state="close"/);
  assert.match(html, /MM close: 3 \| MM top1 gap: 1/);
  assert.match(html, /\.mm-close \{ background: var\(--red-bg\)/);
  assert.match(html, /\.mm-top1-gap \{ background: var\(--blue-bg\)/);
  assert.match(html, /2\.5 EUR\/day/);
});

runTest("HTML report keeps Top4 and calculates MM metrics outside Top4", () => {
  const offers = [10, 11, 12, 13, 14].map((pricePerDay, index) => ({
    location: "Warsaw",
    duration_days: "2",
    pickup_date: "2026-05-15",
    dropoff_date: "2026-05-17",
    provider: `Competitor ${index + 1}`,
    provider_rating: "",
    price_per_day: String(pricePerDay),
    currency: "EUR"
  }));
  offers.push({
    location: "Warsaw",
    duration_days: "2",
    pickup_date: "2026-05-15",
    dropoff_date: "2026-05-17",
    provider: "MM Cars Rental",
    provider_rating: "",
    price_per_day: "15",
    currency: "EUR"
  });

  const html = buildHtmlReport(offers, "2026-05-15T00:00:00.000Z");
  assert.match(html, /Competitor 4/);
  assert.doesNotMatch(html, /Competitor 5/);
  assert.match(html, /<td class="mm mm-close">15\.00 EUR\/day<\/td>/);
  assert.match(html, /<td class="rank-cell">Top 6<\/td>/);
  assert.match(html, /<td class="count-cell">5<\/td>/);
});

runAsyncTest("VipCars loads beyond the first four providers", async () => {
  const scraper = new VipCarsScraper({ maxProvidersPerLocation: 25, timeoutMs: 1000 });
  const states = [
    { cardCount: 4, automaticCardCount: 4, providerCount: 4, totalCount: 8 },
    { cardCount: 8, automaticCardCount: 8, providerCount: 8, totalCount: 8 }
  ];
  let stateIndex = 0;
  let scrollCount = 0;
  const page = {
    evaluate: async (callback) => {
      if (String(callback).includes("window.scrollTo")) {
        scrollCount += 1;
        return undefined;
      }
      const state = states[Math.min(stateIndex, states.length - 1)];
      stateIndex += 1;
      return state;
    },
    waitForFunction: async () => undefined
  };

  await scraper.loadSearchResultCards(page);
  assert.equal(scrollCount, 1);
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

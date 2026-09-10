const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { loadConfig } = require("../src/vipcars/config");
const { parseCsv } = require("../src/vipcars/reportHtml");
const { VipCarsScraper } = require("../src/vipcars/scraper");
const { buildRunStatus } = require("../src/vipcars/telegramAlert");

async function main() {
  const root = path.resolve(__dirname, "..");
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/vipcars-daily.yml"), "utf8");
  const chunks = Number(workflow.match(/SCHEDULE_CHUNK_COUNT: "(\d+)"/)[1]);
  assert.equal(chunks, 60, "A daily job must contain only one of the 60 pickup dates, not two");
  assert.match(workflow, /max-parallel: 20/);
  const allDates = [];
  for (let chunk = 1; chunk <= chunks; chunk++) {
    const config = loadConfig(["--config", path.join(root, "vipcars.config.example.json"),
      "--pickup-rolling-days", "60", "--pickup-chunk-index", String(chunk), "--pickup-chunk-total", String(chunks)]);
    assert.equal(config.pickupDateOptions.length, 1);
    assert.equal(config.durationDays.length * config.locations.length, 91);
    allDates.push(...config.pickupDateOptions);
  }
  assert.equal(new Set(allDates).size, 60);
  console.log("PASS daily chunks preserve all 5460 checks with 91 checks per job");

  const pinnedArgs = ["--config", path.join(root, "vipcars.config.example.json"),
    "--pickup-dates", "2026-01-01,2026-01-02", "--pickup-chunk-total", "2", "--pickup-chunk-index", "2"];
  assert.deepEqual(loadConfig(pinnedArgs).pickupDateOptions, ["2026-01-02"],
    "Queued jobs must use the prepared dates, not recalculate rolling from their start time");
  assert.throws(() => loadConfig([...pinnedArgs, "--pickup-dates", "2026-02-30"]), /valid date/);
  assert.throws(() => loadConfig([...pinnedArgs, "--pickup-dates", " "]), /pickup-dates/);
  assert.match(workflow, /TZ: Europe\/Warsaw/);
  assert.match(workflow, /--pickup-dates "\$PICKUP_DATES"/);
  console.log("PASS queued jobs retain the prepared pickup dates");

  const status = buildRunStatus([
    { status: "complete" }, { status: "complete" },
    { status: "incomplete", error: "Timeout 45000ms exceeded." }, { status: "pending" }
  ], "failure");
  assert.match(status, /2\/4/);
  assert.match(status, /bledy: 1/);
  assert.match(status, /niedokonczone: 1/);
  assert.match(status, /timeout: 1/);
  assert.doesNotMatch(status, /^gotowy/);
  assert.doesNotMatch(buildRunStatus([{ status: "pending" }], "success"), /^gotowy/);
  assert.doesNotMatch(buildRunStatus([], "success"), /^gotowy/);
  assert.doesNotMatch(buildRunStatus([{ status: "complete" }], "failure"), /^gotowy/);
  assert.match(buildRunStatus([{ status: "complete" }], "success"), /^gotowy/);
  console.log("PASS Telegram distinguishes incomplete coverage from a successful report");

  fs.mkdirSync(path.join(root, "output"), { recursive: true });
  const temp = fs.mkdtempSync(path.join(root, "output", "reliability-test-"));
  const configPath = path.join(temp, "config.json");
  const resultsPath = path.join(temp, "results.csv");
  const coveragePath = path.join(temp, "coverage.csv");
  fs.writeFileSync(configPath, JSON.stringify({ locations: ["Warsaw", "Krakow"],
    pickupDate: "2026-09-10", dropoffDate: "2026-09-12", durationsDays: [2],
    pickupTime: "10:00", dropoffTime: "10:00", outputCsv: resultsPath,
    outputCoverage: coveragePath, artifactsDir: temp }));
  const originalLaunch = chromium.launch;
  const originalLocation = VipCarsScraper.prototype.runLocationWithRetries;
  const originalExitCode = process.exitCode;
  let closed = false;
  let calls = 0;
  chromium.launch = async () => ({ close: async () => { closed = true; } });
  VipCarsScraper.prototype.runLocationWithRetries = async (browser, location) => {
    calls += 1;
    if (location === "Warsaw") {
      return { ok: true, results: [{ location, pickup_date: "2026-09-10", dropoff_date: "2026-09-12",
        duration_days: 2, provider: "MM Cars Rental", currency: "EUR", total_price: 40, price_per_day: 20 }] };
    }
    assert.equal(parseCsv(fs.readFileSync(resultsPath, "utf8")).length, 1,
      "Finished city must already be saved before the next city starts");
    const coverage = parseCsv(fs.readFileSync(coveragePath, "utf8"));
    assert.equal(coverage[0].status, "complete");
    assert.equal(coverage[1].status, "pending");
    throw new Error("Simulated interruption after first city");
  };
  try {
    const { main: runCli } = require("../src/vipcars/cli");
    assert.equal(typeof runCli, "function");
    await runCli(["--config", configPath]);
    assert.equal(process.exitCode, 1);
    assert.equal(calls, 2);
    assert.equal(closed, true);
    assert.equal(parseCsv(fs.readFileSync(resultsPath, "utf8")).length, 1);
    assert.equal(parseCsv(fs.readFileSync(coveragePath, "utf8"))[1].status, "pending");
    console.log("PASS interruption preserves completed city on disk and closes the browser");

    calls = 0;
    VipCarsScraper.prototype.runLocationWithRetries = async function (browser, location) {
      calls += 1;
      if (calls === 2) {
        return { ok: false, error: new Error("Timeout 45000ms exceeded.") };
      }
      return { ok: true, results: [{ location, pickup_date: this.config.pickupDate,
        dropoff_date: this.config.dropoffDate, duration_days: this.config.currentDurationDays,
        provider: "MM Cars Rental", currency: "EUR", total_price: 40, price_per_day: 20 }] };
    };
    process.exitCode = undefined;
    await runCli(["--config", configPath, "--durations-days", "2,3"]);
    const savedRows = parseCsv(fs.readFileSync(resultsPath, "utf8"));
    const savedCoverage = parseCsv(fs.readFileSync(coveragePath, "utf8"));
    assert.equal(calls, 5);
    assert.equal(savedRows.length, 4);
    assert.equal(new Set(savedRows.map((row) => `${row.location}|${row.duration_days}`)).size, 4);
    assert.equal(savedCoverage.filter((row) => row.status === "complete").length, 4);
    assert.equal(savedCoverage.filter((row) => row.status === "incomplete").length, 0);
    assert.equal(process.exitCode, undefined);
    console.log("PASS delayed recovery completes a transient failed check without duplicate data");
  } finally {
    chromium.launch = originalLaunch;
    VipCarsScraper.prototype.runLocationWithRetries = originalLocation;
    process.exitCode = originalExitCode;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

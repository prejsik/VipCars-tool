const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { loadConfig, printHelp } = require("../src/vipcars/config");
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

  assert.equal(loadConfig(["--config", path.join(root, "vipcars.config.example.json")]).jobBudgetMs, 170 * 60 * 1000);
  assert.equal(loadConfig(["--config", path.join(root, "vipcars.config.example.json"),
    "--job-budget-ms", "12345"]).jobBudgetMs, 12345);
  for (const invalidBudget of ["0", "-1", "NaN", "Infinity"]) {
    assert.throws(() => loadConfig(["--config", path.join(root, "vipcars.config.example.json"),
      "--job-budget-ms", invalidBudget]), /jobBudgetMs.*positive finite/i);
  }
  console.log("PASS job budget defaults to 170 minutes and rejects invalid values");

  const defaultAttemptBudget = loadConfig(["--config", path.join(root, "vipcars.config.example.json")]);
  assert.equal(defaultAttemptBudget.timeoutMs, 45000);
  assert.equal(defaultAttemptBudget.attemptBudgetMs, 90000);
  assert.equal(loadConfig(["--config", path.join(root, "vipcars.config.example.json"),
    "--attempt-budget-ms", "12345"]).attemptBudgetMs, 12345);
  for (const invalidBudget of ["0", "-1", "NaN", "Infinity"]) {
    assert.throws(() => loadConfig(["--config", path.join(root, "vipcars.config.example.json"),
      "--attempt-budget-ms", invalidBudget]), /attemptBudgetMs.*positive finite/i);
  }
  let helpText = "";
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = (chunk) => { helpText += String(chunk); return true; };
  try {
    printHelp();
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
  assert.match(helpText, /--attempt-budget-ms 90000/);
  console.log("PASS attempt budget defaults to 90 seconds and rejects invalid values");

  assert.match(workflow, /vehicle_category:/);
  assert.match(workflow, /command\+=\(--vehicle-category "\$VEHICLE_CATEGORY"\)/);
  assert.match(workflow, /--transmission "\$TRANSMISSION"/);
  assert.match(workflow, /needs\.prepare\.outputs\.vehicle_category == ''/);
  console.log("PASS one-off category runs do not replace the daily Pages report");

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
  const originalRun = VipCarsScraper.prototype.run;
  const originalLocation = VipCarsScraper.prototype.runLocationWithRetries;
  const originalSingleLocation = VipCarsScraper.prototype.runSingleLocation;
  const originalExitCode = process.exitCode;
  const originalDateNow = Date.now;
  let launchCount = 0;
  let closeCount = 0;
  let calls = 0;
  chromium.launch = async () => {
    launchCount += 1;
    return { close: async () => { closeCount += 1; } };
  };
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
    assert.equal(launchCount, 1);
    assert.equal(closeCount, 1);
    assert.equal(parseCsv(fs.readFileSync(resultsPath, "utf8")).length, 1);
    assert.equal(parseCsv(fs.readFileSync(coveragePath, "utf8"))[1].status, "pending");
    console.log("PASS interruption preserves completed city on disk and closes the browser");

    calls = 0;
    VipCarsScraper.prototype.runLocationWithRetries = async function (browser, location) {
      calls += 1;
      if (calls === 2) {
        return { ok: false, error: new Error("Timeout 45000ms exceeded."), retryable: true, attempts: 1 };
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
    assert.equal(launchCount, 2);
    assert.equal(closeCount, 2);
    console.log("PASS delayed recovery completes a transient failed check without duplicate data");

    const permanentFailureConfigPath = path.join(temp, "non-retryable-config.json");
    const permanentFailureCoveragePath = path.join(temp, "non-retryable-coverage.csv");
    fs.writeFileSync(permanentFailureConfigPath, JSON.stringify({
      locations: ["Warsaw"], pickupDate: "2026-09-10", dropoffDate: "2026-09-12",
      durationsDays: [2], pickupTime: "10:00", dropoffTime: "10:00",
      outputCsv: path.join(temp, "non-retryable-results.csv"),
      outputCoverage: permanentFailureCoveragePath, artifactsDir: temp
    }));
    calls = 0;
    VipCarsScraper.prototype.runLocationWithRetries = async () => {
      calls += 1;
      return { ok: false, error: new Error("Invalid response."), retryable: false, attempts: 1 };
    };
    process.exitCode = undefined;
    await runCli(["--config", permanentFailureConfigPath]);
    assert.equal(calls, 1, "A non-retryable failure must not enter either recovery pass");
    assert.equal(parseCsv(fs.readFileSync(permanentFailureCoveragePath, "utf8"))[0].status, "incomplete");
    assert.equal(process.exitCode, 1);
    assert.equal(launchCount, 3);
    assert.equal(closeCount, 3);
    console.log("PASS non-retryable failures never enter recovery");

    const permanentConfigPath = path.join(temp, "permanent-timeouts-config.json");
    const permanentResultsPath = path.join(temp, "permanent-results.csv");
    const permanentCoveragePath = path.join(temp, "permanent-coverage.csv");
    fs.writeFileSync(permanentConfigPath, JSON.stringify({
      locations: ["Bydgoszcz", "Warsaw", "Krakow", "Gdansk", "Katowice", "Wroclaw", "Poznan"],
      pickupDate: "2026-09-10", dropoffDate: "2026-09-12",
      durationsDays: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      pickupTime: "10:00", dropoffTime: "10:00", outputCsv: permanentResultsPath,
      outputCoverage: permanentCoveragePath, artifactsDir: temp
    }));
    const attemptOrder = [];
    VipCarsScraper.prototype.runLocationWithRetries = originalLocation;
    VipCarsScraper.prototype.runSingleLocation = async function (browser, location, options = {}) {
      const key = [this.config.pickupDate, this.config.dropoffDate,
        this.config.currentDurationDays, location].join("|");
      attemptOrder.push(key);
      assert.equal(options.attempt, attemptOrder.filter((value) => value === key).length);
      assert.ok(Number.isFinite(options.deadlineAt));
      return { ok: false, error: new Error("Timeout 45000ms exceeded.") };
    };
    process.exitCode = undefined;
    await runCli(["--config", permanentConfigPath, "--job-budget-ms", "600000"]);
    assert.equal(attemptOrder.length, 91 * 3);
    assert.equal(new Set(attemptOrder.slice(0, 91)).size, 91,
      "Every check must run once before any check gets a second attempt");
    assert.equal(new Set(attemptOrder.slice(91, 182)).size, 91);
    assert.equal(new Set(attemptOrder.slice(182)).size, 91);
    const attemptCounts = new Map();
    for (const key of attemptOrder) {
      attemptCounts.set(key, (attemptCounts.get(key) || 0) + 1);
    }
    assert.deepEqual(new Set(attemptCounts.values()), new Set([3]));
    assert.equal(launchCount, 4);
    assert.equal(closeCount, 4);
    const permanentCoverage = parseCsv(fs.readFileSync(permanentCoveragePath, "utf8"));
    assert.equal(permanentCoverage.length, 91);
    assert.equal(permanentCoverage.filter((row) => row.status === "incomplete").length, 91);
    assert.equal(permanentCoverage.filter((row) => row.status === "pending").length, 0);
    assert.equal(process.exitCode, 1);
    console.log("PASS 91 permanent timeouts use three round-robin attempts and one browser");

    const deadlineConfigPath = path.join(temp, "deadline-config.json");
    const deadlineResultsPath = path.join(temp, "deadline-results.csv");
    const deadlineCoveragePath = path.join(temp, "deadline-coverage.csv");
    fs.writeFileSync(deadlineConfigPath, JSON.stringify({
      locations: ["Warsaw", "Krakow"], pickupDate: "2026-09-10", dropoffDate: "2026-09-12",
      durationsDays: [2], pickupTime: "10:00", dropoffTime: "10:00",
      outputCsv: deadlineResultsPath, outputCoverage: deadlineCoveragePath, artifactsDir: temp
    }));
    let now = 1000;
    Date.now = () => now;
    VipCarsScraper.prototype.run = async function (onProgress) {
      const results = [{ location: "Warsaw", pickup_date: "2026-09-10", dropoff_date: "2026-09-12",
        duration_days: 2, provider: "MM Cars Rental", currency: "EUR", total_price: 40, price_per_day: 20 }];
      const checks = [{ location: "Warsaw", status: "complete", resultCount: 1 }];
      await onProgress(results, checks);
      now = 1200;
      return { results, failures: [], checks };
    };
    process.exitCode = undefined;
    await runCli(["--config", deadlineConfigPath, "--job-budget-ms", "100"]);
    const deadlineRows = parseCsv(fs.readFileSync(deadlineCoveragePath, "utf8"));
    assert.equal(deadlineRows.find((row) => row.location === "Warsaw").status, "complete");
    const deadlineKrakow = deadlineRows.find((row) => row.location === "Krakow");
    assert.equal(deadlineKrakow.status, "incomplete");
    assert.match(deadlineKrakow.error, /job deadline/i);
    assert.equal(process.exitCode, 1);
    assert.equal(launchCount, 5);
    assert.equal(closeCount, 5);
    console.log("PASS deadline preserves checkpoints and marks remaining checks incomplete");
  } finally {
    chromium.launch = originalLaunch;
    VipCarsScraper.prototype.run = originalRun;
    VipCarsScraper.prototype.runLocationWithRetries = originalLocation;
    VipCarsScraper.prototype.runSingleLocation = originalSingleLocation;
    Date.now = originalDateNow;
    process.exitCode = originalExitCode;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

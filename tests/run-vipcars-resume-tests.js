const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { loadConfig, printHelp } = require("../src/vipcars/config");
const { parseCsv } = require("../src/vipcars/reportHtml");
const { VipCarsScraper } = require("../src/vipcars/scraper");

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "vipcars-resume-"));
  const configPath = path.join(temp, "config.json");
  const resultsPath = path.join(temp, "results.csv");
  const coveragePath = path.join(temp, "coverage.csv");
  const resumePath = `${coveragePath}.resume.json`;
  writeConfig(configPath, { resultsPath, coveragePath, artifactsDir: temp });

  let resumeConfig;
  assert.doesNotThrow(() => {
    resumeConfig = loadConfig(["--config", configPath, "--resume"]);
  });
  assert.equal(resumeConfig.resume, true);
  assert.equal(resumeConfig.resumeStatePath, resumePath);
  let helpText = "";
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = (chunk) => { helpText += String(chunk); return true; };
  try {
    printHelp();
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
  assert.match(helpText, /--resume/);
  console.log("PASS resume is an explicit public CLI option");

  const originalLaunch = chromium.launch;
  const originalSingleLocation = VipCarsScraper.prototype.runSingleLocation;
  const originalExitCode = process.exitCode;
  const originalDateNow = Date.now;
  let launches = 0;
  let closes = 0;
  const calls = [];
  chromium.launch = async () => {
    launches += 1;
    return { close: async () => { closes += 1; } };
  };

  try {
    const { main: runCli } = require("../src/vipcars/cli");
    VipCarsScraper.prototype.runSingleLocation = async function (browser, location, options) {
      calls.push({ location, attempt: options.attempt });
      if (location === "Krakow") {
        throw new Error("Simulated interruption during Krakow");
      }
      return success(this.config, location);
    };

    const interrupted = await invokeCli(runCli, ["--config", configPath]);
    assert.equal(interrupted.exitCode, 1);
    assert.match(interrupted.errors, /Simulated interruption during Krakow/);
    assert.deepEqual(calls, [
      { location: "Warsaw", attempt: 1 },
      { location: "Krakow", attempt: 1 }
    ]);
    assert.equal(launches, 1);
    assert.equal(closes, 1);

    const partialState = readJson(resumePath);
    assert.ok(partialState.run_id);
    assert.ok(Number.isFinite(Date.parse(partialState.started_at)));
    assert.deepEqual(partialState.fingerprint, {
      base_url: "https://www.vipcars.com",
      pickup_dates: ["2026-09-10"],
      duration_days: [2],
      locations: ["Warsaw", "Krakow"],
      currency: "EUR",
      pickup_time: "10:00",
      dropoff_time: "10:00",
      transmission: "automatic",
      vehicle_category: "",
      residence_country: "Poland",
      driver_age: 30,
      max_providers_per_location: 25,
      timeout_ms: 45000,
      attempt_budget_ms: 90000,
      job_budget_ms: 170 * 60 * 1000,
      network_results: false
    });
    assert.equal(partialState.results.length, 1);
    assert.equal(partialState.coverage.find((row) => row.location === "Warsaw").status, "complete");
    assert.equal(partialState.coverage.find((row) => row.location === "Krakow").status, "pending");
    assert.equal(partialState.attempt_counts[checkKey("Warsaw")], 1);
    assert.equal(partialState.attempt_counts[checkKey("Krakow")], 1,
      "The in-flight attempt must be durable before the location outcome returns");
    console.log("PASS interruption atomically preserves completed work and shared attempt counts");

    fs.writeFileSync(resultsPath,
      "location,duration_days,pickup_date,dropoff_date,provider,total_price,currency\n" +
      "OLD,2,2026-09-10,2026-09-12,Old Price,999,EUR\n");
    fs.writeFileSync(coveragePath,
      "location,duration_days,pickup_date,dropoff_date,status,result_count,error\n" +
      "Warsaw,2,2026-09-10,2026-09-12,complete,1,\n" +
      "Krakow,2,2026-09-10,2026-09-12,complete,1,\n");
    calls.length = 0;
    VipCarsScraper.prototype.runSingleLocation = async function (browser, location, options) {
      calls.push({ location, attempt: options.attempt });
      const error = new Error("Timeout 45000ms exceeded.");
      return { ok: false, error };
    };

    const resumed = await invokeCli(runCli, ["--config", configPath, "--resume"]);
    assert.equal(resumed.exitCode, 1);
    assert.deepEqual(calls, [
      { location: "Krakow", attempt: 2 },
      { location: "Krakow", attempt: 3 }
    ]);
    const exhaustedState = readJson(resumePath);
    assert.equal(exhaustedState.run_id, partialState.run_id);
    assert.equal(exhaustedState.started_at, partialState.started_at);
    assert.equal(exhaustedState.attempt_counts[checkKey("Krakow")], 3);
    assert.equal(exhaustedState.coverage.find((row) => row.location === "Warsaw").status, "complete");
    assert.equal(exhaustedState.coverage.find((row) => row.location === "Krakow").status, "incomplete");
    assert.equal(parseCsv(fs.readFileSync(resultsPath, "utf8")).some((row) => row.location === "OLD"), false);
    assert.equal(parseCsv(fs.readFileSync(coveragePath, "utf8"))
      .find((row) => row.location === "Krakow").status, "incomplete");
    console.log("PASS resume trusts canonical JSON, skips completed checks, and never exceeds three attempts");

    calls.length = 0;
    const exhaustedResume = await invokeCli(runCli, ["--config", configPath, "--resume"]);
    assert.equal(exhaustedResume.exitCode, 1);
    assert.deepEqual(calls, []);
    assert.equal(readJson(resumePath).attempt_counts[checkKey("Krakow")], 3);
    console.log("PASS exhausted incomplete checks are not attempted again");

    const finalAttemptState = clone(partialState);
    finalAttemptState.coverage.find((row) => row.location === "Krakow").status = "incomplete";
    finalAttemptState.coverage.find((row) => row.location === "Krakow").error = "Previous timeout";
    finalAttemptState.attempt_counts[checkKey("Krakow")] = 2;
    writeJson(resumePath, finalAttemptState);
    calls.length = 0;
    VipCarsScraper.prototype.runSingleLocation = async function (browser, location, options) {
      calls.push({ location, attempt: options.attempt });
      return success(this.config, location);
    };
    const originalWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = (targetPath, content, ...args) => {
      if (targetPath === resultsPath && String(content).includes("Krakow")) {
        throw new Error("Simulated derived CSV write failure");
      }
      return originalWriteFileSync(targetPath, content, ...args);
    };
    const interruptedFinalAttempt = await invokeCli(runCli, ["--config", configPath, "--resume"]);
    fs.writeFileSync = originalWriteFileSync;
    assert.equal(interruptedFinalAttempt.exitCode, 1);
    assert.match(interruptedFinalAttempt.errors, /Simulated derived CSV write failure/);
    assert.deepEqual(calls, [{ location: "Krakow", attempt: 3 }]);
    const completedCanonicalState = readJson(resumePath);
    assert.equal(completedCanonicalState.attempt_counts[checkKey("Krakow")], 3);
    assert.equal(completedCanonicalState.coverage.find((row) => row.location === "Krakow").status, "complete");
    assert.equal(completedCanonicalState.results.some((row) => row.location === "Krakow"), true);
    calls.length = 0;
    const regeneratedOutputs = await invokeCli(runCli, ["--config", configPath, "--resume"]);
    assert.equal(regeneratedOutputs.exitCode, undefined);
    assert.deepEqual(calls, []);
    assert.equal(parseCsv(fs.readFileSync(resultsPath, "utf8")).some((row) => row.location === "Krakow"), true);
    console.log("PASS canonical state survives a derived-output failure after the final attempt");

    writeJson(resumePath, exhaustedState);
    VipCarsScraper.prototype.runSingleLocation = async function (browser, location, options) {
      calls.push({ location, attempt: options.attempt });
      const error = new Error("Timeout 45000ms exceeded.");
      return { ok: false, error };
    };

    const previousPath = `${resumePath}.previous`;
    fs.renameSync(resumePath, previousPath);
    const originalRenameSync = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (destination === resumePath && source.endsWith(".tmp")) {
        throw new Error("Simulated checkpoint swap failure");
      }
      return originalRenameSync(source, destination);
    };
    const failedRecoverySave = await invokeCli(runCli, ["--config", configPath, "--resume"]);
    fs.renameSync = originalRenameSync;
    assert.equal(failedRecoverySave.exitCode, 1);
    assert.match(failedRecoverySave.errors, /Simulated checkpoint swap failure/);
    assert.equal(fs.existsSync(previousPath), true,
      "A failed recovery save must retain the last valid checkpoint fallback");
    assert.equal(readJson(previousPath).run_id, exhaustedState.run_id);
    fs.renameSync(previousPath, resumePath);
    console.log("PASS an interrupted atomic recovery retains the previous checkpoint");

    writeJson(resumePath, exhaustedState);
    const mismatchConfigPath = path.join(temp, "mismatch-config.json");
    writeConfig(mismatchConfigPath, {
      resultsPath,
      coveragePath,
      artifactsDir: temp,
      locations: ["Warsaw", "Poznan"]
    });
    calls.length = 0;
    const mismatch = await invokeCli(runCli, ["--config", mismatchConfigPath, "--resume"]);
    assert.equal(mismatch.exitCode, 1);
    assert.match(mismatch.errors, /fingerprint/i);
    assert.deepEqual(calls, []);
    console.log("PASS mismatched run fingerprints are rejected before scraping");

    const fingerprintChanges = [
      ["baseUrl", "https://example.invalid"],
      ["residenceCountry", "Ireland"],
      ["driverAge", 45],
      ["maxProvidersPerLocation", 1],
      ["timeoutMs", 46000],
      ["attemptBudgetMs", 91000],
      ["jobBudgetMs", 171 * 60 * 1000],
      ["networkResults", true]
    ];
    for (const [field, value] of fingerprintChanges) {
      const changedConfigPath = path.join(temp, `changed-${field}.json`);
      writeConfig(changedConfigPath, {
        resultsPath,
        coveragePath,
        artifactsDir: temp,
        [field]: value
      });
      writeJson(resumePath, exhaustedState);
      calls.length = 0;
      const changed = await invokeCli(runCli, ["--config", changedConfigPath, "--resume"]);
      assert.equal(changed.exitCode, 1, `${field} must invalidate the resume checkpoint`);
      assert.match(changed.errors, /fingerprint/i, `${field} must report a fingerprint mismatch`);
      assert.deepEqual(calls, []);
    }
    console.log("PASS every search and budget setting invalidates incompatible resume state");

    const expiredBudgetState = clone(partialState);
    expiredBudgetState.started_at = new Date(Date.now() - 170 * 60 * 1000 - 1).toISOString();
    writeJson(resumePath, expiredBudgetState);
    calls.length = 0;
    const expiredBudget = await invokeCli(runCli, ["--config", configPath, "--resume"]);
    assert.equal(expiredBudget.exitCode, 1);
    assert.deepEqual(calls, []);
    assert.match(readJson(resumePath).coverage.find((row) => row.location === "Krakow").error,
      /job deadline/i);
    console.log("PASS resume keeps the original run's shared job deadline");

    const staleState = clone(exhaustedState);
    staleState.started_at = new Date(Date.now() - 6 * 60 * 60 * 1000 - 1).toISOString();
    writeJson(resumePath, staleState);
    const stale = await invokeCli(runCli, ["--config", configPath, "--resume"]);
    assert.equal(stale.exitCode, 1);
    assert.match(stale.errors, /older than 6 hours/i);
    console.log("PASS stale checkpoints are rejected");

    const crossDateState = clone(exhaustedState);
    crossDateState.started_at = "2026-09-26T21:30:00.000Z";
    writeJson(resumePath, crossDateState);
    Date.now = () => Date.parse("2026-09-26T23:00:00.000Z");
    const crossDate = await invokeCli(runCli, ["--config", configPath, "--resume"]);
    Date.now = originalDateNow;
    assert.equal(crossDate.exitCode, 1);
    assert.match(crossDate.errors, /Warsaw calendar date/i);
    console.log("PASS checkpoints cannot cross a Warsaw calendar date");

    const corruptCoverage = clone(exhaustedState);
    corruptCoverage.coverage.pop();
    writeJson(resumePath, corruptCoverage);
    const corrupt = await invokeCli(runCli, ["--config", configPath, "--resume"]);
    assert.equal(corrupt.exitCode, 1);
    assert.match(corrupt.errors, /coverage/i);

    const corruptAttempts = clone(exhaustedState);
    corruptAttempts.attempt_counts[checkKey("Krakow")] = 4;
    writeJson(resumePath, corruptAttempts);
    const excessive = await invokeCli(runCli, ["--config", configPath, "--resume"]);
    assert.equal(excessive.exitCode, 1);
    assert.match(excessive.errors, /attempt count/i);
    console.log("PASS corrupt coverage and attempt counts are rejected");

    writeJson(resumePath, exhaustedState);
    calls.length = 0;
    VipCarsScraper.prototype.runSingleLocation = async function (browser, location, options) {
      calls.push({ location, attempt: options.attempt });
      return success(this.config, location);
    };
    const fresh = await invokeCli(runCli, ["--config", configPath]);
    assert.equal(fresh.exitCode, undefined);
    assert.deepEqual(calls, [
      { location: "Warsaw", attempt: 1 },
      { location: "Krakow", attempt: 1 }
    ]);
    const replacedState = readJson(resumePath);
    assert.notEqual(replacedState.run_id, exhaustedState.run_id);
    assert.equal(replacedState.results.length, 2);
    assert.equal(replacedState.coverage.every((row) => row.status === "complete"), true);
    console.log("PASS a normal run intentionally replaces prior resume state");
  } finally {
    chromium.launch = originalLaunch;
    VipCarsScraper.prototype.runSingleLocation = originalSingleLocation;
    Date.now = originalDateNow;
    process.exitCode = originalExitCode;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function writeConfig(targetPath, options) {
  fs.writeFileSync(targetPath, JSON.stringify({
    baseUrl: options.baseUrl || "https://www.vipcars.com",
    locations: options.locations || ["Warsaw", "Krakow"],
    pickupDate: "2026-09-10",
    dropoffDate: "2026-09-12",
    durationsDays: [2],
    pickupTime: "10:00",
    dropoffTime: "10:00",
    currency: "EUR",
    residenceCountry: options.residenceCountry || "Poland",
    driverAge: options.driverAge || 30,
    maxProvidersPerLocation: options.maxProvidersPerLocation || 25,
    timeoutMs: options.timeoutMs || 45000,
    attemptBudgetMs: options.attemptBudgetMs || 90000,
    jobBudgetMs: options.jobBudgetMs || 170 * 60 * 1000,
    networkResults: options.networkResults === true,
    transmission: "automatic",
    outputCsv: options.resultsPath,
    outputCoverage: options.coveragePath,
    artifactsDir: options.artifactsDir
  }));
}

function success(config, location) {
  const result = {
    location,
    duration_days: config.currentDurationDays,
    pickup_date: config.pickupDate,
    dropoff_date: config.dropoffDate,
    provider: "MM Cars Rental",
    provider_rating: "",
    total_price: 40,
    price_per_day: 20,
    pay_now_amount: "",
    pay_now_currency: "",
    currency: config.currency,
    source: "test"
  };
  return { ok: true, results: [result], cheapest: result };
}

async function invokeCli(runCli, args) {
  const originalConsoleError = console.error;
  const errors = [];
  process.exitCode = undefined;
  console.error = (...values) => { errors.push(values.map(String).join(" ")); };
  try {
    await runCli(args);
  } finally {
    console.error = originalConsoleError;
  }
  return { exitCode: process.exitCode, errors: errors.join("\n") };
}

function checkKey(location) {
  return ["2026-09-10", "2026-09-12", 2, location].join("|");
}

function readJson(targetPath) {
  return JSON.parse(fs.readFileSync(targetPath, "utf8"));
}

function writeJson(targetPath, value) {
  fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { loadConfig, printHelp } = require("../src/vipcars/config");
const { parseCsv } = require("../src/vipcars/reportHtml");
const { createRunState, loadRunState, saveRunState } = require("../src/vipcars/resumeState");
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
  const githubEnvKeys = ["GITHUB_ACTIONS", "GITHUB_RUN_ID", "GITHUB_SHA", "GITHUB_RUN_ATTEMPT", "VIPCARS_RESUME_SAME_GITHUB_RUN"];
  const originalGithubEnv = Object.fromEntries(githubEnvKeys.map((key) => [key, process.env[key]]));
  githubEnvKeys.forEach((key) => { delete process.env[key]; });
  const testNow = Date.parse("2026-09-27T12:00:00.000Z");
  let launches = 0;
  let closes = 0;
  const calls = [];
  chromium.launch = async () => {
    launches += 1;
    return { close: async () => { closes += 1; } };
  };

  try {
    // Keep deadline tests on one Warsaw calendar day regardless of wall-clock time.
    Date.now = () => testNow;
    const { main: runCli } = require("../src/vipcars/cli");

    const checkpointNow = Date.parse("2026-09-27T12:00:00.000Z");
    const cooldownStatePath = path.join(temp, "cooldown.resume.json");
    const cooldownState = createRunState(resumeConfig, checkpointNow);
    const futureCooldownUntil = checkpointNow + 30 * 60 * 1000;
    cooldownState.cooldown.until = futureCooldownUntil;
    saveRunState(cooldownStatePath, cooldownState);
    assert.equal(readJson(cooldownStatePath).cooldown_until, futureCooldownUntil);
    assert.equal(loadRunState(cooldownStatePath, resumeConfig, checkpointNow).cooldown.until,
      futureCooldownUntil);
    console.log("PASS a future cooldown round-trips through the resume checkpoint");

    const expiredCooldownUntil = checkpointNow - 60 * 1000;
    cooldownState.cooldown.until = expiredCooldownUntil;
    saveRunState(cooldownStatePath, cooldownState);
    assert.equal(loadRunState(cooldownStatePath, resumeConfig, checkpointNow).cooldown.until,
      expiredCooldownUntil);
    console.log("PASS an expired cooldown timestamp is preserved for auditability");

    const legacyCheckpoint = readJson(cooldownStatePath);
    delete legacyCheckpoint.cooldown_until;
    writeJson(cooldownStatePath, legacyCheckpoint);
    assert.equal(loadRunState(cooldownStatePath, resumeConfig, checkpointNow).cooldown.until, 0);
    console.log("PASS checkpoints without cooldown_until default to zero");

    const validCooldownCheckpoint = clone(legacyCheckpoint);
    validCooldownCheckpoint.cooldown_until = 0;
    const invalidCooldowns = [
      ["negative", -1],
      ["string", "123"],
      ["above the maximum timestamp", 8640000000000001]
    ];
    for (const [description, value] of invalidCooldowns) {
      const invalidCheckpoint = clone(validCooldownCheckpoint);
      invalidCheckpoint.cooldown_until = value;
      writeJson(cooldownStatePath, invalidCheckpoint);
      assert.throws(
        () => loadRunState(cooldownStatePath, resumeConfig, checkpointNow),
        /cooldown_until is invalid/,
        `${description} cooldown_until must be rejected`
      );
    }
    const nonFiniteCheckpoint = JSON.stringify({
      ...validCooldownCheckpoint,
      cooldown_until: "__NON_FINITE__"
    }, null, 2).replace('"__NON_FINITE__"', "1e309");
    fs.writeFileSync(cooldownStatePath, `${nonFiniteCheckpoint}\n`);
    assert.throws(
      () => loadRunState(cooldownStatePath, resumeConfig, checkpointNow),
      /cooldown_until is invalid/,
      "non-finite cooldown_until must be rejected"
    );
    console.log("PASS invalid cooldown timestamps are rejected");

    const callbackDir = path.join(temp, "cooldown-callback");
    const callbackConfigPath = path.join(callbackDir, "config.json");
    const callbackResultsPath = path.join(callbackDir, "results.csv");
    const callbackCoveragePath = path.join(callbackDir, "coverage.csv");
    const callbackResumePath = `${callbackCoveragePath}.resume.json`;
    fs.mkdirSync(callbackDir, { recursive: true });
    writeConfig(callbackConfigPath, {
      resultsPath: callbackResultsPath,
      coveragePath: callbackCoveragePath,
      artifactsDir: callbackDir,
      locations: ["Warsaw"]
    });
    const callbackConfig = loadConfig(["--config", callbackConfigPath]);
    const futureCallbackCooldownUntil = Date.now() + 60 * 60 * 1000;
    const callbackLaunchesBefore = launches;
    const callbackClosesBefore = closes;
    const callbackSingleLocationBefore = VipCarsScraper.prototype.runSingleLocation;
    let persistedDuringAttempt;
    try {
      VipCarsScraper.prototype.runSingleLocation = async function (browser, location, options) {
        assert.equal(typeof options.onCooldown, "function",
          "CLI must provide an immediate cooldown checkpoint callback");
        options.cooldown.until = futureCallbackCooldownUntil;
        options.onCooldown();
        persistedDuringAttempt = readJson(callbackResumePath).cooldown_until;
        assert.equal(persistedDuringAttempt, futureCallbackCooldownUntil);
        throw new Error("Simulated interruption after cooldown checkpoint");
      };
      const callbackInterrupted = await invokeCli(runCli, ["--config", callbackConfigPath]);
      assert.equal(callbackInterrupted.exitCode, 1);
      assert.match(callbackInterrupted.errors, /Simulated interruption after cooldown checkpoint/);
      assert.equal(persistedDuringAttempt, futureCallbackCooldownUntil);
      assert.equal(loadRunState(callbackResumePath, callbackConfig).cooldown.until,
        futureCallbackCooldownUntil);
      assert.equal(launches, callbackLaunchesBefore + 1);
      assert.equal(closes, callbackClosesBefore + 1);
    } finally {
      VipCarsScraper.prototype.runSingleLocation = callbackSingleLocationBefore;
      launches = callbackLaunchesBefore;
      closes = callbackClosesBefore;
    }
    console.log("PASS an in-flight cooldown is checkpointed before a later interruption");

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
    Date.now = () => testNow;
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

    await testPermanentFailureResume(temp, runCli);
    await testWorkflowResume(temp, runCli);
  } finally {
    chromium.launch = originalLaunch;
    VipCarsScraper.prototype.runSingleLocation = originalSingleLocation;
    Date.now = originalDateNow;
    process.exitCode = originalExitCode;
    for (const key of githubEnvKeys) {
      if (originalGithubEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalGithubEnv[key];
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function testPermanentFailureResume(temp, runCli) {
  const configPath = path.join(temp, "permanent-config.json");
  const coveragePath = path.join(temp, "permanent-coverage.csv");
  const resumePath = `${coveragePath}.resume.json`;
  writeConfig(configPath, { resultsPath: path.join(temp, "permanent-results.csv"),
    coveragePath, artifactsDir: temp });
  const calls = [];
  VipCarsScraper.prototype.runSingleLocation = async function (browser, location, options) {
    calls.push({ location, attempt: options.attempt });
    if (location === "Krakow") throw new Error("Interrupted after permanent failure");
    const error = new Error("HTTP 403: search page unavailable.");
    error.code = "HTTP_403";
    error.retryable = false;
    return { ok: false, error };
  };
  const interrupted = await invokeCli(runCli, ["--config", configPath]);
  assert.match(interrupted.errors, /Interrupted after permanent failure/);
  const checkpoint = readJson(resumePath);
  assert.equal(checkpoint.retryability?.[checkKey("Warsaw")], false,
    "Permanent failure must be durable before the following city is interrupted");
  calls.length = 0;
  VipCarsScraper.prototype.runSingleLocation = async function (browser, location, options) {
    calls.push({ location, attempt: options.attempt });
    return success(this.config, location);
  };
  const recovered = await invokeCli(runCli, ["--config", configPath, "--resume"]);
  assert.equal(recovered.exitCode, 1, "Permanent failure remains incomplete, never fabricated as complete");
  assert.deepEqual(calls, [{ location: "Krakow", attempt: 2 }]);
  assert.equal(readJson(resumePath).attempt_counts[checkKey("Warsaw")], 1);
  calls.length = 0;
  await invokeCli(runCli, ["--config", configPath, "--resume"]);
  assert.deepEqual(calls, []);

  const legacy = clone(checkpoint);
  delete legacy.retryability;
  writeJson(resumePath, legacy);
  calls.length = 0;
  await invokeCli(runCli, ["--config", configPath, "--resume"]);
  assert.deepEqual(calls, [{ location: "Krakow", attempt: 2 }],
    "Legacy explicit HTTP 403 failures must not be repeated either");
  const config = loadConfig(["--config", configPath]);
  const recoveredCheckpoint = readJson(resumePath);
  for (const [error, cooldownUntil] of [["HTTP 429: search page unavailable.", 0],
    ["HTTP 400: Retry-After 120 seconds.", Date.now() + 120000],
    ["HTTP 403: search page unavailable.", Date.now() + 120000]]) {
    const older = clone(legacy);
    older.coverage.find((row) => row.location === "Warsaw").error = error;
    older.cooldown_until = cooldownUntil;
    writeJson(resumePath, older);
    assert.notEqual(loadRunState(resumePath, config).retryability.get(checkKey("Warsaw")), false,
      "Legacy unknown retryability or a cooldown must not be inferred as a permanent failure");
  }
  for (const retryability of [null, [], { [checkKey("Warsaw")]: "false" },
    { unexpected: false }, { [checkKey("Krakow")]: true }]) {
    const corrupt = clone(recoveredCheckpoint);
    corrupt.retryability = retryability;
    writeJson(resumePath, corrupt);
    assert.throws(() => loadRunState(resumePath, config), /retryability/i);
  }
  console.log("PASS permanent failures survive interruption and resume, including legacy HTTP 403 checkpoints");
}

async function testWorkflowResume(temp, runCli) {
  const configPath = path.join(temp, "workflow-config.json");
  const coveragePath = path.join(temp, "workflow-coverage.csv");
  const resultsPath = path.join(temp, "workflow-results.csv");
  const resumePath = `${coveragePath}.resume.json`;
  writeConfig(configPath, { resultsPath, coveragePath, artifactsDir: temp,
    locations: ["Warsaw", "Krakow", "Poznan", "Gdansk"], durationsDays: [2, 3] });
  const config = loadConfig(["--config", configPath]);
  process.env.GITHUB_RUN_ID = "leftover-local-value";
  process.env.GITHUB_SHA = "leftover-local-value";
  process.env.GITHUB_RUN_ATTEMPT = "leftover-local-value";
  assert.equal(createRunState(config).workflowScope, null,
    "Outside Actions, unrelated GITHUB_* environment values must not bind local checkpoints");
  process.env.VIPCARS_RESUME_SAME_GITHUB_RUN = "1";
  assert.throws(() => createRunState(config), /GITHUB_ACTIONS/i,
    "Explicit workflow recovery must fail closed outside Actions");
  process.env.GITHUB_ACTIONS = "true";
  const startedAt = Date.parse("2026-09-26T21:30:00.000Z");
  let now = startedAt;
  Date.now = () => now;
  process.env.GITHUB_RUN_ID = "123456789";
  process.env.GITHUB_SHA = "a".repeat(40);
  process.env.GITHUB_RUN_ATTEMPT = "1";
  process.env.VIPCARS_RESUME_SAME_GITHUB_RUN = "1";
  const calls = [];
  VipCarsScraper.prototype.runSingleLocation = async function (browser, location, options) {
    calls.push({ location, duration: this.config.currentDurationDays, attempt: options.attempt });
    if (location === "Poznan") throw new Error("Interrupted workflow");
    if (location === "Krakow") return { ok: false, error: new Error("Timeout 45000ms exceeded.") };
    return success(this.config, location);
  };
  const interrupted = await invokeCli(runCli, ["--config", configPath]);
  assert.match(interrupted.errors, /Interrupted workflow/);
  const checkpoint = readJson(resumePath);
  assert.deepEqual(checkpoint.workflow_scope, { run_id: "123456789", sha: "a".repeat(40), run_attempt: 1 });
  assert.equal(checkpoint.coverage.length, 8);
  const overnight = startedAt + 15 * 60 * 60 * 1000;
  checkpoint.cooldown_until = overnight + config.jobBudgetMs + 1000;
  writeJson(resumePath, checkpoint);
  now = overnight;
  process.env.GITHUB_RUN_ATTEMPT = "2";
  calls.length = 0;
  const blockedByCooldown = await invokeCli(runCli, ["--config", configPath, "--resume"]);
  assert.equal(blockedByCooldown.exitCode, 1);
  assert.deepEqual(calls, [], "Future cooldown must survive the new job's fresh budget");
  const deferred = readJson(resumePath);
  assert.deepEqual(deferred.attempt_counts, checkpoint.attempt_counts);
  assert.deepEqual(deferred.results, checkpoint.results);
  assert.equal(deferred.cooldown_until, checkpoint.cooldown_until);
  assert.equal(deferred.started_at, checkpoint.started_at);
  assert.equal(deferred.workflow_scope.run_attempt, 2);
  assert.equal(deferred.budget_started_at, new Date(overnight).toISOString());

  now = checkpoint.cooldown_until + 1;
  const sameAttempt = await invokeCli(runCli, ["--config", configPath, "--resume"]);
  assert.equal(sameAttempt.exitCode, 1);
  assert.deepEqual(calls, [], "Restarting the same attempt must not renew its expired budget");
  assert.equal(readJson(resumePath).budget_started_at, deferred.budget_started_at);
  process.env.GITHUB_RUN_ATTEMPT = "3";
  const freshDeadline = now + config.jobBudgetMs;
  VipCarsScraper.prototype.runSingleLocation = async function (browser, location, options) {
    calls.push({ location, duration: this.config.currentDurationDays, attempt: options.attempt });
    assert.equal(options.deadlineAt, freshDeadline);
    assert.equal(options.cooldown.until, checkpoint.cooldown_until);
    if (location === "Krakow" && this.config.currentDurationDays === 2) {
      return { ok: false, error: new Error("Timeout 45000ms exceeded.") };
    }
    return success(this.config, location);
  };
  const recovered = await invokeCli(runCli, ["--config", configPath, "--resume"]);
  assert.equal(recovered.exitCode, 1);
  assert.deepEqual(calls, [
    { location: "Krakow", duration: 2, attempt: 2 },
    { location: "Poznan", duration: 2, attempt: 2 },
    { location: "Gdansk", duration: 2, attempt: 1 },
    { location: "Warsaw", duration: 3, attempt: 1 },
    { location: "Krakow", duration: 3, attempt: 1 },
    { location: "Poznan", duration: 3, attempt: 1 },
    { location: "Gdansk", duration: 3, attempt: 1 },
    { location: "Krakow", duration: 2, attempt: 3 }
  ]);
  const completed = readJson(resumePath);
  assert.equal(completed.run_id, checkpoint.run_id);
  assert.equal(completed.started_at, checkpoint.started_at);
  assert.deepEqual(completed.fingerprint, checkpoint.fingerprint);
  assert.deepEqual(completed.workflow_scope, { ...checkpoint.workflow_scope, run_attempt: 3 });
  assert.equal(completed.budget_started_at, new Date(now).toISOString());
  assert.deepEqual(completed.results[0], checkpoint.results[0]);
  assert.equal(completed.results.length, 7);
  assert.equal(completed.coverage.length, 8);
  assert.equal(completed.coverage.filter((row) => row.status === "complete").length, 7);
  assert.equal(completed.attempt_counts[checkKey("Krakow")], 3);
  calls.length = 0;
  await invokeCli(runCli, ["--config", configPath, "--resume"]);
  assert.deepEqual(calls, []);
  assert.equal(parseCsv(fs.readFileSync(resultsPath, "utf8")).length, 7);
  console.log("PASS overnight workflow recovery preserves full scope, values, cooldown, and the cumulative three-attempt limit");

  for (const [key, value] of [["GITHUB_RUN_ID", "987654321"], ["GITHUB_SHA", "b".repeat(40)],
    ["GITHUB_RUN_ID", undefined], ["GITHUB_SHA", undefined], ["GITHUB_RUN_ATTEMPT", undefined],
    ["GITHUB_RUN_ATTEMPT", "2"], ["GITHUB_RUN_ATTEMPT", "bad"]]) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    const before = fs.readFileSync(resumePath, "utf8");
    const rejected = await invokeCli(runCli, ["--config", configPath, "--resume"]);
    assert.equal(rejected.exitCode, 1);
    assert.match(rejected.errors, /workflow scope|GITHUB_RUN_ID|GITHUB_SHA|GITHUB_RUN_ATTEMPT/i);
    assert.equal(fs.readFileSync(resumePath, "utf8"), before);
    process.env[key] = previous;
  }
  for (const changedConfig of [{ ...config, locations: ["Warsaw"] },
    { ...config, pickupDateOptions: ["2026-09-11"] }, { ...config, durationDays: [2] }]) {
    assert.throws(() => loadRunState(resumePath, changedConfig, now), /fingerprint/i);
  }
  const legacy = clone(completed);
  delete legacy.workflow_scope;
  writeJson(resumePath, legacy);
  assert.throws(() => loadRunState(resumePath, config, now), /workflow scope/i);
  writeJson(resumePath, completed);
  assert.doesNotThrow(() => loadRunState(resumePath, config, startedAt + 24 * 60 * 60 * 1000));
  assert.throws(() => loadRunState(resumePath, config, startedAt + 24 * 60 * 60 * 1000 + 1), /24 hours/i);
  assert.throws(() => loadRunState(resumePath, config, startedAt - 1), /future/i);
  for (const budgetStartedAt of ["invalid", new Date(startedAt - 1).toISOString(),
    new Date(now + 1).toISOString()]) {
    writeJson(resumePath, { ...completed, budget_started_at: budgetStartedAt });
    assert.throws(() => loadRunState(resumePath, config, now), /budget_started_at/i);
  }
  for (const scope of [{ ...completed.workflow_scope, run_attempt: 0 },
    { ...completed.workflow_scope, sha: "bad" }, { ...completed.workflow_scope, run_id: 123456789 }]) {
    writeJson(resumePath, { ...completed, workflow_scope: scope });
    assert.throws(() => loadRunState(resumePath, config, now), /workflow scope/i);
  }
  const previousNow = now;
  now = startedAt + 24 * 60 * 60 * 1000;
  process.env.GITHUB_RUN_ATTEMPT = "4";
  writeJson(resumePath, { ...checkpoint, cooldown_until: 0 });
  calls.length = 0;
  const batchExpired = await invokeCli(runCli, ["--config", configPath, "--resume"]);
  assert.equal(batchExpired.exitCode, 1);
  assert.deepEqual(calls, [], "Even a higher attempt cannot extend the whole batch past 24 hours");
  assert.deepEqual(readJson(resumePath).attempt_counts, checkpoint.attempt_counts);
  now = previousNow;
  process.env.GITHUB_RUN_ATTEMPT = "3";
  writeJson(resumePath, completed);
  delete process.env.VIPCARS_RESUME_SAME_GITHUB_RUN;
  assert.throws(() => loadRunState(resumePath, config, now), /6 hours/i);
  assert.throws(() => loadRunState(resumePath, config, startedAt + 90 * 60 * 1000), /Warsaw calendar date/i);
  for (const scope of [false, "", null]) {
    writeJson(resumePath, { ...checkpoint, workflow_scope: scope });
    assert.throws(() => loadRunState(resumePath, config, startedAt), /workflow scope/i,
      "Malformed scope must not be mistaken for an unbound legacy checkpoint");
  }
  process.env.GITHUB_SHA = "a".repeat(41);
  assert.throws(() => createRunState(config, now), /workflow scope/i);
  process.env.GITHUB_SHA = "a".repeat(40);
  writeJson(resumePath, completed);
  delete process.env.GITHUB_RUN_ID;
  delete process.env.GITHUB_SHA;
  delete process.env.GITHUB_RUN_ATTEMPT;
  delete process.env.GITHUB_ACTIONS;
  assert.throws(() => loadRunState(resumePath, config, startedAt), /workflow scope/i);
  console.log("PASS wrong/missing workflow identities, changed shards/dates, and expired checkpoints fail closed");
}

function writeConfig(targetPath, options) {
  fs.writeFileSync(targetPath, JSON.stringify({
    baseUrl: options.baseUrl || "https://www.vipcars.com",
    locations: options.locations || ["Warsaw", "Krakow"],
    pickupDate: "2026-09-10",
    dropoffDate: "2026-09-12",
    durationsDays: options.durationsDays || [2],
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

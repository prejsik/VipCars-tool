#!/usr/bin/env node

const { chromium } = require("playwright");
const { loadConfig, printHelp } = require("./config");
const { applyScenarioChecks, toCoverageCsv } = require("./coverage");
const { createRunState, loadRunState, saveRunState } = require("./resumeState");
const { addDaysToIsoDate, toCsv, writeTextFile } = require("./utils");

const MAX_ATTEMPTS_PER_CHECK = 3;
const RECOVERY_PASSES = 2;
const DEADLINE_REASON = "VipCars job deadline reached before this check could be completed.";

async function main(argv = process.argv.slice(2)) {
  try {
    const config = loadConfig(argv);
    if (config.help) {
      printHelp();
      return;
    }

    console.log("VipCars scraper started");
    console.log(`Locations: ${config.locations.join(", ")}`);
    if (config.vehicleCategory) {
      console.log(`Vehicle category: ${config.vehicleCategory}`);
    }
    console.log(`Transmission: ${config.transmission}`);
    console.log(`Pickup options: ${config.pickupDateOptions.join(", ")} ${config.pickupTime}`);
    console.log(`Durations (days): ${config.durationDays.join(", ")}`);
    if (config.pickupChunkTotal > 1) {
      console.log(`Pickup chunk: ${config.pickupChunkIndex}/${config.pickupChunkTotal}`);
    }
    console.log("");

    const { VipCarsScraper } = require("./scraper");
    const runState = config.resume
      ? loadRunState(config.resumeStatePath, config)
      : createRunState(config);
    const allResults = runState.results;
    const resultKeys = new Set(allResults.map(resultKey));
    const failuresByCheck = new Map();
    const coverageRows = runState.coverageRows;
    const attemptCounts = new DurableAttemptMap(runState.attemptCounts, () => {
      saveRunState(config.resumeStatePath, runState);
    });
    runState.attemptCounts = attemptCounts;
    const deadlineAt = Date.parse(runState.startedAt) + config.jobBudgetMs;
    saveCheckpoint(config, allResults, coverageRows, runState);

    let browser;
    try {
      if (!deadlineReached(deadlineAt) && hasRunnableChecks(coverageRows, attemptCounts)) {
        browser = await chromium.launch({ headless: config.headless });
        firstPass:
        for (const pickupDate of config.pickupDateOptions) {
          for (const durationDays of config.durationDays) {
            if (deadlineReached(deadlineAt)) {
              break firstPass;
            }
            const locations = runnableLocations(coverageRows, pickupDate, durationDays, attemptCounts);
            if (!locations.length) {
              continue;
            }
            const scenarioConfig = {
              ...config,
              locations,
              pickupDate,
              dropoffDate: addDaysToIsoDate(pickupDate, durationDays),
              currentDurationDays: durationDays
            };
            console.log(`Scenario: ${scenarioConfig.pickupDate} -> ${scenarioConfig.dropoffDate} (${durationDays} days)`);
            const scraper = new VipCarsScraper(scenarioConfig);
            const { results, failures, checks } = await scraper.run((results, checks) => {
              appendUniqueResults(allResults, resultKeys, results);
              applyScenarioChecks(coverageRows, pickupDate, durationDays, checks);
              saveCheckpoint(config, allResults, coverageRows, runState);
            }, runOptions(browser, attemptCounts, deadlineAt));
            checkpointOutcome({
              config,
              allResults,
              resultKeys,
              failuresByCheck,
              coverageRows,
              runState,
              pickupDate,
              durationDays,
              results,
              failures,
              checks
            });
            console.log("");
          }
        }

        for (let pass = 1; pass <= RECOVERY_PASSES && !deadlineReached(deadlineAt); pass += 1) {
          const failedChecks = [...failuresByCheck.values()].filter((failure) =>
            failure.retryable === true && (attemptCounts.get(failure.key) || 0) < MAX_ATTEMPTS_PER_CHECK
          );
          if (!failedChecks.length) {
            break;
          }
          console.log(`Recovery pass ${pass}/${RECOVERY_PASSES}: retrying ${failedChecks.length} incomplete check(s).`);

          for (const failedCheck of failedChecks) {
            if (deadlineReached(deadlineAt)) {
              break;
            }
            const { pickupDate, durationDays, location } = failedCheck;
            const scenarioConfig = {
              ...config,
              locations: [location],
              pickupDate,
              dropoffDate: addDaysToIsoDate(pickupDate, durationDays),
              currentDurationDays: durationDays
            };
            console.log(`Recovery: ${pickupDate}, ${durationDays} days, ${location}`);
            const scraper = new VipCarsScraper(scenarioConfig);
            const { results, failures, checks } = await scraper.run((recoveryResults, recoveryChecks) => {
              appendUniqueResults(allResults, resultKeys, recoveryResults);
              applyScenarioChecks(coverageRows, pickupDate, durationDays, recoveryChecks);
              saveCheckpoint(config, allResults, coverageRows, runState);
            }, runOptions(browser, attemptCounts, deadlineAt));
            checkpointOutcome({
              config,
              allResults,
              resultKeys,
              failuresByCheck,
              coverageRows,
              runState,
              pickupDate,
              durationDays,
              results,
              failures,
              checks
            });
          }
          console.log("");
        }
      }

      if (deadlineReached(deadlineAt)) {
        markPendingAsDeadlineIncomplete(coverageRows);
      }
      saveCheckpoint(config, allResults, coverageRows, runState);

      const finalFailures = failuresFromCoverage(coverageRows);
      printSummary(allResults, finalFailures);
      console.log(`CSV saved to: ${config.outputCsv}`);
      console.log(`Coverage saved to: ${config.outputCoverage}`);

      if (finalFailures.length) {
        process.exitCode = 1;
      }
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function runOptions(browser, attemptCounts, deadlineAt) {
  return {
    browser,
    attemptCounts,
    maxAttemptsPerCheck: MAX_ATTEMPTS_PER_CHECK,
    attemptsPerPass: 1,
    deadlineAt
  };
}

function checkpointOutcome({ config, allResults, resultKeys, failuresByCheck, coverageRows, runState,
  pickupDate, durationDays, results, failures, checks }) {
  appendUniqueResults(allResults, resultKeys, results);
  applyScenarioChecks(coverageRows, pickupDate, durationDays, checks);
  updateFailures(failuresByCheck, pickupDate, durationDays, failures, checks);
  saveCheckpoint(config, allResults, coverageRows, runState);
}

function updateFailures(failuresByCheck, pickupDate, durationDays, failures, checks) {
  for (const check of checks) {
    if (check.status === "complete") {
      failuresByCheck.delete(checkKey(pickupDate, durationDays, check.location));
    }
  }
  for (const failure of failures) {
    const key = checkKey(pickupDate, durationDays, failure.location);
    failuresByCheck.set(key, { ...failure, key, pickupDate, durationDays });
  }
}

function checkKey(pickupDate, durationDays, location) {
  return [pickupDate, addDaysToIsoDate(pickupDate, durationDays), durationDays, location].join("|");
}

function appendUniqueResults(target, seen, rows) {
  for (const row of rows) {
    const key = resultKey(row);
    if (!seen.has(key)) {
      seen.add(key);
      target.push(row);
    }
  }
}

function resultKey(row) {
  return [
    row.location,
    row.duration_days,
    row.pickup_date,
    row.dropoff_date,
    row.provider,
    row.provider_rating,
    row.total_price,
    row.price_per_day,
    row.pay_now_amount,
    row.pay_now_currency,
    row.currency,
    row.source
  ].map((value) => String(value ?? "")).join("|");
}

function saveCheckpoint(config, results, coverageRows, runState) {
  saveRunState(config.resumeStatePath, runState);
  writeTextFile(config.outputCsv, toCsv(results));
  writeTextFile(config.outputCoverage, toCoverageCsv(coverageRows));
}

function hasRunnableChecks(coverageRows, attemptCounts) {
  return coverageRows.some((row) => row.status !== "complete"
    && (attemptCounts.get(checkKey(row.pickup_date, row.duration_days, row.location)) || 0) < MAX_ATTEMPTS_PER_CHECK);
}

function runnableLocations(coverageRows, pickupDate, durationDays, attemptCounts) {
  return coverageRows.filter((row) => row.pickup_date === pickupDate
    && Number(row.duration_days) === Number(durationDays)
    && row.status !== "complete"
    && (attemptCounts.get(checkKey(pickupDate, durationDays, row.location)) || 0) < MAX_ATTEMPTS_PER_CHECK
  ).map((row) => row.location);
}

class DurableAttemptMap extends Map {
  constructor(entries, onChange) {
    super();
    this.onChange = null;
    for (const [key, value] of entries) {
      super.set(key, value);
    }
    this.onChange = onChange;
  }

  set(key, value) {
    super.set(key, value);
    if (this.onChange) {
      this.onChange();
    }
    return this;
  }
}

function deadlineReached(deadlineAt) {
  return Date.now() >= deadlineAt;
}

function markPendingAsDeadlineIncomplete(coverageRows) {
  for (const row of coverageRows) {
    if (row.status === "pending") {
      row.status = "incomplete";
      row.result_count = 0;
      row.error = DEADLINE_REASON;
    }
  }
}

function failuresFromCoverage(coverageRows) {
  return coverageRows.filter((row) => row.status !== "complete").map((row) => ({
    location: row.location,
    pickupDate: row.pickup_date,
    durationDays: Number(row.duration_days),
    error: row.error || "Check did not complete."
  }));
}

function printSummary(results, failures) {
  if (results.length) {
    console.log("Top offers:");
    console.table(results.slice(0, 30).map((row) => ({
      location: row.location,
      pickup_date: row.pickup_date,
      duration_days: row.duration_days,
      provider: row.provider,
      total_price: `${Number(row.total_price).toFixed(2)} ${row.currency}`,
      price_per_day: `${Number(row.price_per_day).toFixed(2)} ${row.currency}`
    })));
  } else {
    console.log("No location returned a valid offer.");
  }

  if (failures.length) {
    console.log("");
    console.log("Failed locations:");
    for (const failure of failures) {
      console.log(`- ${failure.location}: ${failure.error}`);
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };

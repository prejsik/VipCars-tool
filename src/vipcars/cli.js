#!/usr/bin/env node

const { loadConfig, printHelp } = require("./config");
const { applyScenarioChecks, createCoveragePlan, toCoverageCsv } = require("./coverage");
const { addDaysToIsoDate, toCsv, writeTextFile } = require("./utils");

async function main() {
  try {
    const config = loadConfig(process.argv.slice(2));
    if (config.help) {
      printHelp();
      return;
    }

    console.log("VipCars scraper started");
    console.log(`Locations: ${config.locations.join(", ")}`);
    console.log(`Pickup options: ${config.pickupDateOptions.join(", ")} ${config.pickupTime}`);
    console.log(`Durations (days): ${config.durationDays.join(", ")}`);
    if (config.pickupChunkTotal > 1) {
      console.log(`Pickup chunk: ${config.pickupChunkIndex}/${config.pickupChunkTotal}`);
    }
    console.log("");

    const { VipCarsScraper } = require("./scraper");
    const allResults = [];
    const allFailures = [];
    const coverageRows = createCoveragePlan(config);
    writeTextFile(config.outputCsv, toCsv(allResults));
    writeTextFile(config.outputCoverage, toCoverageCsv(coverageRows));

    for (const pickupDate of config.pickupDateOptions) {
      for (const durationDays of config.durationDays) {
        const scenarioConfig = {
          ...config,
          pickupDate,
          dropoffDate: addDaysToIsoDate(pickupDate, durationDays),
          currentDurationDays: durationDays
        };
        console.log(`Scenario: ${scenarioConfig.pickupDate} -> ${scenarioConfig.dropoffDate} (${durationDays} days)`);
        const scraper = new VipCarsScraper(scenarioConfig);
        const { results, failures, checks } = await scraper.run();
        allResults.push(...results);
        allFailures.push(...failures.map((failure) => ({ ...failure, pickupDate, durationDays })));
        applyScenarioChecks(coverageRows, pickupDate, durationDays, checks);
        writeTextFile(config.outputCsv, toCsv(allResults));
        writeTextFile(config.outputCoverage, toCoverageCsv(coverageRows));
        console.log("");
      }
    }

    printSummary(allResults, allFailures);
    writeTextFile(config.outputCsv, toCsv(allResults));
    console.log(`CSV saved to: ${config.outputCsv}`);
    console.log(`Coverage saved to: ${config.outputCoverage}`);

    if (allFailures.length) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
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

main();

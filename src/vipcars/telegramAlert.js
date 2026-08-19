#!/usr/bin/env node
const fs = require("node:fs");

const { parseCsv } = require("./reportHtml");

function parseAttemptedPickupDates(logContent) {
  const dates = new Set();
  const scenarioPattern = /^Scenario:\s*(\d{4}-\d{2}-\d{2})\s*->/gm;
  let match = scenarioPattern.exec(String(logContent || ""));

  while (match) {
    dates.add(match[1]);
    match = scenarioPattern.exec(String(logContent || ""));
  }

  return [...dates].sort();
}

function isMmCarsProvider(provider) {
  return String(provider || "").trim().toLowerCase().includes("mm cars rental");
}

function findStartDatesWithoutMm(rows, attemptedPickupDates) {
  const mmPickupDates = new Set(
    rows
      .filter((row) => isMmCarsProvider(row.provider))
      .map((row) => row.pickup_date)
      .filter(Boolean)
  );
  const sourceDates = attemptedPickupDates.length
    ? attemptedPickupDates
    : rows.map((row) => row.pickup_date).filter(Boolean);

  return [...new Set(sourceDates)]
    .filter((pickupDate) => !mmPickupDates.has(pickupDate))
    .sort();
}

function buildMissingMmStartDateAlert(rows, attemptedPickupDates) {
  const missingDates = findStartDatesWithoutMm(rows, attemptedPickupDates);
  if (!missingDates.length) {
    return "";
  }

  return [
    "ALERT MM CARS RENTAL",
    "MM Cars Rental nie jest widoczny nigdzie dla start date:",
    ...missingDates.map((pickupDate) => `- ${pickupDate}`)
  ].join("\n");
}

function buildAlertFromFiles(csvPath, logPath) {
  const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
  const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  return buildMissingMmStartDateAlert(rows, parseAttemptedPickupDates(logContent));
}

if (require.main === module) {
  const csvPath = process.argv[2] || "output/vipcars-results.csv";
  const logPath = process.argv[3] || "output/vipcars-run-log.txt";
  const alert = buildAlertFromFiles(csvPath, logPath);
  if (alert) {
    process.stdout.write(`${alert}\n`);
  }
}

module.exports = {
  buildAlertFromFiles,
  buildMissingMmStartDateAlert,
  findStartDatesWithoutMm,
  parseAttemptedPickupDates
};

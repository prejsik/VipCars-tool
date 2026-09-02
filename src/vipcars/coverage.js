#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const { findCsvFiles } = require("./mergeCsv");
const { parseCsv } = require("./reportHtml");
const { addDaysToIsoDate, writeTextFile } = require("./utils");

const COVERAGE_HEADERS = [
  "location",
  "duration_days",
  "pickup_date",
  "dropoff_date",
  "status",
  "result_count",
  "error"
];

function createCoveragePlan(config) {
  return config.pickupDateOptions.flatMap((pickupDate) => config.durationDays.flatMap((durationDays) =>
    config.locations.map((location) => ({
      location,
      duration_days: durationDays,
      pickup_date: pickupDate,
      dropoff_date: addDaysToIsoDate(pickupDate, durationDays),
      status: "pending",
      result_count: 0,
      error: ""
    }))
  ));
}

function applyScenarioChecks(coverageRows, pickupDate, durationDays, checks) {
  const checksByLocation = new Map(checks.map((check) => [check.location, check]));
  for (const row of coverageRows) {
    if (row.pickup_date !== pickupDate || Number(row.duration_days) !== Number(durationDays)) {
      continue;
    }
    const check = checksByLocation.get(row.location);
    if (!check) {
      continue;
    }
    row.status = check.status;
    row.result_count = Number(check.resultCount || 0);
    row.error = check.error || "";
  }
  return coverageRows;
}

function toCoverageCsv(rows) {
  const lines = [COVERAGE_HEADERS.join(",")];
  for (const row of rows) {
    lines.push(COVERAGE_HEADERS.map((header) => escapeCsv(row[header])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function mergeCoverageFiles(inputPath, outputPath) {
  const files = findCsvFiles(inputPath).filter((filePath) => /vipcars-coverage/i.test(path.basename(filePath)));
  const rows = files.flatMap((filePath) => parseCsv(fs.readFileSync(filePath, "utf8")));
  rows.sort((left, right) => coverageKey(left).localeCompare(coverageKey(right)));
  writeTextFile(outputPath, toCoverageCsv(rows));
  return { files, rowCount: rows.length, outputPath: path.resolve(outputPath) };
}

function coverageKey(row) {
  return [row.pickup_date, String(row.duration_days).padStart(3, "0"), row.location].join("|");
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

if (require.main === module) {
  const inputPath = process.argv[2] || "chunk-artifacts";
  const outputPath = process.argv[3] || path.join("output", "vipcars-coverage.csv");
  const summary = mergeCoverageFiles(inputPath, outputPath);
  console.log(`Merged ${summary.files.length} VipCars coverage file(s), ${summary.rowCount} row(s).`);
}

module.exports = {
  applyScenarioChecks,
  createCoveragePlan,
  mergeCoverageFiles,
  toCoverageCsv
};

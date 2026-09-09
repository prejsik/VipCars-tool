#!/usr/bin/env node
const fs = require("node:fs");

const { parseCsv } = require("./reportHtml");

function isMmCarsProvider(provider) {
  return String(provider || "").trim().toLowerCase().includes("mm cars rental");
}

function buildRunStatus(coverageRows, scrapeResult = "success") {
  const complete = coverageRows.filter((row) => row.status === "complete").length;
  const errors = coverageRows.filter((row) => row.status === "incomplete");
  const pending = coverageRows.length - complete - errors.length;
  const timeouts = errors.filter((row) => /timeout/i.test(row.error || "")).length;
  if (!coverageRows.length) {
    return "czesciowy; brak danych kontroli";
  }
  const status = errors.length || pending ? "czesciowy"
    : scrapeResult === "success" ? "gotowy" : "wymaga sprawdzenia";
  return `${status}; kompletne kontrole: ${complete}/${coverageRows.length}; `
    + `bledy: ${errors.length} (timeout: ${timeouts}); niedokonczone: ${pending}; GitHub: ${scrapeResult}`;
}

function classifyStartDatesWithoutMm(rows, coverageRows) {
  const mmPickupDates = new Set(
    rows
      .filter((row) => isMmCarsProvider(row.provider))
      .map((row) => row.pickup_date)
      .filter(Boolean)
  );
  const coverageByDate = new Map();
  for (const row of coverageRows) {
    if (!row.pickup_date) {
      continue;
    }
    if (!coverageByDate.has(row.pickup_date)) {
      coverageByDate.set(row.pickup_date, []);
    }
    coverageByDate.get(row.pickup_date).push(row);
  }
  if (!coverageByDate.size) {
    for (const row of rows) {
      if (row.pickup_date && !coverageByDate.has(row.pickup_date)) {
        coverageByDate.set(row.pickup_date, []);
      }
    }
  }

  const confirmed = [];
  const incomplete = [];
  for (const [pickupDate, checks] of [...coverageByDate.entries()].sort()) {
    if (mmPickupDates.has(pickupDate)) {
      continue;
    }
    if (checks.length && checks.every((check) => check.status === "complete")) {
      confirmed.push(pickupDate);
    } else {
      incomplete.push(pickupDate);
    }
  }
  return { confirmed, incomplete };
}

function buildMissingMmStartDateAlert(rows, coverageRows) {
  const { confirmed, incomplete } = classifyStartDatesWithoutMm(rows, coverageRows);
  if (!confirmed.length && !incomplete.length) {
    return "";
  }

  const sections = ["ALERT MM CARS RENTAL"];
  if (confirmed.length) {
    sections.push(["Brak MM - pełne dane:", ...confirmed.map((pickupDate) => `- ${pickupDate}`)].join("\n"));
  }
  if (incomplete.length) {
    sections.push(["Nie można potwierdzić - niepełne dane:", ...incomplete.map((pickupDate) => `- ${pickupDate}`)].join("\n"));
  }
  return `${sections[0]}\n${sections.slice(1).join("\n\n")}`;
}

function buildAlertFromFiles(csvPath, coveragePath) {
  const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
  const coverageRows = fs.existsSync(coveragePath) ? parseCsv(fs.readFileSync(coveragePath, "utf8")) : [];
  return buildMissingMmStartDateAlert(rows, coverageRows);
}

if (require.main === module) {
  if (process.argv[2] === "--status") {
    const coveragePath = process.argv[3];
    const coverage = fs.existsSync(coveragePath) ? parseCsv(fs.readFileSync(coveragePath, "utf8")) : [];
    process.stdout.write(`${buildRunStatus(coverage, process.argv[4])}\n`);
  } else {
    const csvPath = process.argv[2] || "output/vipcars-results.csv";
    const coveragePath = process.argv[3] || "output/vipcars-coverage.csv";
    const alert = buildAlertFromFiles(csvPath, coveragePath);
    if (alert) {
      process.stdout.write(`${alert}\n`);
    }
  }
}

module.exports = {
  buildRunStatus,
  buildAlertFromFiles,
  buildMissingMmStartDateAlert,
  classifyStartDatesWithoutMm
};

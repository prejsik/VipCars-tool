#!/usr/bin/env node
const fs = require("node:fs");

const { parseCsv } = require("./reportHtml");

function isMmCarsProvider(provider) {
  return String(provider || "").trim().toLowerCase().includes("mm cars rental");
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
  const csvPath = process.argv[2] || "output/vipcars-results.csv";
  const coveragePath = process.argv[3] || "output/vipcars-coverage.csv";
  const alert = buildAlertFromFiles(csvPath, coveragePath);
  if (alert) {
    process.stdout.write(`${alert}\n`);
  }
}

module.exports = {
  buildAlertFromFiles,
  buildMissingMmStartDateAlert,
  classifyStartDatesWithoutMm
};

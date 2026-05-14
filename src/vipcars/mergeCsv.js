#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const { parseCsv } = require("./reportHtml");
const { toCsv, writeTextFile } = require("./utils");

function findCsvFiles(targetPath) {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    return [];
  }
  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    return resolved.toLowerCase().endsWith(".csv") ? [resolved] : [];
  }

  const files = [];
  for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
    const entryPath = path.join(resolved, entry.name);
    if (entry.isDirectory()) {
      files.push(...findCsvFiles(entryPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".csv")) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function sortRows(rows) {
  return [...rows].sort((left, right) => {
    const keys = [
      ["pickup_date", "string"],
      ["duration_days", "number"],
      ["location", "string"],
      ["total_price", "number"],
      ["provider", "string"]
    ];
    for (const [key, type] of keys) {
      const leftValue = type === "number" ? Number(left[key] || 0) : String(left[key] || "");
      const rightValue = type === "number" ? Number(right[key] || 0) : String(right[key] || "");
      if (leftValue < rightValue) {
        return -1;
      }
      if (leftValue > rightValue) {
        return 1;
      }
    }
    return 0;
  });
}

function mergeCsvFiles(inputPath, outputPath) {
  const files = findCsvFiles(inputPath).filter((filePath) => /vipcars-results/i.test(path.basename(filePath)));
  if (!files.length) {
    throw new Error(`No VipCars result CSV files found in: ${inputPath}`);
  }

  const rows = files.flatMap((filePath) => parseCsv(fs.readFileSync(filePath, "utf8")));
  writeTextFile(outputPath, toCsv(sortRows(rows)));
  return { files, rowCount: rows.length, outputPath: path.resolve(outputPath) };
}

if (require.main === module) {
  const inputPath = process.argv[2] || "chunk-artifacts";
  const outputPath = process.argv[3] || path.join("output", "vipcars-results.csv");
  const summary = mergeCsvFiles(inputPath, outputPath);
  console.log(`Merged ${summary.files.length} VipCars CSV file(s), ${summary.rowCount} row(s).`);
  console.log(`CSV saved to: ${summary.outputPath}`);
}

module.exports = { findCsvFiles, mergeCsvFiles };

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildRunStatus, buildWorkbookSection, buildWorkbookSectionFromFiles,
  importReadyFromFile } = require("../src/vipcars/telegramAlert");

const status = buildRunStatus([
  { status: "complete" },
  { status: "incomplete", error: "Search attempt timeout exceeded (90000ms maximum)." },
  { status: "incomplete", error: "VipCars search outcome timed out before results appeared." }
], "failure");
assert.match(status, /timeout: 2/);
assert.match(status, /1\/3/);
assert.doesNotMatch(status, /^gotowy/);

const ready = {
  baselineStatus: "confirmed_imported", workbookStatus: "success",
  reportExists: true, importExists: true, pageUrl: "https://example.test/VipCars-tool/",
  summary: { verified_duration_count: 4, blocked_band_count: 0, change_count: 0 }
};
const unchangedRates = buildWorkbookSection(ready);
assert.match(unchangedRates, /https:\/\/example\.test\/VipCars-tool\/vipcars-rates-import-ready\.xlsx/);
assert.match(unchangedRates, /zweryfikowane okresy: 4/i);
assert.match(unchangedRates, /zablokowane pasma cenowe: 0/i);
assert.match(unchangedRates, /zmiany cen: 0/i);
assert.doesNotMatch(unchangedRates, /brak zweryfikowanych pasm/i);
assert.match(buildWorkbookSection({ ...ready, pageUrl: "https://example.test/VipCars-tool" }),
  /VipCars-tool\/vipcars-recommendations\.xlsx/);
assert.match(buildWorkbookSection({ ...ready, baselineStatus: "verified_live" }), /Import XLSX/);

const noValidatedBands = buildWorkbookSection({ ...ready,
  summary: { verified_duration_count: 0, blocked_band_count: 945, change_count: 0 }
});
assert.match(noValidatedBands, /zweryfikowane okresy: 0/i);
assert.match(noValidatedBands, /zablokowane pasma cenowe: 945/i);
assert.match(noValidatedBands, /zmiany cen: 0/i);
assert.match(noValidatedBands, /brak zweryfikowanych pasm cenowych/i);
assert.match(noValidatedBands, /bazę.*nie stanowi nowej rekomendacji/is);
assert.match(noValidatedBands, /vipcars-recommendations\.xlsx/);
assert.doesNotMatch(noValidatedBands, /Import XLSX:\s*https:\/\//);

const partial = buildWorkbookSection({ ...ready,
  summary: { verified_duration_count: 4, blocked_band_count: 3, change_count: 1 }
});
assert.match(partial, /czesciowy/i);
assert.match(partial, /zablokowane pasma cenowe: 3/i);
assert.match(partial, /baza.*zablokowan/is);
assert.match(partial, /https:\/\/example\.test\/VipCars-tool\/vipcars-rates-import-ready\.xlsx/);

const noSummary = buildWorkbookSection({ ...ready, summary: undefined });
assert.match(noSummary, /vipcars-rate-update-summary\.json/);
assert.doesNotMatch(noSummary, /Import XLSX:\s*https:\/\//);
for (const workbookStatus of ["success", "failure"]) {
  const blocked = buildWorkbookSection({ ...ready, baselineStatus: "user_provided", workbookStatus });
  assert.match(blocked, /Wheels/);
  assert.match(blocked, /potwierdzenia/);
  assert.doesNotMatch(blocked, /https:\/\//);
}
for (const overrides of [{ reportExists: false }, { importExists: false }, { workbookStatus: "failure" }, { pageUrl: "" }]) {
  const failed = buildWorkbookSection({ ...ready, ...overrides });
  assert.doesNotMatch(failed, /https:\/\//);
  assert.match(failed, /nie powsta|brak/i);
}
assert.doesNotMatch(buildWorkbookSection({ ...ready, baselineStatus: undefined }), /Import XLSX/);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "vipcars-telegram-test-"));
try {
  const manifest = path.join(temp, "baseline.json");
  const summaryPath = path.join(temp, "vipcars-rate-update-summary.json");
  fs.writeFileSync(path.join(temp, "vipcars-recommendations.xlsx"), "fixture");
  fs.writeFileSync(path.join(temp, "vipcars-rates-import-ready.xlsx"), "fixture");
  for (const baselineStatus of ["user_provided", "confirmed_imported"]) {
    fs.writeFileSync(manifest, JSON.stringify({ status: baselineStatus }));
    fs.writeFileSync(summaryPath, JSON.stringify(ready.summary));
    assert.equal(importReadyFromFile(summaryPath), true, "validated unchanged prices remain importable");
    assert.equal(spawnSync(process.execPath, ["src/vipcars/telegramAlert.js", "--import-ready", summaryPath]).status, 0);
    const result = spawnSync(process.execPath, ["src/vipcars/telegramAlert.js", "--workbooks", manifest,
      "success", ready.pageUrl, temp], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), buildWorkbookSection({ ...ready, baselineStatus }));
  }

  fs.writeFileSync(manifest, JSON.stringify({ status: "confirmed_imported" }));
  fs.writeFileSync(summaryPath, JSON.stringify({
    verified_duration_count: 0, blocked_band_count: 945, change_count: 0
  }));
  const noValidatedFromFiles = buildWorkbookSectionFromFiles(manifest, "success", ready.pageUrl, temp);
  assert.equal(importReadyFromFile(summaryPath), false);
  assert.equal(spawnSync(process.execPath, ["src/vipcars/telegramAlert.js", "--import-ready", summaryPath]).status, 1);
  assert.match(noValidatedFromFiles, /zweryfikowane okresy: 0/i);
  assert.match(noValidatedFromFiles, /zablokowane pasma cenowe: 945/i);
  assert.match(noValidatedFromFiles, /brak zweryfikowanych pasm cenowych/i);
  assert.doesNotMatch(noValidatedFromFiles, /Import XLSX:\s*https:\/\//);

  fs.rmSync(summaryPath);
  assert.equal(importReadyFromFile(summaryPath), false);
  const missingSummary = buildWorkbookSectionFromFiles(manifest, "success", ready.pageUrl, temp);
  assert.match(missingSummary, /vipcars-rate-update-summary\.json/);
  assert.doesNotMatch(missingSummary, /Import XLSX:\s*https:\/\//);

  fs.writeFileSync(summaryPath, "{");
  assert.equal(importReadyFromFile(summaryPath), false);
  const malformedSummary = buildWorkbookSectionFromFiles(manifest, "success", ready.pageUrl, temp);
  assert.match(malformedSummary, /vipcars-rate-update-summary\.json/);
  assert.doesNotMatch(malformedSummary, /Import XLSX:\s*https:\/\//);

  for (const invalidSummary of [
    { verified_duration_count: 4, blocked_band_count: 0 },
    { verified_duration_count: -1, blocked_band_count: 0, change_count: 0 },
    { verified_duration_count: 1.5, blocked_band_count: 0, change_count: 0 }
  ]) {
    fs.writeFileSync(summaryPath, JSON.stringify(invalidSummary));
    assert.equal(importReadyFromFile(summaryPath), false);
    const output = buildWorkbookSectionFromFiles(manifest, "success", ready.pageUrl, temp);
    assert.match(output, /vipcars-rate-update-summary\.json/);
    assert.doesNotMatch(output, /Import XLSX:\s*https:\/\//);
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

const workflow = fs.readFileSync(".github/workflows/vipcars-daily.yml", "utf8");
assert.match(workflow, /telegramAlert\.js --workbooks/);
assert.match(workflow, /! node src\/vipcars\/telegramAlert\.js --import-ready output\/vipcars-rate-update-summary\.json; then\s+continue/);
assert.doesNotMatch(workflow, /chunk-artifacts\/\*\*/);
assert.match(workflow, /name: vipcars-results-chunk-/);
console.log("PASS Telegram reports all timeout types and the actual workbook availability; diagnostics are not duplicated");

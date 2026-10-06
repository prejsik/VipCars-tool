const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildRunStatus, buildWorkbookSection, buildWorkbookSectionFromFiles,
  importReadyFromFile, buildTelegramMessage } = require("../src/vipcars/telegramAlert");

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
  fs.mkdirSync(path.join(temp, "input"));
  fs.writeFileSync(path.join(temp, "input", "vipcars-baseline-manifest.json"), JSON.stringify({ status: "confirmed_imported" }));
  fs.writeFileSync(summaryPath, JSON.stringify(ready.summary));
  fs.writeFileSync(path.join(temp, "vipcars-coverage.csv"),
    "location,pickup_date,duration_days,status,result_count\nWarsaw,2026-10-06,2,complete,20\n");
  const cliMessage = spawnSync(process.execPath, [path.resolve("src/vipcars/telegramAlert.js"), "--message"], {
    cwd: temp, encoding: "utf8", env: { ...process.env, OUTPUT_DIR: temp, PAGE_URL: ready.pageUrl,
      RATE_WORKBOOK_STATUS: "success", SCRAPE_RESULT: "failure", LOCATIONS: "Warsaw,Bydgoszcz",
      DURATIONS: "2", PICKUP_DATES: "2026-10-06,2026-10-07" }
  });
  assert.equal(cliMessage.status, 0, cliMessage.stderr);
  assert.match(cliMessage.stdout, /1\/4 sprawdzeń \(25%\)/);
  assert.match(cliMessage.stdout, /niedokonczone: 3/);
  assert.doesNotMatch(cliMessage.stdout, /100%|Brak MM - pełne dane/);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

assert.equal(typeof buildTelegramMessage, "function", "VipCars needs the DiscoverCars-style message formatter");
const messageReady = { ...ready, summary: { verified_duration_count: 2, blocked_band_count: 0, change_count: 3,
  change_statistics: { increase_count: 2, decrease_count: 1,
    average_increase_net_eur_day: 0.75, average_decrease_net_eur_day: 0.5 } } };
const messageOptions = {
  coverageRows: [
    { pickup_date: "2026-10-06", duration_days: "2", status: "complete", result_count: "20" },
    { pickup_date: "2026-10-07", duration_days: "3", status: "complete", result_count: "21" }
  ],
  rows: [{ pickup_date: "2026-10-06", provider: "MM Cars Rental" },
    { pickup_date: "2026-10-07", provider: "MM Cars Rental" }],
  workbooks: messageReady, env: { SCRAPE_RESULT: "success", RUN_URL: "https://example.test/actions/123" }
};
const message = buildTelegramMessage(messageOptions);
assert.match(message, /^VipCars\n\nDaty startu: 06–07\.10\.2026\nCzas trwania: 2–3 dni/);
assert.match(message, /2\/2 sprawdzeń \(100%\)/);
assert.match(message, /Zmiany w Excelu: podwyżki 2, obniżki 1/);
assert.match(message, /0,75 EUR netto\/dobę/);
assert.match(message, /0,50 EUR netto\/dobę/);
assert.ok(message.indexOf("Import:") < message.indexOf("Rekomendacje:"));
assert.ok(message.indexOf("Rekomendacje:") < message.indexOf("Raport cen:"));
assert.match(message, /Import: https:\/\/example\.test\/VipCars-tool\/vipcars-rates-import-ready\.xlsx/);
assert.doesNotMatch(message, /chunki:|Artifact backup|rentcars-tool|DiscoverCars/);

const partialMessage = buildTelegramMessage({ ...messageOptions,
  coverageRows: [...messageOptions.coverageRows,
    { pickup_date: "2026-10-08", duration_days: "2", status: "incomplete", error: "Search timed out" }],
  workbooks: { ...messageReady, summary: { ...messageReady.summary, blocked_band_count: 1 } }
});
assert.match(partialMessage, /NIEPEŁNY/);
assert.match(partialMessage, /2\/3 sprawdzeń \(66,67%\)/);
assert.match(partialMessage, /timeout: 1/);
assert.match(partialMessage, /Nie można potwierdzić - niepełne dane:[\s\S]*2026-10-08/);
assert.match(partialMessage, /baza.*zablokowan/is);
assert.match(partialMessage, /GitHub Actions: https:\/\/example\.test\/actions\/123/);
assert.doesNotMatch(partialMessage, /100%/);
const missingChunkMessage = buildTelegramMessage({ ...messageOptions,
  coverageRows: [{ location: "Warsaw", pickup_date: "2026-10-06", duration_days: "2",
    status: "complete", result_count: "20" }], rows: [],
  env: { ...messageOptions.env, LOCATIONS: "Warsaw,Bydgoszcz", DURATIONS: "2,3",
    PICKUP_DATES: "2026-10-06,2026-10-07", SCRAPE_RESULT: "failure" }
});
assert.match(missingChunkMessage, /1\/8 sprawdzeń \(12,5%\)/);
assert.match(missingChunkMessage, /niedokonczone: 7/);
assert.match(missingChunkMessage, /Daty startu: 06–07\.10\.2026/);
assert.match(missingChunkMessage, /Nie można potwierdzić - niepełne dane:[\s\S]*2026-10-06[\s\S]*2026-10-07/);
assert.doesNotMatch(missingChunkMessage, /100%|Brak MM - pełne dane/);
const emptyPriceMessage = buildTelegramMessage({ ...messageOptions,
  coverageRows: [{ pickup_date: "2026-10-06", duration_days: "2", status: "complete", result_count: "0" }], rows: [],
  workbooks: { ...messageReady, summary: { verified_duration_count: 0, blocked_band_count: 3, change_count: 0 } }
});
assert.match(emptyPriceMessage, /0\/1 sprawdzeń \(0%\)/);
assert.match(emptyPriceMessage, /Brak MM - pełne dane/);
assert.doesNotMatch(emptyPriceMessage, /Import:\s*https:\/\//);
for (const overrides of [{ baselineStatus: "user_provided" }, { summary: undefined }, { reportExists: false },
  { importExists: false }, { workbookStatus: "failure" }, { pageUrl: "" }, { summaryError: "invalid summary" }]) {
  assert.doesNotMatch(buildTelegramMessage({ ...messageOptions, workbooks: { ...messageReady, ...overrides } }),
    /Import:\s*https:\/\//, "The new message must preserve every workbook publication gate");
}
assert.match(buildTelegramMessage({ ...messageOptions, coverageRows: [] }), /Daty startu: brak danych/);
const legacyMessage = buildTelegramMessage({ ...messageOptions, workbooks: ready });
assert.match(legacyMessage, /Zmiany w Excelu: 0 zmian stawek/);
assert.doesNotMatch(legacyMessage, /Średnia/);

const workflow = fs.readFileSync(".github/workflows/vipcars-daily.yml", "utf8");
assert.match(workflow, /telegramAlert\.js --message/);
assert.match(workflow.split("- name: Notify Telegram")[1], /PICKUP_DATES: \$\{\{ needs\.prepare\.outputs\.pickup_dates \}\}/);
assert.match(workflow, /! node src\/vipcars\/telegramAlert\.js --import-ready output\/vipcars-rate-update-summary\.json; then\s+continue/);
assert.doesNotMatch(workflow, /chunk-artifacts\/\*\*/);
assert.match(workflow, /name: vipcars-results-chunk-/);
console.log("PASS Telegram reports all timeout types and the actual workbook availability; diagnostics are not duplicated");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildRunStatus, buildWorkbookSection } = require("../src/vipcars/telegramAlert");

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
  reportExists: true, importExists: true, pageUrl: "https://example.test/VipCars-tool/"
};
assert.match(buildWorkbookSection(ready), /https:\/\/example\.test\/VipCars-tool\/vipcars-rates-import-ready\.xlsx/);
assert.match(buildWorkbookSection({ ...ready, pageUrl: "https://example.test/VipCars-tool" }),
  /VipCars-tool\/vipcars-recommendations\.xlsx/);
assert.match(buildWorkbookSection({ ...ready, baselineStatus: "verified_live" }), /Import XLSX/);
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
  fs.writeFileSync(path.join(temp, "vipcars-recommendations.xlsx"), "fixture");
  fs.writeFileSync(path.join(temp, "vipcars-rates-import-ready.xlsx"), "fixture");
  for (const baselineStatus of ["user_provided", "confirmed_imported"]) {
    fs.writeFileSync(manifest, JSON.stringify({ status: baselineStatus }));
    const result = spawnSync(process.execPath, ["src/vipcars/telegramAlert.js", "--workbooks", manifest,
      "success", ready.pageUrl, temp], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), buildWorkbookSection({ ...ready, baselineStatus }));
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

const workflow = fs.readFileSync(".github/workflows/vipcars-daily.yml", "utf8");
assert.match(workflow, /telegramAlert\.js --workbooks/);
assert.doesNotMatch(workflow, /chunk-artifacts\/\*\*/);
assert.match(workflow, /name: vipcars-results-chunk-/);
console.log("PASS Telegram reports all timeout types and the actual workbook availability; diagnostics are not duplicated");

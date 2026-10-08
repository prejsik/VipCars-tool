const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const program = path.resolve("src/vipcars/runArtifacts.js");
const workflow = fs.readFileSync(path.resolve(".github/workflows/vipcars-daily.yml"), "utf8").replace(/\r\n/g, "\n");
assert.ok(workflow.includes('\n  SCHEDULE_PICKUP_ROLLING_DAYS: "30"\n'),
  "The daily scan must use 30 rolling pickup dates");
assert.ok(workflow.includes('      pickup_rolling_days:\n        description: "Number of consecutive pickup dates from today"\n        required: false\n        default: "30"\n'),
  "The manual rolling default must match the 30-day scheduled range");
assert.ok(workflow.includes("concurrency:\n  group: ${{ github.event_name == 'push' && 'vipcars-push-smoke' || 'vipcars-collection' }}\n  cancel-in-progress: false\n"),
  "A push smoke test must not replace the pending full report, or cancel an active collection");
const artifacts = [
  { id: 101, name: "vipcars-results-chunk-1-72-attempt-1", expired: false },
  { id: 102, name: "vipcars-results-chunk-2-72-attempt-1", expired: false },
  { id: 201, name: "vipcars-results-chunk-1-72-attempt-2", expired: false },
  { id: 301, name: "vipcars-results-chunk-1-72-attempt-3", expired: false },
  { id: 999, name: "vipcars-results-chunk-1-720-attempt-2", expired: false },
  { id: 998, name: "vipcars-results-72", expired: false }
];
function invoke(args, source = artifacts) {
  return spawnSync(process.execPath, [program, ...args], {
    input: source.map((item) => JSON.stringify(item)).join("\n"), encoding: "utf8"
  });
}
const resumed = invoke(["resume", "1", "72", "3"]);
assert.equal(resumed.status, 0, resumed.stderr);
assert.equal(resumed.stdout.trim(), "201");
assert.equal(invoke(["resume", "2", "72", "3"]).stdout.trim(), "102");
const missing = invoke(["resume", "3", "72", "3"]);
assert.notEqual(missing.status, 0, "A rerun must not reset attempts or cooldown when its checkpoint is missing");
assert.match(missing.stderr, /missing.*checkpoint/i);
const published = invoke(["ids", "72", "3"]);
assert.equal(published.status, 0, published.stderr);
assert.equal(published.stdout.trim(), "301,102", "Publication must not merge stale and resumed copies of a chunk");
const first = invoke(["resume", "1", "72", "1"], []);
assert.notEqual(first.status, 0, "Checkpoint restoration only applies to later attempts");
const duplicate = invoke(["ids", "72", "3"], [...artifacts,
  { id: 302, name: "vipcars-results-chunk-1-72-attempt-3", expired: false }]);
assert.notEqual(duplicate.status, 0, "Ambiguous chunk state must fail closed");
assert.match(duplicate.stderr, /duplicate|ambiguous/i);
const expired = invoke(["ids", "72", "3"], [
  artifacts[0], { ...artifacts[3], expired: true }
]);
assert.notEqual(expired.status, 0, "An expired newest checkpoint must not silently fall back to stale results");
assert.match(expired.stderr, /expired/i);
const legacy = invoke(["ids", "72", "2"], [
  { id: 81, name: "vipcars-results-chunk-1-72", expired: false }, artifacts[2]
]);
assert.equal(legacy.status, 0, legacy.stderr);
assert.equal(legacy.stdout.trim(), "201");
console.log("PASS workflow resume restores the latest prior chunk and publishes only one version per chunk");

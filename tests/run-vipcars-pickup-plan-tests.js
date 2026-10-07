const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { scrapeMatrix, scheduledPickupDates, runPickupDates } = require("../src/vipcars/pickupPlan");

const root = path.resolve(__dirname, "..");
const planner = path.join(root, "src/vipcars/pickupPlan.js");
const configArgs = ["--config", path.join(root, "vipcars.config.example.json")];

function runPlanner(args, timezone = "UTC", now) {
  const command = now ? ["-e", `
    const RealDate = Date;
    global.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [${JSON.stringify(now)}])); }
      static now() { return RealDate.parse(${JSON.stringify(now)}); }
    };
    require("node:module").runMain();
  `, planner] : [planner];
  return spawnSync(process.execPath, [...command, ...configArgs, ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, TZ: timezone }
  });
}

test("45 dates and seven locations preserve 4095 unique checks in 225 bounded price-band shards", () => {
  const dates = Array.from({ length: 45 }, (_, index) =>
    new Date(Date.UTC(2026, 8, 16 + index)).toISOString().slice(0, 10));
  const locations = ["Bydgoszcz", "Warsaw", "Krakow", "Gdansk", "Katowice", "Wroclaw", "Poznan"];
  const matrix = scrapeMatrix([...configArgs, "--pickup-dates", dates.join(","),
    "--locations", locations.join(","), "--durations-days", "2,3,4,5,6,7,8,9,10,11,12,13,14"]);
  assert.equal(matrix.include.length, 225);
  assert.deepEqual(matrix.include.slice(0, 5), [
    { chunk: 1, pickup_dates: "2026-09-16", durations: "2,3,4" },
    { chunk: 2, pickup_dates: "2026-09-16", durations: "5,6" },
    { chunk: 3, pickup_dates: "2026-09-16", durations: "7,8" },
    { chunk: 4, pickup_dates: "2026-09-16", durations: "9,10,11" },
    { chunk: 5, pickup_dates: "2026-09-16", durations: "12,13,14" }
  ]);
  const checks = new Set();
  for (const shard of matrix.include) {
    assert.ok(dates.includes(shard.pickup_dates));
    const durations = shard.durations.split(",").map(Number);
    assert.ok(durations.length * locations.length <= 21);
    assert.ok(durations.every((duration) => duration >= 2 && duration <= 14));
    assert.equal(new Set(durations.map((duration) => duration <= 6 ? 0 : duration <= 8 ? 1 : 2)).size, 1);
    for (const duration of durations) for (const location of locations) {
      const key = [shard.pickup_dates, duration, location].join("|");
      assert.equal(checks.has(key), false, `Duplicate check: ${key}`);
      checks.add(key);
    }
  }
  assert.equal(checks.size, 4095);
});

test("the 256-job matrix boundary remains enforced", () => {
  assert.equal(scrapeMatrix([...configArgs, "--pickup-rolling-days", "51"]).include.length, 255);
  assert.throws(() => scrapeMatrix([...configArgs, "--pickup-rolling-days", "52"]), /256.*matrix/i);
  assert.equal(scrapeMatrix([...configArgs, "--pickup-rolling-days", "256",
    "--durations-days", "2"]).include.length, 256);
  assert.throws(() => scrapeMatrix([...configArgs, "--pickup-rolling-days", "257",
    "--durations-days", "2"]), /256.*matrix/i);
});

test("more than 21 locations cannot silently exceed the actual-check limit", () => {
  const locations = Array.from({ length: 22 }, (_, index) => `Location ${index + 1}`).join(",");
  assert.throws(() => scrapeMatrix([...configArgs, "--pickup-dates", "2026-09-16",
    "--locations", locations, "--durations-days", "2"]), /21.*location|location.*21/i);
});

test("scheduled helper returns dates and requires a positive integer rolling-day count", () => {
  assert.equal(typeof scheduledPickupDates, "function");
  assert.deepEqual(scheduledPickupDates("2026-09-15T14:30:00Z", 3),
    ["2026-09-16", "2026-09-17", "2026-09-18"]);
  for (const dayCount of [undefined, 0, -1, 1.5, NaN, Infinity, "3"]) {
    assert.throws(() => scheduledPickupDates("2026-09-15T14:30:00Z", dayCount), /dayCount.*positive integer/i);
  }
});

const scheduledCases = [
  ["before cutoff", "2026-09-15T14:29:59Z", "2026-09-15,2026-09-16,2026-09-17\n"],
  ["at cutoff", "2026-09-15T14:30:00Z", "2026-09-16,2026-09-17,2026-09-18\n"],
  ["late evening", "2026-09-15T21:59:59Z", "2026-09-16,2026-09-17,2026-09-18\n"],
  ["Warsaw midnight", "2026-09-15T22:00:00Z", "2026-09-16,2026-09-17,2026-09-18\n"],
  ["delayed next morning", "2026-09-16T05:00:00Z", "2026-09-16,2026-09-17,2026-09-18\n"],
  ["delayed after pickup time", "2026-09-16T10:00:00Z", "2026-09-16,2026-09-17,2026-09-18\n"],
  ["month rollover", "2026-01-31T15:30:00Z", "2026-02-01,2026-02-02,2026-02-03\n"],
  ["year rollover", "2026-12-31T15:30:00Z", "2027-01-01,2027-01-02,2027-01-03\n"],
  ["leap day", "2028-02-28T15:30:00Z", "2028-02-29,2028-03-01,2028-03-02\n"],
  ["across spring DST", "2026-03-28T15:30:00Z", "2026-03-29,2026-03-30,2026-03-31\n"],
  ["before spring DST jump", "2026-03-29T00:30:00Z", "2026-03-29,2026-03-30,2026-03-31\n"],
  ["after spring DST jump", "2026-03-29T01:30:00Z", "2026-03-29,2026-03-30,2026-03-31\n"],
  ["spring before cutoff", "2026-03-29T14:29:59Z", "2026-03-29,2026-03-30,2026-03-31\n"],
  ["spring at cutoff", "2026-03-29T14:30:00Z", "2026-03-30,2026-03-31,2026-04-01\n"],
  ["across autumn DST", "2026-10-24T14:30:00Z", "2026-10-25,2026-10-26,2026-10-27\n"],
  ["first repeated autumn hour", "2026-10-25T00:30:00Z", "2026-10-25,2026-10-26,2026-10-27\n"],
  ["second repeated autumn hour", "2026-10-25T01:30:00Z", "2026-10-25,2026-10-26,2026-10-27\n"],
  ["autumn before cutoff", "2026-10-25T15:29:59Z", "2026-10-25,2026-10-26,2026-10-27\n"],
  ["autumn at cutoff", "2026-10-25T15:30:00Z", "2026-10-26,2026-10-27,2026-10-28\n"],
  ["explicit offset", "2026-09-15T16:30:00+02:00", "2026-09-16,2026-09-17,2026-09-18\n"],
  ["fractional seconds", "2026-09-15T14:30:00.123Z", "2026-09-16,2026-09-17,2026-09-18\n"]
];

for (const [label, timestamp, expected] of scheduledCases) {
  test(`scheduled dates use Warsaw calendar: ${label}`, () => {
    const result = runPlanner(["--dates", "--pickup-rolling-days", "3", "--scheduled-at", timestamp]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, expected);
  });
}

test("canonical created_at keeps reruns stable after midnight and on different hosts", () => {
  const args = ["--dates", "--pickup-rolling-days", "3", "--scheduled-at", "2026-09-15T14:30:00Z"];
  for (const [timezone, now] of [
    ["UTC", "2026-09-15T14:30:00Z"],
    ["America/Los_Angeles", "2026-09-16T01:00:00Z"],
    ["Asia/Tokyo", "2026-09-18T07:00:00Z"]
  ]) {
    const result = runPlanner(args, timezone, now);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "2026-09-16,2026-09-17,2026-09-18\n");
  }
});

test("scheduled mode rejects invalid or timezone-less timestamps without CSV output", () => {
  for (const timestamp of ["", "invalid", "2026-09-15", "2026-09-15T16:30:00",
    "2026-02-30T16:30:00Z", "2026-13-01T16:30:00Z", "2026-01-01T24:00:00Z",
    "2026-01-01T16:60:00Z", "2026-01-01T16:30:60Z", "2026-01-01T16:30:00+24:00"]) {
    const result = runPlanner(["--dates", "--pickup-rolling-days", "3", "--scheduled-at", timestamp]);
    assert.equal(result.status, 1, `Accepted timestamp: ${timestamp}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /scheduled-at.*ISO.*timezone/i);
  }
  const missing = runPlanner(["--dates", "--scheduled-at"]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
});

test("scheduled-at is explicit and only allowed in dates mode", () => {
  for (const mode of [[], ["--matrix"]]) {
    const result = runPlanner([...mode, "--scheduled-at", "2026-09-15T14:30:00Z"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /scheduled-at.*--dates/i);
  }
});

const runCreatedCases = [
  ["before pickup cutoff", "2026-09-15T07:59:59Z", "2026-09-15,2026-09-16,2026-09-17\n"],
  ["at pickup cutoff", "2026-09-15T08:00:00Z", "2026-09-16,2026-09-17,2026-09-18\n"],
  ["after pickup but before scheduled cutoff", "2026-09-16T10:00:00Z", "2026-09-17,2026-09-18,2026-09-19\n"],
  ["winter year rollover", "2026-12-31T09:00:00Z", "2027-01-01,2027-01-02,2027-01-03\n"],
  ["spring DST cutoff", "2026-03-29T08:00:00Z", "2026-03-30,2026-03-31,2026-04-01\n"],
  ["autumn DST cutoff", "2026-10-25T09:00:00Z", "2026-10-26,2026-10-27,2026-10-28\n"]
];
for (const [label, timestamp, expected] of runCreatedCases) {
  test(`normal reference dates retain pickup-time cutoff: ${label}`, () => {
    const result = runPlanner(["--dates", "--pickup-rolling-days", "3", "--run-created-at", timestamp]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, expected);
  });
}

test("normal weekday plans use the original Warsaw pickup cutoff across reruns", () => {
  const args = ["--dates", "--pickup-weekdays", "tuesday,thursday", "--run-created-at"];
  for (const [timestamp, expected] of [
    ["2026-09-15T07:59:59Z", "2026-09-15,2026-09-17\n"],
    ["2026-09-15T08:00:00Z", "2026-09-17,2026-09-22\n"]
  ]) {
    for (const [timezone, now] of [
      ["UTC", "2026-09-15T14:30:00Z"],
      ["America/Los_Angeles", "2026-09-16T01:00:00Z"],
      ["Asia/Tokyo", "2026-09-18T07:00:00Z"]
    ]) {
      const result = runPlanner([...args, timestamp], timezone, now);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, expected);
    }
  }
});

test("normal rolling reruns stay pinned to original created_at, not current date or host timezone", () => {
  const args = ["--dates", "--pickup-rolling-days", "3", "--run-created-at", "2026-09-15T08:00:00Z"];
  for (const [timezone, now] of [
    ["UTC", "2026-09-15T14:30:00Z"],
    ["America/Los_Angeles", "2026-09-16T01:00:00Z"],
    ["Asia/Tokyo", "2026-09-18T07:00:00Z"]
  ]) {
    const result = runPlanner(args, timezone, now);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "2026-09-16,2026-09-17,2026-09-18\n");
  }
});

test("normal reference preserves explicit dates and chunk selection", () => {
  const args = ["--dates", "--run-created-at", "2026-09-15T08:00:00Z",
    "--pickup-chunk-total", "2", "--pickup-chunk-index", "2"];
  const pinned = runPlanner([...args, "--pickup-dates", "2026-01-02,2026-01-01"]);
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.equal(pinned.stdout, "2026-01-02\n");
  const rolling = runPlanner([...args, "--pickup-rolling-days", "3"]);
  assert.equal(rolling.status, 0, rolling.stderr);
  assert.equal(rolling.stdout, "2026-09-17,2026-09-18\n");
});

test("normal reference respects a custom pickup cutoff and keeps a fixed date fixed", () => {
  const args = ["--location", "Warsaw", "--pickup-date", "2026-05-15", "--pickup-time", "09:15",
    "--dropoff-date", "2026-05-17", "--dropoff-time", "09:15"];
  assert.deepEqual(runPickupDates("2026-09-15T07:15:00Z", args), ["2026-05-15"]);
  assert.deepEqual(runPickupDates("2026-09-15T07:14:59Z", [...args, "--pickup-rolling-days", "2"]),
    ["2026-09-15", "2026-09-16"]);
  assert.deepEqual(runPickupDates("2026-09-15T07:15:00Z", [...args, "--pickup-rolling-days", "2"]),
    ["2026-09-16", "2026-09-17"]);
});

test("normal reference rejects invalid timestamps, incompatible modes and conflicting reference flags", () => {
  for (const timestamp of ["", "invalid", "2026-09-15T10:00:00", "2026-02-30T08:00:00Z"]) {
    const result = runPlanner(["--dates", "--run-created-at", timestamp]);
    assert.equal(result.status, 1, `Accepted timestamp: ${timestamp}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /run-created-at.*ISO.*timezone/i);
  }
  for (const args of [
    ["--run-created-at", "2026-09-15T08:00:00Z"],
    ["--matrix", "--run-created-at", "2026-09-15T08:00:00Z"],
    ["--dates", "--run-created-at", "2026-09-15T08:00:00Z", "--scheduled-at", "2026-09-15T14:30:00Z"]
  ]) {
    const result = runPlanner(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /run-created-at/i);
  }
});

test("manual pinned dates and normal rolling dates keep the existing behavior", () => {
  const pinned = runPlanner(["--dates", "--pickup-dates", "2026-01-02,2026-01-01"]);
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.equal(pinned.stdout, "2026-01-01,2026-01-02\n");
  const rolling = runPlanner(["--dates", "--pickup-rolling-days", "3"], "UTC", "2026-09-15T09:59:59Z");
  assert.equal(rolling.status, 0, rolling.stderr);
  assert.equal(rolling.stdout, "2026-09-15,2026-09-16,2026-09-17\n");
  const count = runPlanner(["--pickup-dates", "2026-01-01,2026-01-02"]);
  assert.equal(count.status, 0, count.stderr);
  assert.equal(count.stdout, "2\n");
});

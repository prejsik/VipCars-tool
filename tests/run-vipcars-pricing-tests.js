#!/usr/bin/env node

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { buildRecommendations } = require("../src/vipcars/pricingRecommendations");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vipcars-pricing-"));
const resultsPath = path.join(tempDir, "results.csv");
const coveragePath = path.join(tempDir, "coverage.csv");
const outputPath = path.join(tempDir, "recommendations.json");
const scriptPath = path.join(__dirname, "..", "src", "vipcars", "pricingRecommendations.js");

fs.writeFileSync(resultsPath, [
  "location,duration_days,pickup_date,dropoff_date,provider,provider_rating,total_price,price_per_day,pay_now_amount,pay_now_currency,currency,source",
  "Warsaw,2,2026-09-03,2026-09-05,MM Cars Rental,9.0,20,10,2,EUR,EUR,search",
  "Warsaw,2,2026-09-03,2026-09-05,Rival A,8.0,30,15,,,EUR,search",
  "Warsaw,2,2026-09-03,2026-09-05,Missing Price,8.0,,,,,EUR,search",
  "Krakow,2,2026-09-03,2026-09-05,Rival B,8.0,20,10,,,EUR,search",
  "Krakow,2,2026-09-03,2026-09-05,MM Cars Rental,9.0,24,12,2.4,EUR,EUR,search",
  "Gdansk,2,2026-09-03,2026-09-05,Rival C,8.0,20,10,,,EUR,search",
  "Gdansk,2,2026-09-03,2026-09-05,Rival D,8.0,22,11,,,EUR,search",
  "Gdansk,2,2026-09-03,2026-09-05,MM Cars Rental,9.0,26,13,2.6,EUR,EUR,search",
  "Warsaw,2,2026-09-04,2026-09-06,Rival E,8.0,20,10,,,EUR,search"
].join("\n") + "\n", "utf8");

fs.writeFileSync(coveragePath, [
  "location,duration_days,pickup_date,dropoff_date,status,result_count,error",
  "Warsaw,2,2026-09-03,2026-09-05,complete,2,",
  "Krakow,2,2026-09-03,2026-09-05,complete,2,",
  "Gdansk,2,2026-09-03,2026-09-05,complete,3,",
  "Warsaw,2,2026-09-04,2026-09-06,complete,1,",
  "Krakow,2,2026-09-04,2026-09-06,incomplete,0,timeout",
  "Gdansk,2,2026-09-04,2026-09-06,complete,0,"
].join("\n") + "\n", "utf8");

const expectedPlanArgs = [
  "--expected-locations=Warsaw,Krakow,Gdansk",
  "--expected-durations=2",
  "--expected-pickup-count=2"
];
const result = spawnSync(process.execPath, [scriptPath, resultsPath, coveragePath, outputPath, ...expectedPlanArgs], {
  cwd: path.join(__dirname, ".."),
  encoding: "utf8"
});
assert.equal(result.status, 0, result.stderr || result.stdout);

const payload = JSON.parse(fs.readFileSync(outputPath, "utf8"));
assert.equal(payload.decision_count, 6);
assert.equal(payload.active_count, 3);
assert.deepEqual(payload.expected_locations, ["Gdansk", "Krakow", "Warsaw"]);

const byKey = new Map(payload.decisions.map((item) => [`${item.pickup_date}|${item.location}`, item]));
const warsaw = byKey.get("2026-09-03|Warsaw");
assert.equal(warsaw.recommendation_type, "top1_gap");
assert.equal(warsaw.action, "increase");
assert.equal(warsaw.site_target_rate_eur_day, 14.75);
assert.equal(warsaw.pay_now_total_eur, 2);
assert.equal(warsaw.pay_now_eur_day, 1);
assert.equal(warsaw.pay_now_share_percent, 10);
assert.equal(warsaw.broker_markup_multiplier, 1.1111);
assert.equal(warsaw.broker_markup_percent, 11.1111);
assert.equal(warsaw.mm_net_rate_eur_day, 9);
assert.equal(warsaw.site_target_net_rate_eur_day, 13.75);
assert.equal(warsaw.maximum_adjustment_ratio, 1.5278);

const krakow = byKey.get("2026-09-03|Krakow");
assert.equal(krakow.recommendation_type, "top1_undercut");
assert.equal(krakow.action, "decrease");
assert.equal(krakow.site_target_rate_eur_day, 9.75);
assert.equal(krakow.maximum_adjustment_ratio, 0.7917);

const gdansk = byKey.get("2026-09-03|Gdansk");
assert.equal(gdansk.recommendation_type, "rank_step_undercut");
assert.equal(gdansk.target_rank, 2);
assert.equal(gdansk.site_target_rate_eur_day, 10.75);

assert.equal(byKey.get("2026-09-04|Warsaw").data_quality_status, "missing_mm");
assert.equal(byKey.get("2026-09-04|Krakow").data_quality_status, "incomplete");

const missingPayNow = buildRecommendations([
  {
    location: "Warsaw", duration_days: "2", pickup_date: "2026-09-03", dropoff_date: "2026-09-05",
    provider: "MM Cars Rental", total_price: "20", price_per_day: "10", currency: "EUR"
  },
  {
    location: "Warsaw", duration_days: "2", pickup_date: "2026-09-03", dropoff_date: "2026-09-05",
    provider: "Rival A", total_price: "30", price_per_day: "15", currency: "EUR"
  }
], [{
  location: "Warsaw", duration_days: "2", pickup_date: "2026-09-03", dropoff_date: "2026-09-05",
  status: "complete", result_count: "2", error: ""
}], {
  expectedLocations: ["Warsaw"],
  expectedDurations: [2],
  expectedPickupCount: 1
});
assert.equal(missingPayNow.decisions[0].action, "hold");
assert.equal(missingPayNow.decisions[0].data_quality_status, "missing_pay_now");

const mismatchedPayNowCurrency = buildRecommendations([
  {
    location: "Warsaw", duration_days: "2", pickup_date: "2026-09-03", dropoff_date: "2026-09-05",
    provider: "MM Cars Rental", total_price: "20", price_per_day: "10", currency: "EUR",
    pay_now_amount: "8", pay_now_currency: "PLN"
  },
  {
    location: "Warsaw", duration_days: "2", pickup_date: "2026-09-03", dropoff_date: "2026-09-05",
    provider: "Rival A", total_price: "30", price_per_day: "15", currency: "EUR"
  }
], [{
  location: "Warsaw", duration_days: "2", pickup_date: "2026-09-03", dropoff_date: "2026-09-05",
  status: "complete", result_count: "2", error: ""
}], {
  expectedLocations: ["Warsaw"],
  expectedDurations: [2],
  expectedPickupCount: 1
});
assert.equal(mismatchedPayNowCurrency.decisions[0].data_quality_status, "invalid_pay_now_currency");

const excessivePayNow = buildRecommendations([
  {
    location: "Warsaw", duration_days: "2", pickup_date: "2026-09-03", dropoff_date: "2026-09-05",
    provider: "MM Cars Rental", total_price: "20", price_per_day: "10", currency: "EUR",
    pay_now_amount: "5", pay_now_currency: "EUR"
  },
  {
    location: "Warsaw", duration_days: "2", pickup_date: "2026-09-03", dropoff_date: "2026-09-05",
    provider: "Rival A", total_price: "30", price_per_day: "15", currency: "EUR"
  }
], [{
  location: "Warsaw", duration_days: "2", pickup_date: "2026-09-03", dropoff_date: "2026-09-05",
  status: "complete", result_count: "2", error: ""
}], {
  expectedLocations: ["Warsaw"],
  expectedDurations: [2],
  expectedPickupCount: 1
});
assert.equal(excessivePayNow.decisions[0].data_quality_status, "pay_now_markup_out_of_bounds");

const excessiveAdjustment = buildRecommendations([
  {
    location: "Warsaw", duration_days: "2", pickup_date: "2026-09-03", dropoff_date: "2026-09-05",
    provider: "MM Cars Rental", total_price: "20", price_per_day: "10", currency: "EUR",
    pay_now_amount: "2", pay_now_currency: "EUR"
  },
  {
    location: "Warsaw", duration_days: "2", pickup_date: "2026-09-03", dropoff_date: "2026-09-05",
    provider: "Rival A", total_price: "80", price_per_day: "40", currency: "EUR"
  }
], [{
  location: "Warsaw", duration_days: "2", pickup_date: "2026-09-03", dropoff_date: "2026-09-05",
  status: "complete", result_count: "2", error: ""
}], {
  expectedLocations: ["Warsaw"],
  expectedDurations: [2],
  expectedPickupCount: 1
});
assert.equal(excessiveAdjustment.decisions[0].action, "hold");
assert.equal(excessiveAdjustment.decisions[0].data_quality_status, "adjustment_out_of_bounds");

const emptyCoveragePath = path.join(tempDir, "empty-coverage.csv");
const emptyCoverageOutputPath = path.join(tempDir, "must-not-exist-empty.json");
fs.writeFileSync(emptyCoveragePath, "location,duration_days,pickup_date,dropoff_date,status,result_count,error\n", "utf8");
const emptyCoverageResult = spawnSync(
  process.execPath,
  [scriptPath, resultsPath, emptyCoveragePath, emptyCoverageOutputPath, ...expectedPlanArgs],
  { cwd: path.join(__dirname, ".."), encoding: "utf8" }
);
assert.notEqual(emptyCoverageResult.status, 0);
assert.match(`${emptyCoverageResult.stdout}${emptyCoverageResult.stderr}`, /coverage/i);
assert.equal(fs.existsSync(emptyCoverageOutputPath), false);

const incompleteMatrixOutputPath = path.join(tempDir, "must-not-exist-matrix.json");
const incompleteMatrixResult = spawnSync(process.execPath, [
  scriptPath,
  resultsPath,
  coveragePath,
  incompleteMatrixOutputPath,
  "--expected-locations=Warsaw,Krakow,Gdansk,Poznan",
  "--expected-durations=2",
  "--expected-pickup-count=2"
], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
assert.notEqual(incompleteMatrixResult.status, 0);
assert.match(`${incompleteMatrixResult.stdout}${incompleteMatrixResult.stderr}`, /coverage matrix/i);
assert.equal(fs.existsSync(incompleteMatrixOutputPath), false);

const missingPlanOutputPath = path.join(tempDir, "must-not-exist-no-plan.json");
const missingPlanResult = spawnSync(
  process.execPath,
  [scriptPath, resultsPath, coveragePath, missingPlanOutputPath],
  { cwd: path.join(__dirname, ".."), encoding: "utf8" }
);
assert.notEqual(missingPlanResult.status, 0);
assert.match(`${missingPlanResult.stdout}${missingPlanResult.stderr}`, /expected coverage plan/i);
assert.equal(fs.existsSync(missingPlanOutputPath), false);

const root = path.join(__dirname, "..");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "vipcars-daily.yml"), "utf8");
assert.match(workflow, /npm run test:all/);
assert.match(workflow, /pickup_count/);
assert.match(workflow, /tools\/update_vipcars_rates\.py/);
assert.match(workflow, /vipcars-recommendations\.xlsx/);
assert.match(workflow, /vipcars-rates-import-ready\.xlsx/);
assert.match(workflow, /"public\/\$optional_file"/);
assert.match(workflow, /%svipcars-recommendations\.xlsx/);
assert.match(workflow, /%svipcars-rates-import-ready\.xlsx/);

const baselinePath = path.join(root, "input", "vipcars-rate-group-export.xlsx");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "input", "vipcars-baseline-manifest.json"), "utf8"));
const baselineHash = crypto.createHash("sha256").update(fs.readFileSync(baselinePath)).digest("hex");
assert.equal(baselineHash, manifest.workbook_sha256);

const pickupPlanPath = path.join(root, "src", "vipcars", "pickupPlan.js");
const pickupPlanResult = spawnSync(process.execPath, [
  pickupPlanPath,
  "--config", "vipcars.config.example.json",
  "--locations", "Warsaw",
  "--pickup-weekdays", "monday,friday",
  "--durations-days", "2"
], { cwd: root, encoding: "utf8" });
assert.equal(pickupPlanResult.status, 0, pickupPlanResult.stderr || pickupPlanResult.stdout);
assert.equal(pickupPlanResult.stdout.trim(), "2");

console.log("All VipCars pricing recommendation tests passed.");

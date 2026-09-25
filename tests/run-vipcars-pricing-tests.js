#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildRecommendations,
  loadOptions,
  runCli
} = require("../src/vipcars/pricingRecommendations");
const { fetchEurPlnExchangeRate } = require("../src/vipcars/exchangeRate");

const rateZones = [
  { location: "Warsaw", code: "WAR", name: "WARSZAWA - AIRPORT", metroplex: "Main Metroplex" }
];
const nbpExchangeRate = {
  pln_per_eur: 4,
  source: "NBP",
  effective_date: "2026-09-24"
};

function coverage(pickupDate = "2026-10-25", durationDays = 2, status = "complete", resultCount = 4) {
  const dropoffDate = new Date(`${pickupDate}T00:00:00Z`);
  dropoffDate.setUTCDate(dropoffDate.getUTCDate() + durationDays);
  return {
    location: "Warsaw",
    duration_days: String(durationDays),
    pickup_date: pickupDate,
    dropoff_date: dropoffDate.toISOString().slice(0, 10),
    status,
    result_count: status === "complete" ? String(resultCount) : "0",
    error: status === "complete" ? "" : "timeout"
  };
}

function offer(provider, rateEurDay, check, payNowEurDay = null, currency = "EUR") {
  const durationDays = Number(check.duration_days);
  return {
    location: check.location,
    duration_days: check.duration_days,
    pickup_date: check.pickup_date,
    dropoff_date: check.dropoff_date,
    provider,
    total_price: String(rateEurDay * durationDays),
    price_per_day: String(rateEurDay),
    pay_now_amount: payNowEurDay == null ? "" : String(payNowEurDay * durationDays),
    pay_now_currency: payNowEurDay == null ? "" : currency,
    currency,
    source: "search"
  };
}

function optionsFor(check, overrides = {}) {
  return {
    expectedLocations: [check.location],
    expectedDurations: [Number(check.duration_days)],
    expectedPickupCount: 1,
    rateZones,
    exchangeRate: nbpExchangeRate,
    ...overrides
  };
}

function buildCase({
  competitorRates,
  pickupDate = "2026-10-25",
  durationDays = 2,
  mmRate = 12,
  payNowRate = 2,
  options = {}
}) {
  const check = coverage(pickupDate, durationDays);
  const rows = [
    offer("MM Cars Rental", mmRate, check, payNowRate),
    ...competitorRates.map((rate, index) => offer(`Rival ${index + 1}`, rate, check))
  ];
  check.result_count = String(rows.length);
  return buildRecommendations(rows, [check], optionsFor(check, options));
}

async function testExchangeRate() {
  const success = await fetchEurPlnExchangeRate({
    fallbackPlnPerEur: 4.3,
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.nbp.pl/api/exchangerates/rates/a/eur/?format=json");
      assert.equal(init.headers.Accept, "application/json");
      assert.ok(init.signal);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          table: "A",
          currency: "euro",
          code: "EUR",
          rates: [{ no: "186/A/NBP/2026", effectiveDate: "2026-09-24", mid: 4.2715 }]
        })
      };
    }
  });
  assert.deepEqual(success, {
    pln_per_eur: 4.2715,
    source: "NBP",
    effective_date: "2026-09-24"
  });

  const malformed = await fetchEurPlnExchangeRate({
    fallbackPlnPerEur: 4.3,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ rates: [] }) })
  });
  assert.equal(malformed.pln_per_eur, 4.3);
  assert.equal(malformed.source, "fallback");
  assert.equal(malformed.effective_date, null);
  assert.match(malformed.reason, /malformed/i);

  for (const invalidRate of [
    { effectiveDate: "2026-99-99", mid: 4.2715 },
    { effectiveDate: "2026-09-26", mid: 4.2715 },
    { effectiveDate: "2026-09-24", mid: true }
  ]) {
    const invalid = await fetchEurPlnExchangeRate({
      fallbackPlnPerEur: 4.3,
      now: new Date("2026-09-25T12:00:00Z"),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ table: "A", code: "EUR", rates: [invalidRate] })
      })
    });
    assert.equal(invalid.source, "fallback");
    assert.equal(invalid.reason, "malformed_response");
  }

  const networkError = await fetchEurPlnExchangeRate({
    fallbackPlnPerEur: 4.31,
    fetchImpl: async () => { throw new Error("offline"); }
  });
  assert.equal(networkError.pln_per_eur, 4.31);
  assert.equal(networkError.source, "fallback");
  assert.equal(networkError.effective_date, null);
  assert.match(networkError.reason, /offline/i);

  const timedOut = await fetchEurPlnExchangeRate({
    fallbackPlnPerEur: 4.32,
    timeoutMs: 5,
    fetchImpl: (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })
  });
  assert.equal(timedOut.pln_per_eur, 4.32);
  assert.equal(timedOut.source, "fallback");
  assert.match(timedOut.reason, /timeout/i);
}

function testRankSelectionAndFloors() {
  const cases = [
    { competitorRates: [10, 11, 12], expectedRank: 1, expectedNet: 6.436 },
    { competitorRates: [9, 10, 11], expectedRank: 2, expectedNet: 6.436 },
    { competitorRates: [8, 9, 10], expectedRank: 3, expectedNet: 6.436 }
  ];
  for (const testCase of cases) {
    const payload = buildCase(testCase);
    const decision = payload.decisions[0];
    assert.equal(decision.target_rank, testCase.expectedRank);
    assert.equal(decision.site_target_net_rate_eur_day, testCase.expectedNet);
    assert.equal(decision.action, "decrease");
    assert.equal(decision.recommendation_type, "absolute_net_target");
    assert.equal(decision.data_quality_status, "ok");
  }

  const blocked = buildCase({ competitorRates: [6, 7, 8] }).decisions[0];
  assert.equal(blocked.action, "hold");
  assert.equal(blocked.target_rank, null);
  assert.equal(blocked.data_quality_status, "floor_blocks_top3");
  assert.equal(blocked.target_candidates.length, 3);
  assert.equal(Object.hasOwn(blocked, "maximum_adjustment_ratio"), false);

  const exactExpiry = buildCase({ competitorRates: [6, 7, 8], pickupDate: "2026-10-25" }).decisions[0];
  assert.equal(exactExpiry.minimum_supplier_gross_pln_day, 30);
  assert.equal(exactExpiry.minimum_net_rate_eur_day, 6.097560975609756);
  assert.equal(exactExpiry.data_quality_status, "floor_blocks_top3");

  const afterExpiry = buildCase({ competitorRates: [6, 7, 8], pickupDate: "2026-10-26" }).decisions[0];
  assert.equal(afterExpiry.minimum_supplier_gross_pln_day, 0);
  assert.equal(afterExpiry.minimum_net_rate_eur_day, 0);
  assert.equal(afterExpiry.target_rank, 1);
  assert.equal(afterExpiry.site_target_net_rate_eur_day, 3.726);

  const sevenDays = buildCase({ competitorRates: [14, 15, 16], durationDays: 7 }).decisions[0];
  assert.equal(sevenDays.minimum_supplier_gross_pln_day, 40);
  assert.equal(sevenDays.minimum_net_rate_eur_day, 8.130081300813009);

  const roundingBoundary = buildCase({ competitorRates: [9.5005004, 9.501, 10] }).decisions[0];
  assert.equal(roundingBoundary.target_candidates[0].net_rate_eur_day, 6.0979);
  assert.equal(roundingBoundary.target_rank, 2);
  assert.equal(roundingBoundary.site_target_net_rate_eur_day, 6.098);

  const exactTpBoundary = buildCase({
    competitorRates: [8.87, 10],
    mmRate: 15,
    payNowRate: 2.495,
    options: {
      exchangeRate: { pln_per_eur: 4.3, source: "NBP", effective_date: "2026-09-24" }
    }
  }).decisions[0];
  assert.equal(exactTpBoundary.target_rank, 1);
  assert.equal(exactTpBoundary.site_target_net_rate_eur_day, 5.673);
  assert.equal(exactTpBoundary.mm_total_eur, "30");
  assert.equal(exactTpBoundary.pay_now_total_eur, "4.99");
}

function testContractAndRawCalculations() {
  const payload = buildCase({ competitorRates: [20, 21, 22], mmRate: 12.5, payNowRate: 2.5 });
  const decision = payload.decisions[0];

  assert.equal(payload.pricing_model, "absolute_net_v1");
  assert.equal(payload.vat_rate_percent, 23);
  assert.equal(payload.undercut_eur_day, 0.5);
  assert.equal(payload.rate_precision, 3);
  assert.deepEqual(payload.exchange_rate, nbpExchangeRate);
  assert.equal(payload.transmission, "automatic");
  assert.equal(payload.vehicle_category, "");
  assert.equal(decision.rate_zone, "WAR");
  assert.equal(decision.rate_zone_name, "WARSZAWA - AIRPORT");
  assert.equal(decision.metroplex, "Main Metroplex");
  assert.equal(decision.mm_rate_eur_day, 12.5);
  assert.equal(decision.mm_total_eur, "25");
  assert.equal(decision.pay_now_total_eur, "5");
  assert.equal(decision.pay_now_eur_day, 2.5);
  assert.equal(decision.pay_now_share_percent, 20);
  assert.equal(decision.broker_markup_multiplier, 1.25);
  assert.equal(decision.broker_markup_percent, 25);
  assert.equal(decision.mm_supplier_gross_rate_eur_day, 10);
  assert.equal(decision.mm_net_rate_eur_day, 8.130081300813009);
  assert.deepEqual(decision.competitor_rates_eur_day, [
    { provider: "Rival 1", rate_eur_day: 20 },
    { provider: "Rival 2", rate_eur_day: 21 },
    { provider: "Rival 3", rate_eur_day: 22 }
  ]);
  assert.deepEqual(decision.target_candidates[0], {
    target_rank: 1,
    site_target_rate_eur_day: 19.5,
    net_rate_eur_day: 12.682926829268293
  });
  assert.equal(decision.site_target_rate_eur_day, 19.5);
  assert.equal(decision.site_target_supplier_gross_rate_eur_day, 15.6);
  assert.equal(decision.site_target_net_rate_eur_day, 12.682);
  assert.equal(decision.action, "increase");

  const largeChange = buildCase({ competitorRates: [100, 101, 102] }).decisions[0];
  assert.equal(largeChange.action, "increase");
  assert.equal(largeChange.target_rank, 1);
  assert.equal(largeChange.site_target_net_rate_eur_day, 67.411);
  assert.equal(largeChange.data_quality_status, "ok");

  const defaultFx = buildCase({
    competitorRates: [10, 11, 12],
    options: { exchangeRate: undefined }
  });
  assert.deepEqual(defaultFx.exchange_rate, {
    pln_per_eur: 4.3,
    source: "fallback",
    effective_date: null,
    reason: "not_provided"
  });
}

function testDataQualityGuards() {
  const check = coverage();
  const baseOptions = optionsFor(check);

  const incomplete = buildRecommendations([], [{ ...check, status: "incomplete", error: "timeout" }], baseOptions);
  assert.equal(incomplete.decisions[0].data_quality_status, "incomplete");
  assert.equal(incomplete.decisions[0].minimum_supplier_gross_pln_day, 30);

  const missingMmCheck = { ...check, result_count: "1" };
  const missingMm = buildRecommendations([offer("Rival", 10, missingMmCheck)], [missingMmCheck], baseOptions);
  assert.equal(missingMm.decisions[0].data_quality_status, "missing_mm");

  const missingPayNowCheck = { ...check, result_count: "2" };
  const missingPayNow = buildRecommendations([
    offer("MM Cars Rental", 12, missingPayNowCheck),
    offer("Rival", 10, missingPayNowCheck)
  ], [missingPayNowCheck], baseOptions);
  assert.equal(missingPayNow.decisions[0].data_quality_status, "missing_pay_now");

  const missingBenchmarkCheck = { ...check, result_count: "1" };
  const missingBenchmark = buildRecommendations([
    offer("MM Cars Rental", 12, missingBenchmarkCheck, 2)
  ], [missingBenchmarkCheck], baseOptions);
  assert.equal(missingBenchmark.decisions[0].data_quality_status, "missing_benchmark");

  const mixedCurrencyCheck = { ...check, result_count: "3" };
  const mixedCurrency = buildRecommendations([
    offer("MM Cars Rental", 12, mixedCurrencyCheck, 2),
    offer("Rival EUR", 10, mixedCurrencyCheck),
    offer("Rival PLN", 40, mixedCurrencyCheck, null, "PLN")
  ], [mixedCurrencyCheck], baseOptions);
  assert.equal(mixedCurrency.decisions[0].data_quality_status, "invalid_currency");
  assert.deepEqual(mixedCurrency.decisions[0].target_candidates, []);

  const negativeCheck = { ...check, result_count: "2" };
  const negative = buildRecommendations([
    offer("MM Cars Rental", 12, negativeCheck, 2),
    offer("Rival", -1, negativeCheck)
  ], [negativeCheck], baseOptions);
  assert.equal(negative.decisions[0].data_quality_status, "invalid_rate");

  const blankPriceCheck = { ...check, result_count: "3" };
  const blankPrice = buildRecommendations([
    offer("MM Cars Rental", 12, blankPriceCheck, 2),
    offer("Rival", 10, blankPriceCheck),
    { ...offer("Blank Price", 9, blankPriceCheck), total_price: "", price_per_day: "" }
  ], [blankPriceCheck], baseOptions);
  assert.equal(blankPrice.decisions[0].data_quality_status, "invalid_rate");

  const outOfBoundsPayNowCheck = { ...check, result_count: "2" };
  const outOfBoundsPayNow = buildRecommendations([
    offer("MM Cars Rental", 12, outOfBoundsPayNowCheck, 3),
    offer("Rival", 15, outOfBoundsPayNowCheck)
  ], [outOfBoundsPayNowCheck], baseOptions);
  assert.equal(outOfBoundsPayNow.decisions[0].data_quality_status, "pay_now_markup_out_of_bounds");

  const countMismatchCheck = { ...check, result_count: "3" };
  const countMismatch = buildRecommendations([
    offer("MM Cars Rental", 12, countMismatchCheck, 2),
    offer("Rival", 10, countMismatchCheck)
  ], [countMismatchCheck], baseOptions);
  assert.equal(countMismatch.decisions[0].action, "hold");
  assert.equal(countMismatch.decisions[0].data_quality_status, "result_count_mismatch");

  const dropoffMismatchCheck = { ...check, result_count: "2" };
  const wrongDropoff = { ...offer("Rival", 10, dropoffMismatchCheck), dropoff_date: "2026-10-28" };
  const dropoffMismatch = buildRecommendations([
    offer("MM Cars Rental", 12, dropoffMismatchCheck, 2),
    wrongDropoff
  ], [dropoffMismatchCheck], baseOptions);
  assert.equal(dropoffMismatch.decisions[0].data_quality_status, "result_count_mismatch");

  assert.throws(
    () => buildRecommendations([offer("MM Cars Rental", 12, check, 2)], [check], {
      ...baseOptions,
      vatRatePercent: "invalid"
    }),
    /VAT rate/i
  );
  assert.throws(
    () => buildRecommendations([], [check], { ...baseOptions, undercutEurDay: 0 }),
    /undercut/i
  );
  assert.throws(
    () => buildRecommendations([], [check], {
      ...baseOptions,
      exchangeRate: { fallback_pln_per_eur: "invalid" }
    }),
    /exchange rate/i
  );
  assert.throws(
    () => buildRecommendations([], [check], { ...baseOptions, transmission: "any" }),
    /automatic/i
  );
  assert.throws(
    () => buildRecommendations([], [check], { ...baseOptions, vehicleCategory: "van" }),
    /vehicle category/i
  );

  assert.throws(
    () => buildRecommendations([], [], baseOptions),
    /coverage is empty/i
  );
  assert.throws(
    () => buildRecommendations([], [check], {
      ...baseOptions,
      expectedLocations: ["Warsaw", "Krakow"]
    }),
    /coverage matrix locations/i
  );
  assert.throws(
    () => buildRecommendations([], [check], {
      ...baseOptions,
      expectedPickupCount: 2
    }),
    /pickup dates/i
  );
}

async function testLoadOptionsAndCli(tempDir) {
  const pricingConfigPath = path.join(tempDir, "pricing.json");
  const runConfigPath = path.join(tempDir, "run.json");
  fs.writeFileSync(pricingConfigPath, JSON.stringify({
    rate_precision: 3,
    pricing: {
      undercut_eur_day: 0.5,
      vat_rate_percent: 23,
      min_broker_markup_multiplier: 1,
      max_broker_markup_multiplier: 1.25
    },
    exchange_rate: { fallback_pln_per_eur: 4.3 },
    minimum_rates: {
      end_date: "2026-10-25",
      bands: [
        { min_days: 2, max_days: 6, min_pln_gross_day: 30 },
        { min_days: 7, max_days: 8, min_pln_gross_day: 40 }
      ]
    },
    rate_zones: rateZones
  }), "utf8");
  fs.writeFileSync(runConfigPath, JSON.stringify({
    locations: ["Warsaw"],
    pickupDate: "2026-10-25",
    pickupTime: "10:00",
    dropoffDate: "2026-10-27",
    dropoffTime: "10:00",
    durationsDays: [2],
    transmission: "any",
    vehicleCategory: "van"
  }), "utf8");

  const fromRunPlan = loadOptions([
    `--config=${pricingConfigPath}`,
    `--run-config=${runConfigPath}`,
    "--expected-pickup-count=1"
  ]);
  assert.equal(fromRunPlan.transmission, "any");
  assert.equal(fromRunPlan.vehicleCategory, "van");
  assert.equal(fromRunPlan.ratePrecision, 3);
  assert.deepEqual(fromRunPlan.exchangeRate, { fallback_pln_per_eur: 4.3 });
  assert.equal(fromRunPlan.minimumRates.end_date, "2026-10-25");

  const cliOverride = loadOptions([
    `--config=${pricingConfigPath}`,
    `--run-config=${runConfigPath}`,
    "--transmission=automatic",
    "--vehicle-category=",
    "--expected-pickup-count=1"
  ]);
  assert.equal(cliOverride.transmission, "automatic");
  assert.equal(cliOverride.vehicleCategory, "");

  const check = coverage("2026-10-25", 2);
  const resultsPath = path.join(tempDir, "results.csv");
  const coveragePath = path.join(tempDir, "coverage.csv");
  const outputPath = path.join(tempDir, "recommendations.json");
  fs.writeFileSync(resultsPath, [
    "location,duration_days,pickup_date,dropoff_date,provider,total_price,price_per_day,pay_now_amount,pay_now_currency,currency,source",
    "Warsaw,2,2026-10-25,2026-10-27,MM Cars Rental,24,12,4,EUR,EUR,search",
    "Warsaw,2,2026-10-25,2026-10-27,Rival,20,10,,,EUR,search"
  ].join("\n") + "\n", "utf8");
  fs.writeFileSync(coveragePath, [
    "location,duration_days,pickup_date,dropoff_date,status,result_count,error",
    `${check.location},${check.duration_days},${check.pickup_date},${check.dropoff_date},complete,2,`
  ].join("\n") + "\n", "utf8");

  let fetchCount = 0;
  await runCli([
    resultsPath,
    coveragePath,
    outputPath,
    `--config=${pricingConfigPath}`,
    "--transmission=automatic",
    "--vehicle-category=",
    "--expected-locations=Warsaw",
    "--expected-durations=2",
    "--expected-pickup-count=1"
  ], {
    fetchExchangeRate: async ({ fallbackPlnPerEur }) => {
      fetchCount += 1;
      assert.equal(fallbackPlnPerEur, 4.3);
      return nbpExchangeRate;
    },
    log: () => {}
  });
  assert.equal(fetchCount, 1);
  const output = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.deepEqual(output.exchange_rate, nbpExchangeRate);
  assert.equal(output.transmission, "automatic");
  assert.equal(output.vehicle_category, "");
}

async function main() {
  await testExchangeRate();
  testRankSelectionAndFloors();
  testContractAndRawCalculations();
  testDataQualityGuards();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("buildRecommendations attempted network access"); };
  try {
    buildCase({ competitorRates: [10, 11, 12] });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vipcars-pricing-"));
  try {
    await testLoadOptionsAndCli(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log("All VipCars pricing recommendation tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

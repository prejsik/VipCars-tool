const fs = require("fs");
const path = require("path");

const { loadConfig } = require("./config");
const { parseCsv } = require("./reportHtml");

const DEFAULT_THRESHOLD_EUR_DAY = 2.5;
const DEFAULT_UNDERCUT_EUR_DAY = 0.25;
const DEFAULT_MIN_BROKER_MARKUP_MULTIPLIER = 1;
const DEFAULT_MAX_BROKER_MARKUP_MULTIPLIER = 1.25;
const DEFAULT_MIN_ADJUSTMENT_RATIO = 0.7;
const DEFAULT_MAX_ADJUSTMENT_RATIO = 1.6;

function isMmCarsProvider(value) {
  return String(value || "").trim().toLowerCase().includes("mm cars rental");
}

function dailyRate(offer) {
  const rawExplicit = String(offer?.price_per_day ?? "").trim();
  if (rawExplicit) {
    const explicit = Number(rawExplicit);
    if (Number.isFinite(explicit) && explicit > 0) {
      return explicit;
    }
  }
  const rawTotal = String(offer?.total_price ?? "").trim();
  const total = rawTotal ? Number(rawTotal) : NaN;
  const days = Number(offer?.duration_days);
  return Number.isFinite(total) && total > 0 && Number.isFinite(days) && days > 0 ? total / days : NaN;
}

function roundRate(value) {
  return Number(Number(value).toFixed(4));
}

function checkKey(row) {
  return [row.pickup_date, row.dropoff_date, row.duration_days, row.location].join("|");
}

function matrixKey(row) {
  return [row.pickup_date, Number(row.duration_days), row.location].join("|");
}

function rateZonePlan(rawRateZones, expectedLocations) {
  const rateZones = Array.isArray(rawRateZones) ? rawRateZones.map((item) => ({
    location: String(item?.location || "").trim(),
    code: String(item?.code || "").trim().toUpperCase(),
    name: String(item?.name || "").trim(),
    metroplex: String(item?.metroplex || "").trim()
  })) : [];
  if (!rateZones.length) {
    return { rateZones: [], byLocation: new Map() };
  }

  const byLocation = new Map();
  const codes = new Set();
  for (const rateZone of rateZones) {
    if (!rateZone.location || !rateZone.code || !rateZone.name || !rateZone.metroplex) {
      throw new Error("Every rate zone requires location, code, name, and metroplex.");
    }
    const locationKey = rateZone.location.toLowerCase();
    if (byLocation.has(locationKey) || codes.has(rateZone.code)) {
      throw new Error(`Duplicate rate zone mapping: ${rateZone.location} / ${rateZone.code}.`);
    }
    byLocation.set(locationKey, rateZone);
    codes.add(rateZone.code);
  }

  const missing = expectedLocations.filter((location) => !byLocation.has(String(location).toLowerCase()));
  if (missing.length) {
    throw new Error(`Rate zone mapping is missing run locations: ${missing.join(", ")}.`);
  }
  return {
    rateZones: rateZones.filter((item) => expectedLocations.some(
      (location) => String(location).toLowerCase() === item.location.toLowerCase()
    )),
    byLocation
  };
}

function validateCoverageMatrix(coverageRows, options) {
  if (!coverageRows.length) {
    throw new Error("Coverage is empty; pricing recommendations cannot be generated.");
  }
  if (
    !options.expectedLocations?.length
    || !options.expectedDurations?.length
    || !Number.isInteger(options.expectedPickupCount)
    || options.expectedPickupCount < 1
  ) {
    throw new Error(
      "An expected coverage plan is required: locations, durations, and a positive pickup date count."
    );
  }
  const keys = coverageRows.map(matrixKey);
  if (new Set(keys).size !== keys.length) {
    throw new Error("Coverage matrix contains duplicate checks.");
  }

  const actualLocations = [...new Set(coverageRows.map((row) => row.location).filter(Boolean))].sort();
  const actualDurations = [...new Set(coverageRows.map((row) => Number(row.duration_days)).filter(Number.isFinite))]
    .sort((left, right) => left - right);
  const pickupDates = [...new Set(coverageRows.map((row) => row.pickup_date).filter(Boolean))].sort();
  const expectedLocations = options.expectedLocations?.length ? [...new Set(options.expectedLocations)].sort() : actualLocations;
  const expectedDurations = options.expectedDurations?.length
    ? [...new Set(options.expectedDurations.map(Number))].sort((left, right) => left - right)
    : actualDurations;

  if (JSON.stringify(actualLocations) !== JSON.stringify(expectedLocations)) {
    throw new Error(`Coverage matrix locations differ from the run plan: ${actualLocations.join(", ")}.`);
  }
  if (JSON.stringify(actualDurations) !== JSON.stringify(expectedDurations)) {
    throw new Error(`Coverage matrix durations differ from the run plan: ${actualDurations.join(", ")}.`);
  }
  if (pickupDates.length !== options.expectedPickupCount) {
    throw new Error(
      `Coverage matrix has ${pickupDates.length} pickup dates, expected ${options.expectedPickupCount}.`
    );
  }

  const keySet = new Set(keys);
  const missing = [];
  for (const pickupDate of pickupDates) {
    for (const duration of expectedDurations) {
      for (const location of expectedLocations) {
        const key = [pickupDate, duration, location].join("|");
        if (!keySet.has(key)) {
          missing.push(key);
        }
      }
    }
  }
  if (missing.length) {
    throw new Error(`Coverage matrix is missing ${missing.length} planned checks; first missing: ${missing[0]}.`);
  }
  return { expectedLocations, expectedDurations };
}

function decisionBase(check, rateZone) {
  return {
    location: check.location,
    rate_zone: rateZone?.code || null,
    rate_zone_name: rateZone?.name || null,
    metroplex: rateZone?.metroplex || null,
    pickup_date: check.pickup_date,
    dropoff_date: check.dropoff_date,
    rental_days: Number(check.duration_days),
    currency: "EUR",
    action: "hold",
    recommendation_type: "none",
    target_rank: null,
    reason: "No price change is recommended.",
    mm_rank: null,
    mm_rate_eur_day: null,
    pay_now_total_eur: null,
    pay_now_eur_day: null,
    pay_now_share_percent: null,
    broker_markup_multiplier: null,
    broker_markup_percent: null,
    broker_markup_source: null,
    mm_net_rate_eur_day: null,
    benchmark_provider: null,
    benchmark_rate_eur_day: null,
    site_target_rate_eur_day: null,
    site_target_net_rate_eur_day: null,
    maximum_adjustment_ratio: 1,
    data_quality_status: "ok",
    coverage_status: check.status || "unknown"
  };
}

function payNowCalibration(mm, options) {
  const rawAmount = String(mm?.pay_now_amount ?? "").trim();
  if (!rawAmount) {
    return { error: "missing_pay_now", reason: "The MM Cars Rental offer does not expose a Pay Now amount." };
  }

  const amount = Number(rawAmount);
  const total = Number(mm?.total_price);
  const days = Number(mm?.duration_days);
  const priceCurrency = String(mm?.currency || "").toUpperCase();
  const payNowCurrency = String(mm?.pay_now_currency || "").toUpperCase();
  if (!payNowCurrency || payNowCurrency !== priceCurrency) {
    return {
      error: "invalid_pay_now_currency",
      reason: `Pay Now currency is ${payNowCurrency || "missing"}, expected ${priceCurrency || "the offer currency"}.`
    };
  }
  if (
    !Number.isFinite(amount) || amount < 0
    || !Number.isFinite(total) || total <= 0
    || !Number.isFinite(days) || days <= 0
    || amount >= total
  ) {
    return { error: "invalid_pay_now", reason: "The MM Cars Rental Pay Now amount is not valid for this offer." };
  }

  const netTotal = total - amount;
  const brokerMultiplier = total / netTotal;
  if (
    brokerMultiplier < options.minBrokerMarkupMultiplier
    || brokerMultiplier > options.maxBrokerMarkupMultiplier
  ) {
    return {
      error: "pay_now_markup_out_of_bounds",
      reason: `Observed Pay Now implies broker multiplier ${roundRate(brokerMultiplier)}, outside the allowed `
        + `${options.minBrokerMarkupMultiplier}-${options.maxBrokerMarkupMultiplier} range.`
    };
  }
  return {
    pay_now_total_eur: roundRate(amount),
    pay_now_eur_day: roundRate(amount / days),
    pay_now_share_percent: roundRate((amount / total) * 100),
    broker_markup_multiplier: roundRate(brokerMultiplier),
    broker_markup_percent: roundRate((amount / netTotal) * 100),
    broker_markup_source: "scraped_pay_now",
    mm_net_rate_eur_day: roundRate(netTotal / days)
  };
}

function applySiteTarget(decision, target, options) {
  const targetNet = target - decision.pay_now_eur_day;
  if (!Number.isFinite(targetNet) || targetNet <= 0 || !Number.isFinite(decision.mm_net_rate_eur_day)) {
    decision.action = "hold";
    decision.recommendation_type = "none";
    decision.maximum_adjustment_ratio = 1;
    decision.data_quality_status = "invalid_pay_now_target";
    decision.reason = "Pay Now leaves no valid net supplier target for this recommendation.";
    return decision;
  }
  decision.site_target_rate_eur_day = roundRate(target);
  decision.site_target_net_rate_eur_day = roundRate(targetNet);
  const adjustmentRatio = targetNet / decision.mm_net_rate_eur_day;
  if (
    adjustmentRatio < options.minAdjustmentRatio
    || adjustmentRatio > options.maxAdjustmentRatio
  ) {
    decision.action = "hold";
    decision.recommendation_type = "none";
    decision.maximum_adjustment_ratio = 1;
    decision.data_quality_status = "adjustment_out_of_bounds";
    decision.reason = `Calculated import multiplier ${roundRate(adjustmentRatio)} is outside the allowed `
      + `${options.minAdjustmentRatio}-${options.maxAdjustmentRatio} range.`;
    return decision;
  }
  decision.maximum_adjustment_ratio = roundRate(adjustmentRatio);
  return decision;
}

function blockedDecision(check, status, reason, rateZone) {
  return { ...decisionBase(check, rateZone), data_quality_status: status, reason };
}

function buildDecision(check, offers, options, rateZone) {
  if (check.status !== "complete") {
    return blockedDecision(check, "incomplete", check.error || "Coverage is incomplete.", rateZone);
  }

  const ranked = offers
    .filter((offer) => Number.isFinite(dailyRate(offer)))
    .sort((left, right) => dailyRate(left) - dailyRate(right));
  const mmIndex = ranked.findIndex((offer) => isMmCarsProvider(offer.provider));
  if (mmIndex < 0) {
    return blockedDecision(check, "missing_mm", "MM Cars Rental is not present in the completed result set.", rateZone);
  }

  const mm = ranked[mmIndex];
  const mmCurrency = String(mm.currency || "").toUpperCase();
  if (mmCurrency !== "EUR") {
    return blockedDecision(check, "invalid_currency", `MM Cars Rental currency is ${mmCurrency || "missing"}, expected EUR.`, rateZone);
  }

  const mmRate = dailyRate(mm);
  const calibration = payNowCalibration(mm, options);
  if (calibration.error) {
    const decision = blockedDecision(check, calibration.error, calibration.reason, rateZone);
    decision.mm_rank = mmIndex + 1;
    decision.mm_rate_eur_day = roundRate(mmRate);
    return decision;
  }
  const eurCompetitors = ranked.filter((offer) => (
    !isMmCarsProvider(offer.provider) && String(offer.currency || "").toUpperCase() === "EUR"
  ));
  if (!eurCompetitors.length) {
    const decision = blockedDecision(check, "missing_benchmark", "No EUR competitor is available for comparison.", rateZone);
    decision.mm_rank = mmIndex + 1;
    decision.mm_rate_eur_day = roundRate(mmRate);
    Object.assign(decision, calibration);
    return decision;
  }

  const decision = decisionBase(check, rateZone);
  decision.mm_rank = mmIndex + 1;
  decision.mm_rate_eur_day = roundRate(mmRate);
  Object.assign(decision, calibration);

  if (mmIndex === 0) {
    const benchmark = ranked.find((offer) => (
      !isMmCarsProvider(offer.provider) && String(offer.currency || "").toUpperCase() === "EUR"
    ));
    const benchmarkRate = dailyRate(benchmark);
    const gap = benchmarkRate - mmRate;
    decision.benchmark_provider = benchmark.provider;
    decision.benchmark_rate_eur_day = roundRate(benchmarkRate);
    decision.target_rank = 1;

    if (gap > options.thresholdEurDay) {
      const target = Math.max(0, benchmarkRate - options.undercutEurDay);
      decision.action = "increase";
      decision.recommendation_type = "top1_gap";
      decision.reason = `MM Cars Rental is first and ${roundRate(gap)} EUR/day below the next competitor.`;
      applySiteTarget(decision, target, options);
    } else {
      decision.recommendation_type = "top1_hold";
      decision.reason = "MM Cars Rental is first without a material price gap.";
    }
    return decision;
  }

  const previous = ranked[mmIndex - 1];
  if (!previous || isMmCarsProvider(previous.provider) || String(previous.currency || "").toUpperCase() !== "EUR") {
    return blockedDecision(check, "missing_benchmark", "The immediately preceding offer is not a comparable EUR competitor.", rateZone);
  }

  const previousRate = dailyRate(previous);
  const gap = mmRate - previousRate;
  decision.benchmark_provider = previous.provider;
  decision.benchmark_rate_eur_day = roundRate(previousRate);
  decision.target_rank = mmIndex;

  if (gap > 0 && gap <= options.thresholdEurDay) {
    const target = Math.max(0, previousRate - options.undercutEurDay);
    decision.action = "decrease";
    decision.recommendation_type = mmIndex === 1 ? "top1_undercut" : "rank_step_undercut";
    decision.reason = `MM Cars Rental can move from rank ${mmIndex + 1} to rank ${mmIndex}.`;
    applySiteTarget(decision, target, options);
  } else {
    decision.recommendation_type = "rank_hold";
    decision.reason = gap <= 0
      ? "MM Cars Rental is not more expensive than the preceding competitor."
      : `The ${roundRate(gap)} EUR/day gap exceeds the recommendation threshold.`;
  }
  return decision;
}

function buildRecommendations(resultRows, coverageRows, options = {}) {
  const settings = {
    thresholdEurDay: Number(options.thresholdEurDay ?? DEFAULT_THRESHOLD_EUR_DAY),
    undercutEurDay: Number(options.undercutEurDay ?? DEFAULT_UNDERCUT_EUR_DAY),
    minBrokerMarkupMultiplier: Number(
      options.minBrokerMarkupMultiplier ?? DEFAULT_MIN_BROKER_MARKUP_MULTIPLIER
    ),
    maxBrokerMarkupMultiplier: Number(
      options.maxBrokerMarkupMultiplier ?? DEFAULT_MAX_BROKER_MARKUP_MULTIPLIER
    ),
    minAdjustmentRatio: Number(options.minAdjustmentRatio ?? DEFAULT_MIN_ADJUSTMENT_RATIO),
    maxAdjustmentRatio: Number(options.maxAdjustmentRatio ?? DEFAULT_MAX_ADJUSTMENT_RATIO)
  };
  const coveragePlan = validateCoverageMatrix(coverageRows, options);
  const zones = rateZonePlan(options.rateZones, coveragePlan.expectedLocations);
  const offersByCheck = new Map();
  for (const row of resultRows) {
    const key = checkKey(row);
    if (!offersByCheck.has(key)) {
      offersByCheck.set(key, []);
    }
    offersByCheck.get(key).push(row);
  }

  const checks = coverageRows;
  const decisions = checks
    .map((check) => buildDecision(
      check,
      offersByCheck.get(checkKey(check)) || [],
      settings,
      zones.byLocation.get(String(check.location).toLowerCase())
    ))
    .sort((left, right) => (
      left.pickup_date.localeCompare(right.pickup_date)
      || left.rental_days - right.rental_days
      || left.location.localeCompare(right.location)
    ));
  const qualityCounts = {};
  for (const decision of decisions) {
    qualityCounts[decision.data_quality_status] = (qualityCounts[decision.data_quality_status] || 0) + 1;
  }

  return {
    generated_at: new Date().toISOString(),
    threshold_eur_day: settings.thresholdEurDay,
    undercut_eur_day: settings.undercutEurDay,
    expected_locations: coveragePlan.expectedLocations,
    rate_zones: zones.rateZones,
    covered_durations: coveragePlan.expectedDurations,
    decision_count: decisions.length,
    active_count: decisions.filter((decision) => decision.action !== "hold").length,
    quality_counts: qualityCounts,
    decisions
  };
}

function loadOptions(argv) {
  const configArg = argv.find((item) => item.startsWith("--config="));
  const config = configArg
    ? JSON.parse(fs.readFileSync(configArg.slice("--config=".length), "utf8"))
    : {};
  const pricing = config.pricing || config;
  const optionValue = (name) => argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  const listValue = (name) => String(optionValue(name) || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const expectedPickupCountRaw = optionValue("expected-pickup-count");
  const runConfigPath = optionValue("run-config");
  const runPlan = runConfigPath ? loadConfig(["--config", runConfigPath]) : null;
  return {
    thresholdEurDay: pricing.threshold_eur_day,
    undercutEurDay: pricing.undercut_eur_day,
    minBrokerMarkupMultiplier: pricing.min_broker_markup_multiplier,
    maxBrokerMarkupMultiplier: pricing.max_broker_markup_multiplier,
    minAdjustmentRatio: pricing.min_adjustment_ratio,
    maxAdjustmentRatio: pricing.max_adjustment_ratio,
    rateZones: config.rate_zones,
    expectedLocations: listValue("expected-locations").length
      ? listValue("expected-locations")
      : runPlan?.locations,
    expectedDurations: listValue("expected-durations").length
      ? listValue("expected-durations").map(Number)
      : runPlan?.durationDays,
    expectedPickupCount: expectedPickupCountRaw
      ? Number(expectedPickupCountRaw)
      : runPlan?.pickupDateOptions.length
  };
}

function runCli(argv = process.argv.slice(2)) {
  const positional = argv.filter((item) => !item.startsWith("--"));
  const [resultsPath, coveragePath, outputPath] = positional;
  if (!resultsPath || !coveragePath || !outputPath) {
    throw new Error(
      "Usage: node pricingRecommendations.js RESULTS.csv COVERAGE.csv OUTPUT.json "
      + "[--config=FILE] [--run-config=FILE] "
      + "[--expected-locations=A,B] [--expected-durations=2,3] [--expected-pickup-count=N]"
    );
  }
  const resultRows = parseCsv(fs.readFileSync(resultsPath, "utf8"));
  const coverageRows = parseCsv(fs.readFileSync(coveragePath, "utf8"));
  const payload = buildRecommendations(resultRows, coverageRows, loadOptions(argv));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`VipCars pricing recommendations saved to ${outputPath} (${payload.active_count} active).`);
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

module.exports = { buildRecommendations, dailyRate, isMmCarsProvider };

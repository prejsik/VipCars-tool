const fs = require("fs");
const path = require("path");
const DecimalJs = require("decimal.js");

const { loadConfig } = require("./config");
const { fetchEurPlnExchangeRate, DEFAULT_FALLBACK_PLN_PER_EUR } = require("./exchangeRate");
const { parseCsv } = require("./reportHtml");

const Decimal = DecimalJs.clone({ precision: 40 });

const DEFAULT_UNDERCUT_EUR_DAY = 0.5;
const DEFAULT_MIN_BROKER_MARKUP_MULTIPLIER = 1;
const DEFAULT_MAX_BROKER_MARKUP_MULTIPLIER = 1.25;
const DEFAULT_VAT_RATE_PERCENT = 23;
const DEFAULT_RATE_PRECISION = 3;
const DEFAULT_MINIMUM_RATES = {
  end_date: "2026-10-25",
  bands: [
    { min_days: 2, max_days: 6, min_pln_gross_day: 30 },
    { min_days: 7, max_days: 8, min_pln_gross_day: 40 }
  ]
};

function isMmCarsProvider(value) {
  return String(value || "").trim().toLowerCase().includes("mm cars rental");
}

function dailyRate(offer) {
  const rawExplicit = String(offer?.price_per_day ?? "").trim();
  if (rawExplicit) {
    const explicit = Number(rawExplicit);
    return Number.isFinite(explicit) && explicit > 0 ? explicit : NaN;
  }
  const rawTotal = String(offer?.total_price ?? "").trim();
  const total = rawTotal ? Number(rawTotal) : NaN;
  const days = Number(offer?.duration_days);
  return Number.isFinite(total) && total > 0 && Number.isFinite(days) && days > 0 ? total / days : NaN;
}

function hasInvalidRate(offer) {
  const rawExplicit = String(offer?.price_per_day ?? "").trim();
  const rawTotal = String(offer?.total_price ?? "").trim();
  if (!rawExplicit && !rawTotal) {
    return true;
  }
  if (rawExplicit) {
    const explicit = Number(rawExplicit);
    if (!Number.isFinite(explicit) || explicit <= 0) {
      return true;
    }
  }
  if (rawTotal) {
    const total = Number(rawTotal);
    const days = Number(offer?.duration_days);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(days) || days <= 0) {
      return true;
    }
  }
  return false;
}

function checkKey(row) {
  return [row.pickup_date, row.dropoff_date, row.duration_days, row.location].join("|");
}

function matrixKey(row) {
  return [row.pickup_date, Number(row.duration_days), row.location].join("|");
}

function isValidIsoDate(value) {
  const normalized = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return false;
  }
  const parsed = new Date(`${normalized}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized;
}

function decimalVatMultiplier(vatRatePercent) {
  return new Decimal(vatRatePercent).div(100).plus(1);
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
  const expectedLocations = [...new Set(options.expectedLocations)].sort();
  const expectedDurations = [...new Set(options.expectedDurations.map(Number))]
    .sort((left, right) => left - right);

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
  if (pickupDates.some((pickupDate) => !isValidIsoDate(pickupDate))) {
    throw new Error("Coverage matrix contains an invalid pickup date.");
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

function normalizeMinimumRates(rawMinimumRates) {
  const source = rawMinimumRates ?? DEFAULT_MINIMUM_RATES;
  const endDate = String(source?.end_date || "");
  if (!isValidIsoDate(endDate)) {
    throw new Error("Minimum rates require a valid end_date in YYYY-MM-DD format.");
  }
  if (!Array.isArray(source?.bands) || !source.bands.length) {
    throw new Error("Minimum rates require at least one duration band.");
  }
  const bands = source.bands.map((band) => ({
    min_days: Number(band?.min_days),
    max_days: Number(band?.max_days),
    min_pln_gross_day: Number(band?.min_pln_gross_day)
  }));
  for (const band of bands) {
    if (
      !Number.isInteger(band.min_days)
      || !Number.isInteger(band.max_days)
      || band.min_days < 1
      || band.max_days < band.min_days
      || !Number.isFinite(band.min_pln_gross_day)
      || band.min_pln_gross_day < 0
    ) {
      throw new Error("Minimum-rate duration bands must contain valid days and non-negative PLN rates.");
    }
  }
  return { end_date: endDate, bands };
}

function normalizeExchangeRate(rawExchangeRate) {
  if (rawExchangeRate == null) {
    return {
      pln_per_eur: DEFAULT_FALLBACK_PLN_PER_EUR,
      source: "fallback",
      effective_date: null,
      reason: "not_provided"
    };
  }
  if (rawExchangeRate.pln_per_eur == null && rawExchangeRate.fallback_pln_per_eur != null) {
    const fallbackPlnPerEur = Number(rawExchangeRate.fallback_pln_per_eur);
    if (!Number.isFinite(fallbackPlnPerEur) || fallbackPlnPerEur <= 0) {
      throw new Error("Exchange rate fallback_pln_per_eur must be a finite positive number.");
    }
    return {
      pln_per_eur: fallbackPlnPerEur,
      source: "fallback",
      effective_date: null,
      reason: "not_fetched"
    };
  }

  const plnPerEur = Number(rawExchangeRate.pln_per_eur);
  const source = String(rawExchangeRate.source || "");
  if (!Number.isFinite(plnPerEur) || plnPerEur <= 0) {
    throw new Error("Exchange rate pln_per_eur must be a finite positive number.");
  }
  if (!new Set(["NBP", "fallback"]).has(source)) {
    throw new Error("Exchange rate source must be NBP or fallback.");
  }
  const effectiveDate = rawExchangeRate.effective_date ?? null;
  if (source === "NBP" && !isValidIsoDate(effectiveDate)) {
    throw new Error("NBP exchange rate requires a valid effective_date.");
  }
  if (source === "fallback" && effectiveDate !== null) {
    throw new Error("Fallback exchange rate effective_date must be null.");
  }
  const normalized = {
    pln_per_eur: plnPerEur,
    source,
    effective_date: effectiveDate
  };
  if (rawExchangeRate.reason != null) {
    normalized.reason = String(rawExchangeRate.reason);
  }
  if (rawExchangeRate.as_of != null) {
    normalized.as_of = String(rawExchangeRate.as_of);
  }
  return normalized;
}

function normalizeSettings(options) {
  const settings = {
    undercutEurDay: Number(options.undercutEurDay ?? DEFAULT_UNDERCUT_EUR_DAY),
    minBrokerMarkupMultiplier: Number(
      options.minBrokerMarkupMultiplier ?? DEFAULT_MIN_BROKER_MARKUP_MULTIPLIER
    ),
    maxBrokerMarkupMultiplier: Number(
      options.maxBrokerMarkupMultiplier ?? DEFAULT_MAX_BROKER_MARKUP_MULTIPLIER
    ),
    vatRatePercent: Number(options.vatRatePercent ?? DEFAULT_VAT_RATE_PERCENT),
    ratePrecision: Number(options.ratePrecision ?? DEFAULT_RATE_PRECISION),
    minimumRates: normalizeMinimumRates(options.minimumRates),
    exchangeRate: normalizeExchangeRate(options.exchangeRate),
    transmission: String(options.transmission ?? "automatic").trim().toLowerCase(),
    vehicleCategory: String(options.vehicleCategory ?? "").trim()
  };
  if (!Number.isFinite(settings.undercutEurDay) || settings.undercutEurDay <= 0) {
    throw new Error("Undercut must be a finite, positive EUR/day amount.");
  }
  if (!Number.isFinite(settings.vatRatePercent) || settings.vatRatePercent < 0) {
    throw new Error("VAT rate must be a finite, non-negative percentage.");
  }
  if (
    !Number.isFinite(settings.minBrokerMarkupMultiplier)
    || !Number.isFinite(settings.maxBrokerMarkupMultiplier)
    || settings.minBrokerMarkupMultiplier <= 0
    || settings.maxBrokerMarkupMultiplier < settings.minBrokerMarkupMultiplier
  ) {
    throw new Error("Broker markup multiplier bounds are invalid.");
  }
  if (!Number.isInteger(settings.ratePrecision) || settings.ratePrecision < 0 || settings.ratePrecision > 9) {
    throw new Error("Rate precision must be an integer between 0 and 9.");
  }
  if (settings.transmission === "auto") {
    settings.transmission = "automatic";
  }
  if (settings.transmission !== "automatic") {
    throw new Error("Pricing recommendations require an automatic-only source run.");
  }
  if (settings.vehicleCategory) {
    throw new Error("Pricing recommendations require an empty vehicle category for the 12 basic classes.");
  }
  return settings;
}

function minimumFloor(check, settings) {
  const days = Number(check.duration_days);
  const active = String(check.pickup_date) <= settings.minimumRates.end_date;
  const band = active
    ? settings.minimumRates.bands.find((item) => days >= item.min_days && days <= item.max_days)
    : null;
  const supplierGrossPln = band?.min_pln_gross_day ?? 0;
  const netRate = supplierGrossPln
    ? new Decimal(supplierGrossPln)
      .div(settings.exchangeRate.pln_per_eur)
      .div(decimalVatMultiplier(settings.vatRatePercent))
    : new Decimal(0);
  return { supplierGrossPln, netRate };
}

function minimumForCheck(check, settings) {
  const minimum = minimumFloor(check, settings);
  return {
    minimum_supplier_gross_pln_day: minimum.supplierGrossPln,
    minimum_net_rate_eur_day: minimum.netRate.toNumber()
  };
}

function decisionBase(check, rateZone, settings) {
  return {
    location: check.location,
    rate_zone: rateZone?.code || null,
    rate_zone_name: rateZone?.name || null,
    metroplex: rateZone?.metroplex || null,
    pickup_date: check.pickup_date,
    dropoff_date: check.dropoff_date,
    rental_days: Number(check.duration_days),
    currency: "EUR",
    vat_rate_percent: settings.vatRatePercent,
    action: "hold",
    recommendation_type: "none",
    target_rank: null,
    reason: "No price change is recommended.",
    mm_rank: null,
    mm_rate_eur_day: null,
    mm_total_eur: null,
    pay_now_total_eur: null,
    pay_now_eur_day: null,
    pay_now_share_percent: null,
    broker_markup_multiplier: null,
    broker_markup_percent: null,
    broker_markup_source: null,
    mm_supplier_gross_rate_eur_day: null,
    mm_net_rate_eur_day: null,
    benchmark_provider: null,
    benchmark_rate_eur_day: null,
    competitor_rates_eur_day: [],
    target_candidates: [],
    site_target_rate_eur_day: null,
    site_target_supplier_gross_rate_eur_day: null,
    site_target_net_rate_eur_day: null,
    ...minimumForCheck(check, settings),
    data_quality_status: "ok",
    coverage_status: check.status || "unknown"
  };
}

function blockedDecision(check, status, reason, rateZone, settings) {
  return { ...decisionBase(check, rateZone, settings), data_quality_status: status, reason };
}

function payNowCalibration(mm, mmRate, settings) {
  const rawAmount = String(mm?.pay_now_amount ?? "").trim();
  if (!rawAmount) {
    return { error: "missing_pay_now", reason: "The MM Cars Rental offer does not expose a Pay Now amount." };
  }

  const days = Number(mm?.duration_days);
  const priceCurrency = String(mm?.currency || "").toUpperCase();
  const payNowCurrency = String(mm?.pay_now_currency || "").toUpperCase();
  if (!payNowCurrency || payNowCurrency !== priceCurrency) {
    return {
      error: "invalid_pay_now_currency",
      reason: `Pay Now currency is ${payNowCurrency || "missing"}, expected ${priceCurrency || "the offer currency"}.`
    };
  }
  let amount;
  let total;
  let mmRateDecimal;
  try {
    amount = new Decimal(rawAmount);
    total = new Decimal(String(mm?.total_price ?? "").trim());
    mmRateDecimal = new Decimal(mmRate);
  } catch {
    return { error: "invalid_pay_now", reason: "The MM Cars Rental Pay Now amount is not valid for this offer." };
  }
  if (
    !amount.isFinite() || amount.isNegative()
    || !total.isFinite() || !total.isPositive()
    || !mmRateDecimal.isFinite() || !mmRateDecimal.isPositive()
    || !Number.isFinite(days) || days <= 0
    || amount.greaterThanOrEqualTo(total)
  ) {
    return { error: "invalid_pay_now", reason: "The MM Cars Rental Pay Now amount is not valid for this offer." };
  }

  const supplierGrossTotal = total.minus(amount);
  const brokerMultiplier = total.div(supplierGrossTotal);
  if (
    brokerMultiplier.lessThan(settings.minBrokerMarkupMultiplier)
    || brokerMultiplier.greaterThan(settings.maxBrokerMarkupMultiplier)
  ) {
    return {
      error: "pay_now_markup_out_of_bounds",
      reason: `Observed Pay Now implies broker multiplier ${brokerMultiplier.toString()}, outside the allowed `
        + `${settings.minBrokerMarkupMultiplier}-${settings.maxBrokerMarkupMultiplier} range.`
    };
  }
  const vatMultiplier = decimalVatMultiplier(settings.vatRatePercent);
  const supplierGrossRate = mmRateDecimal.mul(supplierGrossTotal).div(total);
  const mmNetRate = supplierGrossRate.div(vatMultiplier);
  return {
    values: {
      mm_total_eur: total.toString(),
      pay_now_total_eur: amount.toString(),
      pay_now_eur_day: amount.div(days).toNumber(),
      pay_now_share_percent: amount.div(total).mul(100).toNumber(),
      broker_markup_multiplier: brokerMultiplier.toNumber(),
      broker_markup_percent: amount.div(supplierGrossTotal).mul(100).toNumber(),
      broker_markup_source: "scraped_pay_now",
      mm_supplier_gross_rate_eur_day: supplierGrossRate.toNumber(),
      mm_net_rate_eur_day: mmNetRate.toNumber()
    },
    raw: { total, amount, supplierGrossTotal, brokerMultiplier, mmNetRate }
  };
}

function addMmMetadata(decision, ranked, mmIndex, mmRate, calibration) {
  decision.mm_rank = mmIndex + 1;
  decision.mm_rate_eur_day = mmRate;
  if (calibration?.values) {
    Object.assign(decision, calibration.values);
  }
  return decision;
}

function buildDecision(check, offers, settings, rateZone) {
  if (check.status !== "complete") {
    return blockedDecision(check, "incomplete", check.error || "Coverage is incomplete.", rateZone, settings);
  }
  const declaredResultCount = Number(check.result_count);
  if (
    !Number.isInteger(declaredResultCount)
    || declaredResultCount < 0
    || declaredResultCount !== offers.length
  ) {
    return blockedDecision(
      check,
      "result_count_mismatch",
      `Coverage declares ${check.result_count ?? "missing"} result rows, but ${offers.length} persisted CSV rows `
        + "match the full location/date/duration/dropoff key.",
      rateZone,
      settings
    );
  }
  const invalidRateOffer = offers.find(hasInvalidRate);
  if (invalidRateOffer) {
    return blockedDecision(
      check,
      "invalid_rate",
      `Offer from ${invalidRateOffer.provider || "an unknown provider"} contains a non-positive or invalid price.`,
      rateZone,
      settings
    );
  }

  const ranked = offers
    .filter((offer) => Number.isFinite(dailyRate(offer)))
    .sort((left, right) => (
      dailyRate(left) - dailyRate(right)
      || String(left.provider || "").localeCompare(String(right.provider || ""))
    ));
  const mmIndex = ranked.findIndex((offer) => isMmCarsProvider(offer.provider));
  if (mmIndex < 0) {
    return blockedDecision(
      check,
      "missing_mm",
      "MM Cars Rental is not present in the completed result set.",
      rateZone,
      settings
    );
  }

  const mm = ranked[mmIndex];
  const mmRate = dailyRate(mm);
  const invalidCurrency = ranked.find((offer) => String(offer.currency || "").toUpperCase() !== "EUR");
  if (invalidCurrency) {
    const decision = blockedDecision(
      check,
      "invalid_currency",
      `Offer from ${invalidCurrency.provider || "an unknown provider"} uses `
        + `${String(invalidCurrency.currency || "missing").toUpperCase()}, expected EUR for every priced offer.`,
      rateZone,
      settings
    );
    return addMmMetadata(decision, ranked, mmIndex, mmRate);
  }

  const calibration = payNowCalibration(mm, mmRate, settings);
  if (calibration.error) {
    const decision = blockedDecision(check, calibration.error, calibration.reason, rateZone, settings);
    return addMmMetadata(decision, ranked, mmIndex, mmRate);
  }

  const competitors = ranked
    .filter((offer) => !isMmCarsProvider(offer.provider))
    .slice(0, 3)
    .map((offer) => ({ provider: offer.provider, rate_eur_day: dailyRate(offer) }));
  if (!competitors.length) {
    const decision = blockedDecision(
      check,
      "missing_benchmark",
      "No EUR competitor is available for comparison.",
      rateZone,
      settings
    );
    return addMmMetadata(decision, ranked, mmIndex, mmRate, calibration);
  }

  const decision = decisionBase(check, rateZone, settings);
  addMmMetadata(decision, ranked, mmIndex, mmRate, calibration);
  decision.competitor_rates_eur_day = competitors;

  const vatMultiplier = decimalVatMultiplier(settings.vatRatePercent);
  const candidateRecords = competitors
    .map((competitor, index) => {
      const siteTargetRate = new Decimal(competitor.rate_eur_day).minus(settings.undercutEurDay);
      if (!siteTargetRate.isFinite() || !siteTargetRate.isPositive()) {
        return null;
      }
      const netRate = siteTargetRate
        .mul(calibration.raw.supplierGrossTotal)
        .div(calibration.raw.total.mul(vatMultiplier));
      return {
        siteTargetRate,
        netRate,
        serialized: {
          target_rank: index + 1,
          site_target_rate_eur_day: siteTargetRate.toNumber(),
          net_rate_eur_day: netRate.toNumber()
        }
      };
    })
    .filter(Boolean);
  decision.target_candidates = candidateRecords.map((candidate) => candidate.serialized);

  const minimumNetRoundedUp = minimumFloor(check, settings).netRate.toDecimalPlaces(
    settings.ratePrecision,
    Decimal.ROUND_CEIL
  );
  const selected = candidateRecords.find((candidate) => {
    const candidateNetRoundedDown = candidate.netRate.toDecimalPlaces(
      settings.ratePrecision,
      Decimal.ROUND_FLOOR
    );
    return candidateNetRoundedDown.isPositive()
      && candidateNetRoundedDown.greaterThanOrEqualTo(minimumNetRoundedUp);
  });
  if (!selected) {
    decision.data_quality_status = "floor_blocks_top3";
    decision.reason = "The configured PLN minimum floor blocks all available top-three targets.";
    return decision;
  }

  const competitor = competitors[selected.serialized.target_rank - 1];
  const selectedNetRate = selected.netRate.toDecimalPlaces(settings.ratePrecision, Decimal.ROUND_FLOOR);
  decision.target_rank = selected.serialized.target_rank;
  decision.benchmark_provider = competitor.provider;
  decision.benchmark_rate_eur_day = competitor.rate_eur_day;
  decision.site_target_rate_eur_day = selected.siteTargetRate.toNumber();
  decision.site_target_supplier_gross_rate_eur_day = selected.siteTargetRate
    .mul(calibration.raw.supplierGrossTotal)
    .div(calibration.raw.total)
    .toNumber();
  decision.site_target_net_rate_eur_day = selectedNetRate.toNumber();
  decision.recommendation_type = "absolute_net_target";
  if (selectedNetRate.greaterThan(calibration.raw.mmNetRate)) {
    decision.action = "increase";
  } else if (selectedNetRate.lessThan(calibration.raw.mmNetRate)) {
    decision.action = "decrease";
  }
  decision.reason = `Target rank ${selected.serialized.target_rank} at `
    + `${decision.site_target_net_rate_eur_day} EUR net/day.`;
  return decision;
}

function buildRecommendations(resultRows, coverageRows, options = {}) {
  const settings = normalizeSettings(options);
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

  const decisions = coverageRows
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
    pricing_model: "absolute_net_v1",
    undercut_eur_day: settings.undercutEurDay,
    vat_rate_percent: settings.vatRatePercent,
    rate_precision: settings.ratePrecision,
    exchange_rate: settings.exchangeRate,
    transmission: "automatic",
    vehicle_category: "",
    expected_locations: coveragePlan.expectedLocations,
    rate_zones: zones.rateZones,
    covered_durations: coveragePlan.expectedDurations,
    decision_count: decisions.length,
    active_count: decisions.filter((decision) => decision.action !== "hold").length,
    quality_counts: qualityCounts,
    decisions
  };
}

function optionValue(argv, name) {
  const prefix = `--${name}=`;
  const withEquals = argv.find((item) => item.startsWith(prefix));
  if (withEquals !== undefined) {
    return withEquals.slice(prefix.length);
  }
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function positionalValues(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      values.push(token);
      continue;
    }
    if (!token.includes("=") && argv[index + 1] !== undefined && !argv[index + 1].startsWith("--")) {
      index += 1;
    }
  }
  return values;
}

function loadOptions(argv) {
  const configPath = optionValue(argv, "config");
  const config = configPath
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const pricing = config.pricing || config;
  const listValue = (name) => String(optionValue(argv, name) ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const expectedPickupCountRaw = optionValue(argv, "expected-pickup-count");
  const runConfigPath = optionValue(argv, "run-config");
  const runPlan = runConfigPath ? loadConfig(["--config", runConfigPath]) : null;
  const expectedLocations = listValue("expected-locations");
  const expectedDurations = listValue("expected-durations");
  const transmission = optionValue(argv, "transmission");
  const vehicleCategory = optionValue(argv, "vehicle-category");
  return {
    undercutEurDay: pricing.undercut_eur_day,
    minBrokerMarkupMultiplier: pricing.min_broker_markup_multiplier,
    maxBrokerMarkupMultiplier: pricing.max_broker_markup_multiplier,
    vatRatePercent: pricing.vat_rate_percent,
    minimumRates: config.minimum_rates ?? pricing.minimum_rates,
    ratePrecision: config.rate_precision ?? pricing.rate_precision,
    exchangeRate: config.exchange_rate ?? pricing.exchange_rate,
    rateZones: config.rate_zones,
    transmission: transmission !== undefined ? transmission : runPlan?.transmission,
    vehicleCategory: vehicleCategory !== undefined ? vehicleCategory : runPlan?.vehicleCategory,
    expectedLocations: expectedLocations.length ? expectedLocations : runPlan?.locations,
    expectedDurations: expectedDurations.length ? expectedDurations.map(Number) : runPlan?.durationDays,
    expectedPickupCount: expectedPickupCountRaw !== undefined
      ? Number(expectedPickupCountRaw)
      : runPlan?.pickupDateOptions?.length
  };
}

async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const [resultsPath, coveragePath, outputPath] = positionalValues(argv);
  if (!resultsPath || !coveragePath || !outputPath) {
    throw new Error(
      "Usage: node pricingRecommendations.js RESULTS.csv COVERAGE.csv OUTPUT.json "
      + "[--config=FILE] [--run-config=FILE] [--transmission=automatic] [--vehicle-category=] "
      + "[--expected-locations=A,B] [--expected-durations=2,3] [--expected-pickup-count=N]"
    );
  }
  const options = loadOptions(argv);
  const fallbackPlnPerEur = Number(
    options.exchangeRate?.fallback_pln_per_eur
    ?? options.exchangeRate?.pln_per_eur
    ?? DEFAULT_FALLBACK_PLN_PER_EUR
  );
  const fetchRate = dependencies.fetchExchangeRate ?? fetchEurPlnExchangeRate;
  options.exchangeRate = await fetchRate({
    fallbackPlnPerEur,
    timeoutMs: Number(options.exchangeRate?.timeout_ms ?? 5000)
  });

  const resultRows = parseCsv(fs.readFileSync(resultsPath, "utf8"));
  const coverageRows = parseCsv(fs.readFileSync(coveragePath, "utf8"));
  const payload = buildRecommendations(resultRows, coverageRows, options);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const log = dependencies.log ?? console.log;
  log(`VipCars pricing recommendations saved to ${outputPath} (${payload.active_count} active).`);
  return payload;
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildRecommendations,
  dailyRate,
  isMmCarsProvider,
  loadOptions,
  runCli
};

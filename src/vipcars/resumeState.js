const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createCoveragePlan } = require("./coverage");

const STATE_VERSION = 1;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_ATTEMPTS_PER_CHECK = 3;

function createRunState(config, now = Date.now()) {
  return {
    runId: randomUUID(),
    startedAt: new Date(now).toISOString(),
    fingerprint: createFingerprint(config),
    results: [],
    coverageRows: createCoveragePlan(config),
    attemptCounts: new Map(),
    cooldown: { until: 0 }
  };
}

function loadRunState(targetPath, config, now = Date.now()) {
  let stored;
  try {
    const readablePath = fs.existsSync(targetPath) ? targetPath : `${targetPath}.previous`;
    stored = JSON.parse(fs.readFileSync(readablePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot load resume checkpoint ${targetPath}: ${error.message}`);
  }

  if (!stored || stored.version !== STATE_VERSION) {
    throw new Error("Resume checkpoint has an unsupported version.");
  }
  if (!stored.run_id || typeof stored.run_id !== "string") {
    throw new Error("Resume checkpoint run_id is invalid.");
  }
  const startedAtMs = Date.parse(stored.started_at);
  if (!Number.isFinite(startedAtMs)) {
    throw new Error("Resume checkpoint started_at is invalid.");
  }
  const ageMs = now - startedAtMs;
  if (ageMs < 0) {
    throw new Error("Resume checkpoint started_at is in the future.");
  }
  if (ageMs > MAX_AGE_MS) {
    throw new Error("Resume checkpoint is older than 6 hours.");
  }
  if (warsawDate(startedAtMs) !== warsawDate(now)) {
    throw new Error("Resume checkpoint is not from the current Warsaw calendar date.");
  }

  const fingerprint = createFingerprint(config);
  if (canonicalJson(stored.fingerprint) !== canonicalJson(fingerprint)) {
    throw new Error("Resume checkpoint fingerprint does not match this run configuration.");
  }

  const coverageRows = validateCoverage(stored.coverage, config);
  const results = validateResults(stored.results, coverageRows, config);
  const attemptCounts = validateAttemptCounts(stored.attempt_counts, coverageRows);
  validateCoverageResults(coverageRows, results);
  const cooldownUntil = stored.cooldown_until ?? 0;
  if (!Number.isSafeInteger(cooldownUntil) || cooldownUntil < 0 || cooldownUntil > 8640000000000000) {
    throw new Error("Resume checkpoint cooldown_until is invalid.");
  }

  return {
    runId: stored.run_id,
    startedAt: stored.started_at,
    fingerprint,
    results,
    coverageRows,
    attemptCounts,
    cooldown: { until: cooldownUntil }
  };
}

function saveRunState(targetPath, state) {
  const attemptCounts = {};
  for (const [key, value] of [...state.attemptCounts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    attemptCounts[key] = value;
  }
  const stored = {
    version: STATE_VERSION,
    run_id: state.runId,
    started_at: state.startedAt,
    fingerprint: state.fingerprint,
    results: state.results,
    coverage: state.coverageRows,
    attempt_counts: attemptCounts,
    cooldown_until: state.cooldown?.until || 0
  };
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${canonicalJson(stored, 2)}\n`, "utf8");
    replaceFileAtomically(temporaryPath, targetPath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
  }
}

function replaceFileAtomically(temporaryPath, targetPath) {
  const previousPath = `${targetPath}.previous`;
  const hadPreviousState = fs.existsSync(targetPath);
  if (hadPreviousState) {
    if (fs.existsSync(previousPath)) {
      fs.unlinkSync(previousPath);
    }
    fs.renameSync(targetPath, previousPath);
  }
  try {
    fs.renameSync(temporaryPath, targetPath);
  } catch (error) {
    if (hadPreviousState && !fs.existsSync(targetPath) && fs.existsSync(previousPath)) {
      fs.renameSync(previousPath, targetPath);
    }
    throw error;
  }
  if (fs.existsSync(previousPath)) {
    try {
      fs.unlinkSync(previousPath);
    } catch {
      // A valid current checkpoint already exists; stale fallback cleanup can wait.
    }
  }
}

function createFingerprint(config) {
  return {
    base_url: config.baseUrl,
    pickup_dates: [...config.pickupDateOptions],
    duration_days: [...config.durationDays],
    locations: [...config.locations],
    currency: config.currency,
    pickup_time: config.pickupTime,
    dropoff_time: config.dropoffTime,
    transmission: config.transmission,
    vehicle_category: config.vehicleCategory,
    residence_country: config.residenceCountry,
    driver_age: config.driverAge,
    max_providers_per_location: config.maxProvidersPerLocation,
    timeout_ms: config.timeoutMs,
    attempt_budget_ms: config.attemptBudgetMs,
    job_budget_ms: config.jobBudgetMs,
    network_results: config.networkResults
  };
}

function validateCoverage(value, config) {
  if (!Array.isArray(value)) {
    throw new Error("Resume checkpoint coverage must be an array.");
  }
  const expectedRows = createCoveragePlan(config);
  if (value.length !== expectedRows.length) {
    throw new Error(`Resume checkpoint coverage has ${value.length} rows; expected ${expectedRows.length}.`);
  }
  const expected = new Map(expectedRows.map((row) => [coverageKey(row), row]));
  const seen = new Set();
  for (const row of value) {
    const key = coverageKey(row || {});
    if (!expected.has(key) || seen.has(key)) {
      throw new Error(`Resume checkpoint coverage contains an unexpected or duplicate key: ${key}.`);
    }
    if (!['pending', 'incomplete', 'complete'].includes(row.status)) {
      throw new Error(`Resume checkpoint coverage status is invalid for ${key}.`);
    }
    if (!Number.isInteger(Number(row.result_count)) || Number(row.result_count) < 0) {
      throw new Error(`Resume checkpoint coverage result count is invalid for ${key}.`);
    }
    row.result_count = Number(row.result_count);
    row.error = String(row.error || "");
    seen.add(key);
  }
  if (seen.size !== expected.size) {
    throw new Error("Resume checkpoint coverage does not contain every planned check.");
  }
  return value;
}

function validateResults(value, coverageRows, config) {
  if (!Array.isArray(value)) {
    throw new Error("Resume checkpoint results must be an array.");
  }
  const coverageKeys = new Set(coverageRows.map(coverageKey));
  for (const row of value) {
    const key = coverageKey(row || {});
    if (!coverageKeys.has(key)) {
      throw new Error(`Resume checkpoint result is outside the planned coverage: ${key}.`);
    }
    if (row.currency !== config.currency) {
      throw new Error(`Resume checkpoint result currency does not match the run for ${key}.`);
    }
  }
  return value;
}

function validateAttemptCounts(value, coverageRows) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Resume checkpoint attempt counts must be an object.");
  }
  const coverageKeys = new Set(coverageRows.map(coverageKey));
  const counts = new Map();
  for (const [key, count] of Object.entries(value)) {
    if (!coverageKeys.has(key)) {
      throw new Error(`Resume checkpoint attempt count has an unexpected key: ${key}.`);
    }
    if (!Number.isInteger(count) || count < 0 || count > MAX_ATTEMPTS_PER_CHECK) {
      throw new Error(`Resume checkpoint attempt count is invalid for ${key}.`);
    }
    counts.set(key, count);
  }
  return counts;
}

function validateCoverageResults(coverageRows, results) {
  const counts = new Map();
  for (const row of results) {
    const key = coverageKey(row);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const row of coverageRows) {
    const key = coverageKey(row);
    const resultCount = counts.get(key) || 0;
    if (row.status === "complete") {
      if (row.result_count !== resultCount) {
        throw new Error(`Resume checkpoint result count does not match completed coverage for ${key}.`);
      }
    } else if (row.result_count !== 0 || resultCount !== 0) {
      throw new Error(`Resume checkpoint has results for unfinished coverage ${key}.`);
    }
  }
}

function coverageKey(row) {
  return [row.pickup_date, row.dropoff_date, Number(row.duration_days), row.location].join("|");
}

function warsawDate(timestamp) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function canonicalJson(value, space) {
  return JSON.stringify(sortKeys(value), null, space);
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

module.exports = {
  createRunState,
  loadRunState,
  saveRunState
};

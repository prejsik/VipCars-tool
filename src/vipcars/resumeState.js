const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createCoveragePlan } = require("./coverage");

const STATE_VERSION = 1;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const WORKFLOW_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS_PER_CHECK = 3;

function createRunState(config, now = Date.now()) {
  const workflowScope = workflowScopeFromEnv();
  const workflowResume = workflowResumeEnabled(workflowScope);
  return {
    runId: randomUUID(),
    startedAt: new Date(now).toISOString(),
    budgetStartedAt: new Date(now).toISOString(),
    workflowScope,
    expiresAt: workflowResume ? now + WORKFLOW_MAX_AGE_MS : Infinity,
    fingerprint: createFingerprint(config),
    results: [],
    coverageRows: createCoveragePlan(config),
    attemptCounts: new Map(),
    retryability: new Map(),
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
  const currentScope = workflowScopeFromEnv();
  const workflowResume = workflowResumeEnabled(currentScope);
  const storedScope = stored.workflow_scope ?? null;
  if (stored.workflow_scope !== undefined) validateWorkflowScope(stored.workflow_scope);
  if (storedScope) {
    if (!currentScope || currentScope.run_id !== storedScope.run_id || currentScope.sha !== storedScope.sha
      || currentScope.run_attempt < storedScope.run_attempt) {
      throw new Error("Resume checkpoint workflow scope does not match GITHUB_RUN_ID/GITHUB_SHA/GITHUB_RUN_ATTEMPT.");
    }
  } else if (workflowResume) {
    throw new Error("Resume checkpoint has no workflow scope; same-GitHub-run recovery is not safe.");
  }
  const startedAtMs = Date.parse(stored.started_at);
  if (!Number.isFinite(startedAtMs)) {
    throw new Error("Resume checkpoint started_at is invalid.");
  }
  const ageMs = now - startedAtMs;
  if (ageMs < 0) {
    throw new Error("Resume checkpoint started_at is in the future.");
  }
  if (ageMs > (workflowResume ? WORKFLOW_MAX_AGE_MS : MAX_AGE_MS)) {
    throw new Error(`Resume checkpoint is older than ${workflowResume ? 24 : 6} hours.`);
  }
  if (!workflowResume && warsawDate(startedAtMs) !== warsawDate(now)) {
    throw new Error("Resume checkpoint is not from the current Warsaw calendar date.");
  }

  const fingerprint = createFingerprint(config);
  if (canonicalJson(stored.fingerprint) !== canonicalJson(fingerprint)) {
    throw new Error("Resume checkpoint fingerprint does not match this run configuration.");
  }
  let budgetStartedAt = storedScope ? (stored.budget_started_at ?? stored.started_at) : stored.started_at;
  const budgetStartedAtMs = Date.parse(budgetStartedAt);
  if (!Number.isFinite(budgetStartedAtMs) || budgetStartedAtMs < startedAtMs || budgetStartedAtMs > now) {
    throw new Error("Resume checkpoint budget_started_at is invalid.");
  }
  // Opt in with VIPCARS_RESUME_SAME_GITHUB_RUN=1. Only a higher GitHub attempt
  // renews the budget; started_at still bounds the entire batch to 24 hours.
  if (workflowResume && currentScope.run_attempt > storedScope.run_attempt) {
    budgetStartedAt = new Date(now).toISOString();
  }

  const coverageRows = validateCoverage(stored.coverage, config);
  const results = validateResults(stored.results, coverageRows, config);
  const attemptCounts = validateAttemptCounts(stored.attempt_counts, coverageRows);
  validateCoverageResults(coverageRows, results);
  const cooldownUntil = stored.cooldown_until ?? 0;
  if (!Number.isSafeInteger(cooldownUntil) || cooldownUntil < 0 || cooldownUntil > 8640000000000000) {
    throw new Error("Resume checkpoint cooldown_until is invalid.");
  }
  const retryability = validateRetryability(stored.retryability, coverageRows, cooldownUntil);

  return {
    runId: stored.run_id,
    startedAt: stored.started_at,
    budgetStartedAt,
    workflowScope: storedScope ? currentScope : null,
    expiresAt: workflowResume ? startedAtMs + WORKFLOW_MAX_AGE_MS : Infinity,
    fingerprint,
    results,
    coverageRows,
    attemptCounts,
    retryability,
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
    ...(state.workflowScope ? { workflow_scope: state.workflowScope, budget_started_at: state.budgetStartedAt } : {}),
    fingerprint: state.fingerprint,
    results: state.results,
    coverage: state.coverageRows,
    attempt_counts: attemptCounts,
    retryability: Object.fromEntries(state.retryability),
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

function workflowScopeFromEnv() {
  if (process.env.GITHUB_ACTIONS !== "true") return null;
  const { GITHUB_RUN_ID: runId, GITHUB_SHA: sha, GITHUB_RUN_ATTEMPT: attempt } = process.env;
  if (runId === undefined && sha === undefined && attempt === undefined) return null;
  const scope = { run_id: runId, sha, run_attempt: Number(attempt) };
  validateWorkflowScope(scope);
  return scope;
}

function validateWorkflowScope(scope) {
  if (!scope || typeof scope.run_id !== "string" || !/^\d+$/.test(scope.run_id)
    || typeof scope.sha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(scope.sha)
    || !Number.isSafeInteger(scope.run_attempt) || scope.run_attempt < 1) {
    throw new Error("Invalid workflow scope: GITHUB_RUN_ID, GITHUB_SHA and positive GITHUB_RUN_ATTEMPT are required.");
  }
}

function workflowResumeEnabled(scope) {
  const flag = process.env.VIPCARS_RESUME_SAME_GITHUB_RUN;
  if (flag !== undefined && flag !== "1" && flag !== "0") {
    throw new Error("VIPCARS_RESUME_SAME_GITHUB_RUN must be 1 or 0.");
  }
  if (flag === "1" && !scope) {
    throw new Error("Same-GitHub-run resume requires GITHUB_ACTIONS=true, GITHUB_RUN_ID, GITHUB_SHA and GITHUB_RUN_ATTEMPT.");
  }
  return flag === "1";
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

function validateRetryability(value, coverageRows, cooldownUntil) {
  // Preserve legacy retry behavior except explicit HTTP 403 with no recorded cooldown.
  if (value === undefined) {
    return new Map(coverageRows.filter((row) => row.status === "incomplete"
      && !cooldownUntil && /^HTTP 403:/i.test(row.error)).map((row) => [coverageKey(row), false]));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Resume checkpoint retryability must be an object.");
  }
  const coverage = new Map(coverageRows.map((row) => [coverageKey(row), row]));
  for (const [key, retryable] of Object.entries(value)) {
    if (!coverage.has(key) || typeof retryable !== "boolean" || coverage.get(key).status === "complete") {
      throw new Error(`Resume checkpoint retryability is invalid for ${key}.`);
    }
  }
  return new Map(Object.entries(value));
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

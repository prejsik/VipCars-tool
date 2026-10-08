const fs = require("node:fs");
const path = require("node:path");
const { parseDate, addDaysToIsoDate } = require("../src/vipcars/utils");
const { sanitizeMessage } = require("../src/vipcars/diagnostics");

const KNOWN_COOLDOWN_UNTIL = Date.parse("2026-10-08T19:13:03Z");
const QUIET_WINDOW_MS = 61 * 60 * 1000;
const RUN_BUDGET_MS = 340 * 60 * 1000;
const VARIANTS = {
  serial: { id: "serial", concurrency: 1, intervalMs: 3000, networkResults: true },
  slow: { id: "slow", concurrency: 1, intervalMs: 8000, networkResults: true },
  parallel: { id: "parallel", concurrency: 2, intervalMs: 3000, networkResults: true },
  native: { id: "native", concurrency: 1, intervalMs: 3000, networkResults: false }
};

function pickupIsFuture(pickupDate, now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}` < `${pickupDate}T10:00:00`;
}

function buildPlan({ pickupDate, notBefore, order = "serial,slow,parallel,native" }, now = Date.now()) {
  parseDate(pickupDate, "pickupDate");
  if (!pickupIsFuture(pickupDate, now)) throw new Error("pickupDate at 10:00 Warsaw must be in the future");
  const notBeforeMs = Date.parse(notBefore);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(notBefore || "")
      || !Number.isFinite(notBeforeMs) || notBeforeMs < KNOWN_COOLDOWN_UNTIL
      || new Date(notBeforeMs).toISOString().replace(".000Z", "Z") !== notBefore) {
    throw new Error("notBefore must be a valid UTC timestamp after the observed server cooldown");
  }
  const ids = order.split(",");
  if (ids.length !== 4 || new Set(ids).size !== 4 || ids.some((id) => !Object.hasOwn(VARIANTS, id))) {
    throw new Error("order must contain serial, slow, parallel and native exactly once");
  }
  return { pickupDate, pickupTime: "10:00", currency: "EUR", transmission: "automatic",
    notBeforeMs, attemptBudgetMs: 360000,
    checks: [2, 3, 4, 5].flatMap((durationDays) => ["Bydgoszcz", "Warsaw"].map((location) => ({ location, durationDays }))),
    variants: ids.map((id) => ({ ...VARIANTS[id] })) };
}

async function runDiagnostic(plan, { attempt, finishPhase = async () => {}, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onProgress = () => {} }) {
  const summary = { plan, startedAtMs: now(), phases: [], status: "running", stopReason: null, cooldownUntilMs: 0 };
  const reportProgress = () => {
    try { onProgress(summary); return true; }
    catch (error) {
      summary.stopReason ||= sanitizeMessage(error.message);
      summary.status = "stopped";
      const phase = summary.phases.at(-1);
      if (phase?.status === "running") phase.stopReason ||= summary.stopReason;
      return false;
    }
  };
  const deadlineAt = now() + RUN_BUDGET_MS;
  let nextStartAt = plan.notBeforeMs;
  for (const variant of plan.variants) {
    nextStartAt = Math.max(nextStartAt, summary.cooldownUntilMs);
    if (nextStartAt >= deadlineAt) {
      summary.stopReason = "Server cooldown or quiet window exceeds the experiment budget";
      break;
    }
    summary.waitingUntilMs = Math.max(now(), nextStartAt);
    if (!reportProgress()) break;
    while (now() < nextStartAt) await sleep(Math.min(60000, nextStartAt - now()));
    if (now() >= deadlineAt || !pickupIsFuture(plan.pickupDate, now())) {
      summary.stopReason = "Experiment budget or pickup time reached before the next variant";
      break;
    }
    summary.waitingUntilMs = null;
    const phase = { ...variant, startedAtMs: now(), checks: [], status: "running", stopReason: null };
    summary.phases.push(phase);
    const phaseDeadlineAt = Math.min(deadlineAt, now() + 30 * 60 * 1000);
    const cooldowns = Array.from({ length: variant.concurrency }, () => ({ until: summary.cooldownUntilMs }));
    const onCooldown = () => {
      const until = Math.max(...cooldowns.map((cooldown) => cooldown.until));
      summary.cooldownUntilMs = Math.max(summary.cooldownUntilMs, until);
      for (const cooldown of cooldowns) cooldown.until = summary.cooldownUntilMs;
      phase.stopReason ||= "Server cooldown received";
      reportProgress();
    };
    let nextIndex = 0;
    await Promise.all(Array.from({ length: variant.concurrency }, async (_, worker) => {
      while (!phase.stopReason && nextIndex < plan.checks.length) {
        // Leave room for Chromium launch outside the scraper's own attempt timer.
        if (now() + plan.attemptBudgetMs + 30000 > phaseDeadlineAt || !pickupIsFuture(plan.pickupDate, now())) {
          phase.stopReason = "Insufficient variant budget for a full attempt, or pickup time reached";
          phase.censored = true;
          break;
        }
        const check = plan.checks[nextIndex++];
        const record = { ...check, worker, startedAtMs: now(), ok: null };
        phase.checks.push(record);
        if (!reportProgress()) {
          record.ok = false;
          record.measurementStatus = "not_started";
          break;
        }
        try {
          const result = await attempt(check, { variant, worker, cooldown: cooldowns[worker],
            deadlineAt: phaseDeadlineAt, onCooldown });
          Object.assign(record, result);
          record.measurementStatus = result.ok ? "complete"
            : /TIMEOUT|TimeoutError|DEADLINE/.test(result.errorCode || "") ? "censored" : "failed";
          if (Number.isFinite(result.retryAt) && result.retryAt > now()) {
            cooldowns[worker].until = result.retryAt;
            onCooldown();
          }
          if (!result.ok) phase.stopReason ||= result.errorCode || result.error || "Incomplete search";
        } catch (error) {
          record.ok = false;
          record.measurementStatus = "failed";
          record.error = sanitizeMessage(error.message);
          phase.stopReason = record.error;
          summary.stopReason ||= record.error;
        } finally {
          record.finishedAtMs = now();
          record.elapsedMs = record.finishedAtMs - record.startedAtMs;
          reportProgress();
        }
      }
    }));
    try { await finishPhase(variant); }
    catch (error) { summary.stopReason ||= sanitizeMessage(error.message); }
    phase.finishedAtMs = now();
    phase.completeCount = phase.checks.filter((check) => check.measurementStatus === "complete").length;
    phase.failureCount = phase.checks.filter((check) => check.measurementStatus === "failed").length;
    phase.censoredCount = phase.checks.filter((check) => check.measurementStatus === "censored").length;
    phase.unattemptedCount = plan.checks.length
      - phase.checks.filter((check) => check.measurementStatus !== "not_started").length;
    phase.status = phase.completeCount === plan.checks.length ? "complete"
      : !phase.failureCount && (phase.censored || phase.censoredCount) ? "censored" : "incomplete";
    nextStartAt = phase.finishedAtMs + QUIET_WINDOW_MS;
    reportProgress();
    if (summary.stopReason) break;
  }
  summary.finishedAtMs = now();
  summary.status = summary.stopReason ? "stopped" : summary.phases.every((phase) => phase.status === "complete")
    ? "complete" : "incomplete";
  reportProgress();
  return summary;
}

function createLiveAdapter(plan, outputDir) {
  const { chromium } = require("playwright");
  const { loadConfig } = require("../src/vipcars/config");
  const { VipCarsScraper } = require("../src/vipcars/scraper");
  const { parseResultRequest } = require("../src/vipcars/resultTransport");
  const baseConfig = loadConfig([
    "--locations", "Bydgoszcz,Warsaw", "--pickup-date", plan.pickupDate,
    "--pickup-dates", plan.pickupDate, "--dropoff-date", addDaysToIsoDate(plan.pickupDate, 2),
    "--pickup-time", "10:00", "--dropoff-time", "10:00", "--currency", "EUR", "--transmission", "automatic"
  ]);
  const browsers = new Map();
  return {
    async attempt(check, options) {
      const { variant, worker } = options;
      if (!browsers.has(worker)) browsers.set(worker, await chromium.launch({ headless: true }));
      const browser = browsers.get(worker);
      const requests = [];
      const started = Date.now();
      const observedBrowser = { async newContext(contextOptions) {
        const context = await browser.newContext(contextOptions);
        context.on("page", (page) => {
          const records = new Map();
          page.on("request", (request) => {
            const parsed = parseResultRequest(request.url(), { includeFiltered: true, includeBootstrap: true });
            if (!parsed) return;
            const offset = parsed.params.get("offset");
            const record = { issuedAtMs: Date.now(), elapsedMs: Date.now() - started,
              method: request.method(), type: parsed.params.get("load_type"),
              offset: /^\d+$/.test(offset || "") ? Number(offset) : null };
            records.set(request, record);
            requests.push(record);
          });
          page.on("response", (response) => {
            const request = response.request();
            const record = records.get(request);
            if (!record) return;
            const timing = request.timing();
            record.status = response.status();
            if (timing.requestStart >= 0 && timing.responseStart >= timing.requestStart) {
              record.responseWaitMs = Math.round(timing.responseStart - timing.requestStart);
            }
          });
          page.on("requestfailed", (request) => {
            const record = records.get(request);
            if (record) record.failure = sanitizeMessage(request.failure()?.errorText);
          });
        });
        return context;
      } };
      const scraper = new VipCarsScraper({ ...baseConfig, ...check, pickupDate: plan.pickupDate,
        dropoffDate: addDaysToIsoDate(plan.pickupDate, check.durationDays), currentDurationDays: check.durationDays,
        networkResults: variant.networkResults, resultRequestIntervalMs: variant.intervalMs,
        attemptBudgetMs: plan.attemptBudgetMs,
        artifactsDir: path.join(outputDir, "failures", variant.id) });
      let diagnostics = null;
      const outcome = await scraper.runLocationWithRetries(observedBrowser, check.location, {
        ...options, attemptsPerPass: 1, maxAttemptsPerCheck: 1,
        onDiagnostics: (snapshot) => { diagnostics = snapshot; }
      });
      return { ok: outcome.ok, providerCount: outcome.results?.length || 0,
        mmVisible: outcome.results?.some((row) => /mm\s*cars/i.test(row.provider)) || false,
        errorCode: outcome.error?.code || outcome.error?.name || null, error: outcome.error ? sanitizeMessage(outcome.error.message) : null,
        errorHttpStatus: outcome.error?.status || null, retryAt: outcome.error?.retryAt || null,
        exceedsProductionBudget: diagnostics ? diagnostics.elapsed_ms > 240000 : null,
        diagnostics, requests };
    },
    async finishPhase() {
      const results = await Promise.allSettled([...browsers.values()].map((browser) => browser.close()));
      browsers.clear();
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    }
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = require("node:util").parseArgs({ args: argv, options: {
    live: { type: "boolean", default: false },
    "pickup-date": { type: "string" }, "not-before": { type: "string" }, order: { type: "string" }
  } }).values;
  const plan = buildPlan({ pickupDate: args["pickup-date"], notBefore: args["not-before"], order: args.order });
  if (!args.live) { console.log(JSON.stringify(plan, null, 2)); return; }
  if (process.env.GITHUB_RUN_ATTEMPT && process.env.GITHUB_RUN_ATTEMPT !== "1") {
    throw new Error("Diagnostic reruns are disabled; do not reset attempts or server cooldown");
  }
  const outputDir = path.resolve(__dirname, "../output/vipcars-diagnostic");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "launched.json"), JSON.stringify({ plan, startedAt: new Date().toISOString() }), { flag: "wx" });
  const live = createLiveAdapter(plan, outputDir);
  let lastProgress = "";
  const onProgress = (summary) => {
    fs.writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify(summary, null, 2));
    const progress = JSON.stringify({ status: summary.status, phase: summary.phases.at(-1)?.id,
      phaseStatus: summary.phases.at(-1)?.status, phaseStopReason: summary.phases.at(-1)?.stopReason,
      checks: summary.phases.at(-1)?.checks.length || 0, stopReason: summary.stopReason,
      waitingUntil: summary.waitingUntilMs ? new Date(summary.waitingUntilMs).toISOString() : null });
    if (progress !== lastProgress) console.log(`DIAG ${progress}`);
    lastProgress = progress;
  };
  try {
    const summary = await runDiagnostic(plan, { ...live, onProgress });
    if (summary.status !== "complete") {
      console.error(`DIAG ended: ${summary.stopReason || "Incomplete comparison; inspect censored, failed and unattempted checks"}`);
      process.exitCode = 1;
    }
  } finally { await live.finishPhase(); }
}

if (require.main === module) main().catch((error) => { console.error(sanitizeMessage(error.message)); process.exitCode = 1; });
module.exports = { buildPlan, runDiagnostic, main };

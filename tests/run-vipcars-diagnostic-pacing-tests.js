const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { mock } = require("node:test");
const { VipCarsScraper } = require("../src/vipcars/scraper");

const config = {
  baseUrl: "https://www.vipcars.com", pickupDate: "2026-10-09", dropoffDate: "2026-10-11",
  pickupTime: "10:00", dropoffTime: "10:00", currency: "EUR", transmission: "any",
  attemptBudgetMs: 60000, networkResults: true
};
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const resultState = {
  cardCount: 0, pageCount: 0, automaticCardCount: 0, totalCount: 0,
  counterId: "car_count_data", noResults: true, hasBusyIndicator: true, busy: false, filterChecked: false
};

async function assertRoutePacing(intervalConfig, expectedIntervalMs, options = {}) {
  const startedAt = Date.UTC(2026, 9, 9);
  const starts = [];
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vipcars-diagnostic-pacing-"));
  let handler;
  let closed = false;
  const page = new EventEmitter();
  page.setDefaultTimeout = () => {};
  page.setDefaultNavigationTimeout = () => {};
  page.evaluate = async (action, args) => args.cardSelector
    ? { ...resultState, session: "private-result-session" } : ({ actual: {
    pickup_country: "119", pickup_city: "1744", pickup_location: "10921",
    dropoff_country: "119", dropoff_city: "1744", dropoff_location: "10921",
    pickup_date: options.wrongContract ? "2026-10-10" : config.pickupDate, dropoff_date: config.dropoffDate,
    pickup_time: config.pickupTime, dropoff_time: config.dropoffTime, currency: config.currency
  }, missing: [], currencyValues: [config.currency] });
  page.screenshot = async () => {};
  page.content = async () => "";
  page.goto = async () => {
    const loadTypes = ["sub_step1", "get_result_desktop", "get_result_desktop_filter"];
    for (const [index, loadType] of loadTypes.entries()) {
      const request = {
        resourceType: () => "xhr", method: () => "GET",
        url: () => `https://be.supplycars.com/be1/node.php?load_type=${loadType}&offset=0&car_page=0&key=private-request-key`,
        postData: () => null, headers: () => ({}),
        timing: () => ({ requestStart: 25, responseStart: 602 })
      };
      const pending = handler({ request: () => request,
        continue: async () => { starts.push(Date.now() - startedAt); },
        abort: async () => { assert.fail("a valid result request must not be aborted"); }
      });
      await nextTurn();
      if (index > 0) {
        mock.timers.tick(expectedIntervalMs - 1);
        await nextTurn();
        assert.equal(starts.length, index,
          `result GET must not dispatch before ${expectedIntervalMs}ms spacing`);
        mock.timers.tick(1);
        await nextTurn();
      }
      assert.equal(starts.length, index + 1, "result GET must dispatch when its interval expires");
      await pending;
      page.emit("response", { request: () => request, url: request.url,
        status: () => 200, text: async () => "" });
    }
    return { status: () => 200 };
  };
  const context = {
    addCookies: async () => {},
    route: async (pattern, callback) => { assert.equal(pattern, "**/*"); handler = callback; },
    newPage: async () => page,
    close: async () => { closed = true; }
  };
  const scraper = new VipCarsScraper({ ...config, ...intervalConfig, artifactsDir });
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: startedAt });
  try {
    const outcome = await scraper.runLocationWithRetries({ newContext: async () => context }, "Warsaw", {
      maxAttemptsPerCheck: 1, onDiagnostics: options.onDiagnostics
    });
    assert.equal(outcome.ok, !options.wrongContract, outcome.error?.stack);
    assert.deepEqual(starts, [0, expectedIntervalMs, expectedIntervalMs * 2]);
    assert.equal(closed, true);
    assert.equal(page.listenerCount("requestfailed"), 0);
    assert.equal(page.listenerCount("response"), 0);
    return outcome;
  } finally {
    mock.timers.reset();
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  }
}

async function main() {
  await assertRoutePacing({ resultRequestIntervalMs: 8000 }, 8000);
  console.log("PASS diagnostic 8000ms pacing through the scraper result route");
  await assertRoutePacing({}, 3000);
  await assertRoutePacing({ resultRequestIntervalMs: 3000 }, 3000);
  console.log("PASS omitted and explicit 3000ms pacing preserve the production default");

  for (const value of [0, -1, 2999, 3000.5, NaN, Infinity, -Infinity, "8000", null, false, {}, []]) {
    assert.throws(() => new VipCarsScraper({ ...config, resultRequestIntervalMs: value }),
      /resultRequestIntervalMs.*3000/, `must reject invalid diagnostic interval ${String(value)}`);
  }
  assert.doesNotThrow(() => new VipCarsScraper({ ...config, resultRequestIntervalMs: undefined }));
  console.log("PASS diagnostic pacing rejects non-integer, non-finite and sub-3000ms values");

  const snapshots = [];
  await assertRoutePacing({ resultRequestIntervalMs: 8000 }, 8000, {
    onDiagnostics: (snapshot) => snapshots.push(snapshot)
  });
  assert.equal(snapshots.length, 1, "retry wrapper must forward one final snapshot per attempt");
  const [snapshot] = snapshots;
  assert.equal(snapshot.location, "Warsaw");
  assert.equal(snapshot.pickup_date, config.pickupDate);
  assert.equal(snapshot.attempt, 1);
  assert.equal(snapshot.outcome, "success");
  assert.equal(snapshot.failure, null);
  assert.equal(snapshot.elapsed_ms, 16000);
  assert.deepEqual(snapshot.result_state, resultState);
  assert.deepEqual(snapshot.stages.find((stage) => stage.name === "result_throttle_wait"),
    { name: "result_throttle_wait", elapsed_ms: 16000, status: "success", count: 3 });
  assert.equal(snapshot.stages.find((stage) => stage.name === "navigation").elapsed_ms, 16000);
  assert.equal(snapshot.requests.length, 3);
  assert.equal(snapshot.requests[1].response_wait_ms, 577);
  assert.equal(snapshot.requests[1].url, "https://be.supplycars.com/be1/node.php");
  assert.doesNotMatch(JSON.stringify(snapshot), /private-result-session|private-request-key/);
  console.log("PASS retry wrapper forwards final sanitized success timings and result state once");

  for (const asyncObserver of [false, true]) {
    let calls = 0;
    const warnings = [];
    const warn = mock.method(console, "warn", (message) => warnings.push(message));
    const observe = () => {
      calls += 1;
      throw new Error("observer failed: https://example.test/?token=private-observer-token Cookie: private-observer-cookie");
    };
    try {
      await assertRoutePacing({}, 3000, { onDiagnostics: asyncObserver ? async () => observe() : observe });
      assert.equal(calls, 1);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /observer failed/);
      assert.doesNotMatch(warnings[0], /private-observer-token|private-observer-cookie/);
    } finally {
      warn.mock.restore();
    }
  }
  console.log("PASS throwing and rejecting diagnostic observers cannot change verified success");

  const failures = [];
  const outcome = await assertRoutePacing({}, 3000, {
    wrongContract: true, onDiagnostics: (failure) => failures.push(failure)
  });
  assert.equal(failures.length, 1);
  assert.equal(outcome.error.code, "SEARCH_CONTRACT_MISMATCH");
  assert.equal(failures[0].outcome, "failure");
  assert.equal(failures[0].failure.code, outcome.error.code);
  assert.deepEqual(failures[0].result_state, resultState);
  assert.equal(failures[0].stages.find((stage) => stage.name === "search_contract").status, "failure");
  console.log("PASS final failure snapshot retains the original failure and result state");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

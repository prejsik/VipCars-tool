const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { chromium } = require("playwright");
const { VipCarsScraper } = require("../src/vipcars/scraper");
const { sanitizeMessage, createAttemptDiagnostics } = require("../src/vipcars/diagnostics");

async function main() {
  const root = path.resolve(__dirname, "..");
  const config = {
    locations: ["Warsaw"], pickupDate: "2026-10-02", dropoffDate: "2026-10-04",
    currentDurationDays: 2, artifactsDir: path.join(root, "output"), timeoutMs: 1000
  };
  Object.assign(config, { pickupTime: "10:00", dropoffTime: "10:00", currency: "EUR" });
  const contractSnapshot = () => ({ actual: {
    pickup_country: "119", pickup_city: "1744", pickup_location: "10921",
    dropoff_country: "119", dropoff_city: "1744", dropoff_location: "10921",
    pickup_date: config.pickupDate, dropoff_date: config.dropoffDate,
    pickup_time: "10:00", dropoff_time: "10:00", currency: "EUR"
  }, missing: [], currencyValues: ["EUR"] });
  const cases = [];
  cases.push(["CORS-hidden Retry-After pauses later scenarios without consuming another attempt", async () => {
    const page = new EventEmitter();
    const cdp = new EventEmitter();
    let detached = false;
    cdp.send = async () => {};
    cdp.detach = async () => { detached = true; cdp.removeAllListeners(); };
    page.context = () => ({ newCDPSession: async () => cdp });
    page.setDefaultTimeout = () => {};
    page.setDefaultNavigationTimeout = () => {};
    page.goto = async () => ({ status: () => 200 });
    page.evaluate = async () => contractSnapshot();
    const context = { addCookies: async () => {}, route: async () => {},
      newPage: async () => page, close: async () => {} };
    const shared = { until: 0 };
    let persisted = 0;
    const scraper = new VipCarsScraper({ ...config, baseUrl: "https://www.vipcars.com", transmission: "any" });
    scraper.waitForSearchOutcome = async () => "results";
    scraper.captureFailureArtifacts = async () => {};
    scraper.loadSearchResultCards = () => new Promise(() => {
      const url = "https://be.supplycars.com/be1/node.php?load_type=get_result_desktop_filter&offset=300";
      const request = { url: () => url, resourceType: () => "xhr", failure: () => ({ errorText: "net::ERR_FAILED" }) };
      // Extra info can precede request metadata; neither event order may lose the cooldown.
      cdp.emit("Network.responseReceivedExtraInfo", { requestId: "result", statusCode: 400,
        headers: { "Retry-After": "1769", "Set-Cookie": "private-test-cookie" } });
      cdp.emit("Network.requestWillBeSent", { requestId: "result", request: { url, method: "GET" } });
      page.emit("requestfailed", request);
    });
    const start = Date.now();
    const outcome = await scraper.runSingleLocation({ newContext: async () => context }, "Warsaw", {
      cooldown: shared, onCooldown: () => { persisted = shared.until; }
    });
    assert.equal(outcome.error.code, "SERVER_COOLDOWN");
    assert.ok(shared.until >= start + 1769000);
    assert.equal(persisted, shared.until, "the cooldown must be persisted at detection");
    assert.doesNotMatch(outcome.error.message, /private-test-cookie/);
    assert.equal(detached, true);
    const nextScraper = new VipCarsScraper(config);
    nextScraper.runSingleLocation = async () => { throw new Error("must not issue another search"); };
    const counts = new Map();
    const blocked = await nextScraper.runLocationWithRetries({}, "Warsaw", {
      cooldown: shared, deadlineAt: Date.now() + 1000, attemptCounts: counts
    });
    assert.equal(blocked.error.code, "SERVER_COOLDOWN");
    assert.equal(blocked.attempts, 0);
    assert.equal(counts.size, 0);
  }]);
  cases.push(["a short cooldown expires before a new search starts", async () => {
    const scraper = new VipCarsScraper(config);
    const cooldown = { until: Date.now() + 35 };
    let startedAt;
    scraper.runSingleLocation = async () => {
      startedAt = Date.now();
      return { ok: true, results: [] };
    };
    const outcome = await scraper.runLocationWithRetries({}, "Warsaw", {
      cooldown, deadlineAt: Date.now() + 1000
    });
    assert.equal(outcome.ok, true);
    assert.ok(startedAt >= cooldown.until);
  }]);
  cases.push(["a cooldown wait cannot start a search after the job deadline", async () => {
    const scraper = new VipCarsScraper(config);
    const realNow = Date.now;
    const realTimeout = global.setTimeout;
    let now = 1000;
    let calls = 0;
    const counts = new Map();
    scraper.runSingleLocation = async () => { calls += 1; return { ok: true, results: [] }; };
    try {
      Date.now = () => now;
      global.setTimeout = (callback, ms) => {
        now += ms + 100;
        queueMicrotask(callback);
      };
      const outcome = await scraper.runLocationWithRetries({}, "Warsaw", {
        cooldown: { until: 1010 }, deadlineAt: 1050, attemptCounts: counts
      });
      assert.equal(calls, 0);
      assert.equal(counts.size, 0);
      assert.equal(outcome.error.code, "JOB_DEADLINE");
    } finally {
      Date.now = realNow;
      global.setTimeout = realTimeout;
    }
  }]);
  cases.push(["a direct attempt does not open a browser context during a known cooldown", async () => {
    let contexts = 0;
    const scraper = new VipCarsScraper(config);
    const outcome = await scraper.runSingleLocation({ newContext: async () => {
      contexts += 1;
      throw new Error("must not open a blocked search");
    } }, "Warsaw", { cooldown: { until: Date.now() + 60000 } });
    assert.equal(contexts, 0);
    assert.equal(outcome.error.code, "SERVER_COOLDOWN");
  }]);
  cases.push(["network mode also records a CORS-hidden server cooldown", async () => {
    const page = new EventEmitter();
    const cdp = new EventEmitter();
    cdp.send = async () => {};
    cdp.detach = async () => cdp.removeAllListeners();
    page.context = () => ({ newCDPSession: async () => cdp });
    page.setDefaultTimeout = () => {};
    page.setDefaultNavigationTimeout = () => {};
    page.goto = () => new Promise(() => {
      const url = "https://be.supplycars.com/be1/node.php?load_type=get_result_desktop&offset=0&car_page=0";
      cdp.emit("Network.requestWillBeSent", { requestId: "initial", request: { url, method: "GET" } });
      cdp.emit("Network.responseReceivedExtraInfo", { requestId: "initial", statusCode: 400,
        headers: { "Retry-After": "3600" } });
    });
    const context = { addCookies: async () => {}, route: async () => {},
      newPage: async () => page, close: async () => {} };
    const shared = { until: 0 };
    const scraper = new VipCarsScraper({ ...config, baseUrl: "https://www.vipcars.com",
      networkResults: true, attemptBudgetMs: 150 });
    scraper.captureFailureArtifacts = async () => {};
    const start = Date.now();
    const outcome = await scraper.runSingleLocation({ newContext: async () => context }, "Warsaw", { cooldown: shared });
    assert.equal(outcome.error.code, "SERVER_COOLDOWN");
    assert.ok(shared.until >= start + 3600000);
  }]);
  cases.push(["failed result requests end a stuck search without consuming its full deadline", async () => {
    for (const [loadType, status, retryable] of [
      ["get_result_desktop_filter", null, true], ["get_result_desktop", 503, true],
      ["get_result_desktop_filter", 429, true], ["get_result_desktop_filter", 403, false]
    ]) {
      const page = new EventEmitter();
      page.setDefaultTimeout = () => {};
      page.setDefaultNavigationTimeout = () => {};
      const request = { url: () => `https://be.supplycars.com/be1/node.php?${encodeURIComponent(JSON.stringify(`load_type=${loadType}&offset=300&key=private-test-key`))}`,
        resourceType: () => "xhr", failure: () => ({ errorText: "net::ERR_FAILED" }) };
      page.evaluate = async () => contractSnapshot();
      page.goto = async () => ({ status: () => 200 });
      const context = { addCookies: async () => {}, route: async () => {},
        newPage: async () => page, close: async () => {} };
      const scraper = new VipCarsScraper({ ...config, baseUrl: "https://www.vipcars.com",
        transmission: "any", attemptBudgetMs: 250 });
      scraper.waitForSearchOutcome = async () => "results";
      scraper.loadSearchResultCards = () => new Promise(() => {
        setTimeout(() => status === null ? page.emit("requestfailed", request)
          : page.emit("response", { request: () => request, status: () => status }), 10);
      });
      scraper.captureFailureArtifacts = async () => {};
      const start = Date.now();
      const result = await scraper.runSingleLocation({ newContext: async () => context }, "Warsaw");
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "RESULT_TRANSPORT_INVALID");
      assert.equal(result.error.retryable, retryable);
      assert.ok(Date.now() - start < 200, "request failure should not wait for attempt timeout");
      assert.doesNotMatch(result.error.message, /private-test-key/);
      assert.equal(page.listenerCount("requestfailed"), 0);
      assert.equal(page.listenerCount("response"), 0);
    }
  }]);
  cases.push(["unrelated failures and intentional cancellation do not interrupt a valid search", async () => {
    const page = new EventEmitter();
    page.setDefaultTimeout = () => {};
    page.setDefaultNavigationTimeout = () => {};
    page.evaluate = async () => contractSnapshot();
    page.goto = async () => {
      for (const [url, type, errorText] of [
        ["https://be.supplycars.com/be1/node.php?load_type=get_result_desktop_filter", "xhr", "net::ERR_ABORTED"],
        ["https://be.supplycars.com/be1/node.php?load_type=other", "xhr", "net::ERR_FAILED"],
        ["https://be.supplycars.com/be1/node.php?load_type=get_result_desktop_filter", "image", "net::ERR_FAILED"],
        ["https://example.test/be1/node.php?load_type=get_result_desktop_filter", "xhr", "net::ERR_FAILED"]
      ]) page.emit("requestfailed", { url: () => url, resourceType: () => type, failure: () => ({ errorText }) });
      return { status: () => 200 };
    };
    const context = { addCookies: async () => {}, route: async () => {},
      newPage: async () => page, close: async () => {} };
    const scraper = new VipCarsScraper({ ...config, baseUrl: "https://www.vipcars.com" });
    scraper.waitForSearchOutcome = async () => "no-results";
    const result = await scraper.runSingleLocation({ newContext: async () => context }, "Warsaw");
    assert.equal(result.ok, true);
  }]);
  cases.push(["a wrong effective search date fails before extracting or accepting empty offers", async () => {
    const temp = fs.mkdtempSync(path.join(root, "output", "runtime-contract-"));
    const page = new EventEmitter();
    page.setDefaultTimeout = () => {};
    page.setDefaultNavigationTimeout = () => {};
    page.goto = async () => ({ status: () => 200 });
    page.evaluate = async () => {
      const state = contractSnapshot();
      state.actual.pickup_date = "2026-10-03";
      return state;
    };
    page.screenshot = async () => {};
    page.content = async () => "";
    const context = { addCookies: async () => {}, route: async () => {},
      newPage: async () => page, close: async () => {} };
    const scraper = new VipCarsScraper({ ...config, baseUrl: "https://www.vipcars.com", artifactsDir: temp });
    scraper.waitForSearchOutcome = async () => "no-results";
    const outcome = await scraper.runSingleLocation({ newContext: async () => context }, "Warsaw");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, "SEARCH_CONTRACT_MISMATCH");
    assert.equal(outcome.error.retryable, false);
  }]);
  cases.push(["provider cap keeps MM Cars even when cheaper competitors fill the limit", async () => {
    const page = new EventEmitter();
    page.setDefaultTimeout = () => {};
    page.setDefaultNavigationTimeout = () => {};
    page.goto = async () => ({ status: () => 200 });
    page.evaluate = async () => contractSnapshot();
    const context = { addCookies: async () => {}, route: async () => {},
      newPage: async () => page, close: async () => {} };
    const scraper = new VipCarsScraper({ ...config, baseUrl: "https://www.vipcars.com",
      maxProvidersPerLocation: 2, transmission: "any" });
    scraper.waitForSearchOutcome = async () => "results";
    scraper.loadSearchResultCards = async () => ({ status: "complete" });
    scraper.extractSearchOffers = async () => [
      { provider: "Competitor A", total_price: 10 },
      { provider: "Competitor B", total_price: 20 },
      { provider: "MM Cars Rental", total_price: 30 },
      { provider: "MM Cars Rental", total_price: 40 }
    ];
    const outcome = await scraper.runSingleLocation({ newContext: async () => context }, "Warsaw");
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.results.map((offer) => offer.provider),
      ["Competitor A", "Competitor B", "MM Cars Rental"]);
    assert.equal(outcome.results[2].total_price, 30);
  }]);
  cases.push(["pagination gets the larger attempt budget without extending empty-page waits", async () => {
    const temp = fs.mkdtempSync(path.join(root, "output", "runtime-budgets-"));
    for (const hasResults of [false, true]) {
      const page = new EventEmitter();
      let navigatedAt;
      page.setDefaultTimeout = () => {};
      page.setDefaultNavigationTimeout = () => {};
      page.goto = async () => { navigatedAt = Date.now(); return { status: () => 200 }; };
      page.evaluate = async (fn, args) => args?.fieldDefinitions ? contractSnapshot() : ({
        cardCount: hasResults ? (Date.now() - navigatedAt >= 50 ? 2 : 1) : 0,
        totalCount: hasResults ? 2 : null, busy: false, noResults: false
      });
      page.waitForTimeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      page.screenshot = async () => {};
      page.content = async () => "";
      const context = { addCookies: async () => {}, route: async () => {},
        newPage: async () => page, close: async () => {} };
      const scraper = new VipCarsScraper({ ...config, timeoutMs: 20, attemptBudgetMs: 500,
        transmission: "any", baseUrl: "https://www.vipcars.com", artifactsDir: temp });
      scraper.extractSearchOffers = async () => [{ provider: "MM Cars Rental", total_price: 50 }];
      const outcome = await scraper.runSingleLocation({ newContext: async () => context }, "Warsaw");
      assert.equal(outcome.ok, hasResults);
      if (!hasResults) assert.equal(outcome.error.code, "SEARCH_OUTCOME_TIMEOUT");
      else assert.ok(Date.now() - navigatedAt >= 50);
    }
  }]);
  cases.push(["diagnostics retain only safe result-state fields", async () => {
    const diagnostics = createAttemptDiagnostics({ attempt: 1 });
    diagnostics.recordResultState({ cardCount: 4, totalCount: 8, busy: false, cookie: "private-cookie" });
    const snapshot = diagnostics.snapshot(new Error("Timeout"));
    assert.equal(snapshot.result_state.cardCount, 4);
    assert.equal(snapshot.result_state.totalCount, 8);
    assert.doesNotMatch(JSON.stringify(snapshot), /private-cookie/);
  }]);
  cases.push(["diagnostics redact Cookie and Set-Cookie header values", async () => {
    assert.doesNotMatch(sanitizeMessage("Cookie: sessionid=private-cookie; extra=private-extra\nSet-Cookie: auth=private-auth"), /private-/);
    assert.doesNotMatch(sanitizeMessage('Failed https://be.supplycars.com/be1/node.php?"&key=private-key&deviceID=private-device"'), /private-/);
  }]);
  cases.push(["context creation is bounded and a late context is closed", async () => {
    const temp = fs.mkdtempSync(path.join(root, "output", "runtime-context-"));
    const scraper = new VipCarsScraper({ ...config, attemptBudgetMs: 25, artifactsDir: temp });
    let finishContext;
    let closes = 0;
    let guard;
    try {
      const outcome = await Promise.race([
        scraper.runSingleLocation({ newContext: () => new Promise((resolve) => { finishContext = resolve; }) }, "Warsaw"),
        new Promise((resolve, reject) => { guard = setTimeout(() => reject(new Error("Context creation exceeded deadline")), 250); })
      ]);
      assert.equal(outcome.error.code, "ATTEMPT_TIMEOUT");
    } finally {
      clearTimeout(guard);
      finishContext({ close: async () => { closes += 1; } });
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(closes, 1);
  }]);
  cases.push(["borrowed browser survives a scenario and is never relaunched", async () => {
    const originalLaunch = chromium.launch;
    let launches = 0;
    let closes = 0;
    const browser = { close: async () => { closes += 1; } };
    chromium.launch = async () => { launches += 1; return browser; };
    try {
      const scraper = new VipCarsScraper(config);
      scraper.runSingleLocation = async () => ({ ok: true, results: [] });
      await scraper.run(undefined, { browser, attemptsPerPass: 1, attemptCounts: new Map() });
      assert.equal(launches, 0);
      assert.equal(closes, 0);
    } finally {
      chromium.launch = originalLaunch;
    }
  }]);
  cases.push(["separate scraper instances share the same three-attempt budget", async () => {
    const counts = new Map();
    let calls = 0;
    const attempts = [];
    for (let pass = 0; pass < 5; pass += 1) {
      const scraper = new VipCarsScraper(config);
      scraper.runSingleLocation = async (browser, location, options) => {
        calls += 1;
        attempts.push(options?.attempt);
        const error = new Error("Timeout 1000ms exceeded.");
        error.name = "TimeoutError";
        return { ok: false, error };
      };
      await scraper.runLocationWithRetries({}, "Warsaw", {
        attemptCounts: counts, attemptsPerPass: 1, maxAttemptsPerCheck: 3,
        deadlineAt: Date.now() + 10000
      });
      assert.equal(calls, Math.min(pass + 1, 3));
    }
    assert.deepEqual(attempts, [1, 2, 3]);
  }]);
  cases.push(["an expired job budget does not start another search", async () => {
    const scraper = new VipCarsScraper(config);
    let calls = 0;
    scraper.runSingleLocation = async () => { calls += 1; return { ok: true, results: [] }; };
    const outcome = await scraper.runLocationWithRetries({}, "Warsaw", {
      deadlineAt: Date.now() - 1, attemptCounts: new Map(), attemptsPerPass: 1
    });
    assert.equal(calls, 0);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.retryable, false);
    assert.equal(outcome.error.code, "JOB_DEADLINE");
  }]);
  cases.push(["publish installs locked Node dependencies before generating recommendations", async () => {
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/vipcars-daily.yml"), "utf8");
    const publish = workflow.slice(workflow.indexOf("\n  publish:"));
    const install = publish.search(/run:\s+npm ci\b/);
    const generation = publish.indexOf("node src/vipcars/pricingRecommendations.js");
    assert.ok(install >= 0 && install < generation,
      "A fresh publish runner must install decimal.js before running recommendations");
  }]);
  cases.push(["failed attempts keep separate diagnostics without URL credentials or tokens", async () => {
    const temp = fs.mkdtempSync(path.join(root, "output", "runtime-test-"));
    const page = new EventEmitter();
    page.setDefaultTimeout = () => {};
    page.setDefaultNavigationTimeout = () => {};
    page.screenshot = async ({ path: filename }) => fs.writeFileSync(filename, "test-image");
    page.content = async () => "<html><body>No loaded results</body></html>";
    page.goto = async () => {
      page.emit("requestfailed", {
        url: () => "https://user:password@res.supplycars.com/search?token=private-token",
        resourceType: () => "xhr", failure: () => ({ errorText: "net::ERR_FAILED" })
      });
      page.emit("pageerror", new Error("Request https://res.supplycars.com/search?api_key=private-key failed"));
      const error = new Error("Timeout 1000ms exceeded.");
      error.name = "TimeoutError";
      throw error;
    };
    const browser = { newContext: async () => ({
      addCookies: async () => {}, route: async () => {}, newPage: async () => page,
      close: async () => {}
    }) };
    const scraper = new VipCarsScraper({ ...config, baseUrl: "https://www.vipcars.com", artifactsDir: temp });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const outcome = await scraper.runSingleLocation(browser, "Warsaw", { attempt, deadlineAt: Date.now() + 10000 });
      assert.equal(outcome.ok, false);
    }
    const files = fs.readdirSync(temp).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 2, "Every attempt must retain its own diagnostic record");
    const records = files.map((name) => JSON.parse(fs.readFileSync(path.join(temp, name), "utf8")));
    assert.deepEqual(records.map((record) => record.attempt).sort(), [1, 2]);
    for (const record of records) {
      assert.ok(record.requests.some((request) => request.error === "net::ERR_FAILED"));
      assert.ok(record.errors.some((error) => error.type === "pageerror"));
      assert.ok(record.stages.some((stage) => stage.name === "navigation"));
      assert.doesNotMatch(JSON.stringify(record), /private-token|private-key|user:password/);
    }
  }]);
  cases.push(["the attempt deadline closes a stalled page and returns an incomplete outcome", async () => {
    const temp = fs.mkdtempSync(path.join(root, "output", "runtime-deadline-"));
    const page = new EventEmitter();
    page.setDefaultTimeout = () => {};
    page.setDefaultNavigationTimeout = () => {};
    page.screenshot = async () => {};
    page.content = async () => "";
    let rejectNavigation;
    let closes = 0;
    page.goto = () => new Promise((resolve, reject) => { rejectNavigation = reject; });
    const context = {
      addCookies: async () => {}, route: async () => {}, newPage: async () => page,
      close: async () => { closes += 1; rejectNavigation?.(new Error("Page closed")); }
    };
    const scraper = new VipCarsScraper({ ...config, attemptBudgetMs: 50,
      baseUrl: "https://www.vipcars.com", artifactsDir: temp });
    let guard;
    try {
      const outcome = await Promise.race([
        scraper.runSingleLocation({ newContext: async () => context }, "Warsaw", { attempt: 1 }),
        new Promise((resolve, reject) => {
          guard = setTimeout(() => { context.close(); reject(new Error("Attempt deadline was not enforced")); }, 1500);
        })
      ]);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.error.code, "ATTEMPT_TIMEOUT");
      assert.ok(closes >= 1);
    } finally { clearTimeout(guard); }
  }]);
  for (const [name, test] of cases) {
    try { await test(); console.log(`PASS ${name}`); }
    catch (error) { console.error(`FAIL ${name}: ${error.message}`); process.exitCode = 1; }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

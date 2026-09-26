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
  const cases = [];
  cases.push(["pagination gets the larger attempt budget without extending empty-page waits", async () => {
    const temp = fs.mkdtempSync(path.join(root, "output", "runtime-budgets-"));
    for (const hasResults of [false, true]) {
      const page = new EventEmitter();
      let navigatedAt;
      page.setDefaultTimeout = () => {};
      page.setDefaultNavigationTimeout = () => {};
      page.goto = async () => { navigatedAt = Date.now(); return { status: () => 200 }; };
      page.evaluate = async () => ({
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

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { loadConfig } = require("../src/vipcars/config");
const { createAttemptDiagnostics } = require("../src/vipcars/diagnostics");
const { VipCarsScraper } = require("../src/vipcars/scraper");
const { parseResultRequest, validateResultRequest, collectResultPages, compareVisibleCards, requestUrl, fetchResultPage, allowPaginationRequest, captureInitialResults, preparePaginationSource } = require("../src/vipcars/resultTransport");

const expected = new URL("https://www.vipcars.com/search/?pickup_country=119&pickup_city=1744&pickup_location=10921&dropoff_country=119&dropoff_city=1744&dropoff_location=10921&pickup_date=2026-09-28&dropoff_date=2026-09-30&pickup_time=10%3A00&dropoff_time=10%3A00&currency=EUR&driver_age=30");
const params = new URLSearchParams(expected.search);
params.set("pickup_loc", params.get("pickup_location"));
params.set("dropoff_loc", params.get("dropoff_location"));
params.delete("pickup_location"); params.delete("dropoff_location");
params.set("load_type", "get_result_desktop"); params.set("offset", "0"); params.set("car_page", "0");
params.set("key", "private-test-session");
const url = `https://be.supplycars.com/be1/node.php?${JSON.stringify(`&${params}`)}`;
const card = (id) => ({ cardId: String(id), provider: "MM Cars Rental", priceText: "EUR 30.00", payNowText: "Pay Now EUR 3.00", automatic: true });

function resultUrl(loadType, offset = 0, carPage = 0) {
  const requestParams = new URLSearchParams(params);
  requestParams.set("load_type", loadType);
  requestParams.set("offset", String(offset));
  requestParams.set("car_page", String(carPage));
  return `https://be.supplycars.com/be1/node.php?${JSON.stringify(`&${requestParams}`)}`;
}

function plainResultUrl(loadType, { offset, carPage } = {}) {
  const requestParams = new URLSearchParams(params);
  requestParams.set("load_type", loadType);
  requestParams.delete("offset");
  requestParams.delete("car_page");
  if (offset !== undefined) requestParams.set("offset", String(offset));
  if (carPage !== undefined) requestParams.set("car_page", String(carPage));
  return `https://be.supplycars.com/be1/node.php?${requestParams}`;
}

function mockResponse(requestUrl, html, headers = {}, status = 200) {
  return {
    url: () => requestUrl,
    status: () => status,
    text: async () => html,
    request: () => ({ method: () => "GET", postData: () => null, headers: () => headers })
  };
}

async function main() {
  const realNow = Date.now;
  let now = 1000;
  try {
    Date.now = () => now;
    for (const outerFirst of [true, false]) {
      now = 1000;
      const diagnostics = createAttemptDiagnostics({ location: "Warsaw" });
      const transportDone = diagnostics.start("network_transport_wait", {
        aggregate: true, exclude: ["network_http_fetch", "network_throttle_wait"] });
      const httpDone = diagnostics.start("network_http_fetch", { aggregate: true, exclude: ["network_throttle_wait"] });
      const throttleDone = diagnostics.start("network_throttle_wait", { aggregate: true });
      now += 30;
      const active = diagnostics.snapshot();
      assert.deepEqual(Object.fromEntries(active.stages.map((stage) => [stage.name, stage.elapsed_ms])), {
        network_transport_wait: 0, network_http_fetch: 0, network_throttle_wait: 30
      }, "snapshots must account active nested exclusions without double counting");
      throttleDone();
      now += 70;
      const finish = outerFirst ? [transportDone, httpDone] : [httpDone, transportDone];
      finish.forEach((done) => done("failure"));
      finish.forEach((done) => done("failure"));
      const stages = diagnostics.snapshot().stages;
      assert.deepEqual(Object.fromEntries(stages.map((stage) => [stage.name, stage.elapsed_ms])), {
        network_throttle_wait: 30, network_transport_wait: 0, network_http_fetch: 70
      }, "exclusive elapsed time must not depend on finish order");
      assert.ok(stages.every((stage) => stage.count === 1));
      assert.equal(active.stages.find((stage) => stage.name === "network_throttle_wait").elapsed_ms, 30,
        "a snapshot must not mutate when active intervals finish");
    }
    now = 1000;
    const diagnostics = createAttemptDiagnostics({ location: "Warsaw" });
    let rejectDeadline;
    const deadline = new Promise((resolve, reject) => { rejectDeadline = reject; });
    const bounded = (operation) => Promise.race([operation, deadline]);
    const measure = (name, action, extra = {}) => diagnostics.measure(name,
      () => bounded(Promise.resolve().then(action)), { aggregate: true, ...extra });
    const pending = measure("network_transport_wait", () =>
      measure("network_http_fetch", () => new Promise(() => {}), { exclude: ["network_throttle_wait"] }),
      { exclude: ["network_http_fetch", "network_throttle_wait"] });
    await new Promise((resolve) => setImmediate(resolve));
    now += 100;
    rejectDeadline(Object.assign(new Error("fixture deadline"), { code: "ATTEMPT_TIMEOUT" }));
    await assert.rejects(pending, { code: "ATTEMPT_TIMEOUT" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(Object.fromEntries(diagnostics.snapshot().stages.map((stage) => [stage.name, stage.elapsed_ms])), {
      network_transport_wait: 0, network_http_fetch: 100
    }, "the scraper's shared deadline must not charge the unfinished HTTP interval to transport wait");
  } finally { Date.now = realNow; }
  console.log("PASS active snapshots and shared-deadline timings remain exclusive in either finish order");
  try {
    Date.now = () => now;
    const diagnostics = createAttemptDiagnostics({ location: "Warsaw" });
    const aggregate = { aggregate: true };
    // Gate time must not be counted again as HTTP or lifecycle wait.
    await diagnostics.measure("network_transport_wait", () => diagnostics.measure("network_http_fetch", async () => {
      const dispatched = diagnostics.start("network_throttle_wait", aggregate);
      now += 3000;
      dispatched();
      dispatched();
      now += 120;
    }, { ...aggregate, exclude: ["network_throttle_wait"] }).then(() => { now += 40; }),
    { ...aggregate, exclude: ["network_http_fetch", "network_throttle_wait"] });
    for (let index = 0; index < 100; index += 1) {
      await diagnostics.measure("network_parser", async () => { now += 2; }, aggregate);
    }
    const error = new Error("fixture parser failure");
    await assert.rejects(diagnostics.measure("network_parser", async () => {
      now += 7;
      throw error;
    }, aggregate), (actual) => actual === error);
    const stages = diagnostics.snapshot().stages;
    assert.equal(stages.length, 4, "aggregate storage must not grow with page count");
    assert.deepEqual(Object.fromEntries(stages.map((stage) => [stage.name, stage.elapsed_ms])), {
      network_throttle_wait: 3000, network_http_fetch: 120, network_transport_wait: 40, network_parser: 207
    });
    assert.equal(stages.find((stage) => stage.name === "network_parser").status, "failure");
    assert.equal(stages.find((stage) => stage.name === "network_parser").count, 101);
    assert.equal(stages.find((stage) => stage.name === "network_throttle_wait").count, 1);
  } finally { Date.now = realNow; }
  console.log("PASS bounded aggregate timings separate throttle, HTTP, parser and lifecycle waits");
  const realTimeout = global.setTimeout;
  try {
    now = 1000;
    Date.now = () => now;
    global.setTimeout = (callback, milliseconds) => {
      now += milliseconds;
      queueMicrotask(callback);
    };
    const scraper = new VipCarsScraper({});
    let waited;
    scraper.runSingleLocation = async (browser, location, options) => {
      waited = options.cooldownWaitMs;
      return { ok: true, results: [] };
    };
    const outcome = await scraper.runLocationWithRetries({}, "Warsaw", {
      cooldown: { until: 1050 }, deadlineAt: 2000
    });
    assert.equal(outcome.ok, true);
    assert.equal(waited, 50, "only elapsed pre-attempt cooldown wait belongs in the separate cooldown metric");
  } finally {
    Date.now = realNow;
    global.setTimeout = realTimeout;
  }
  const opaqueParams = new URLSearchParams(params);
  opaqueParams.set("key", "private&nested=one%2Btwo+three/four=");
  const opaqueUrl = new URL(`https://be.supplycars.com/be1/node.php?${JSON.stringify(`&${opaqueParams}`)}`).href;
  assert.equal(parseResultRequest(opaqueUrl).params.get("key"), opaqueParams.get("key"),
    "decoding the JSON wrapper must not decode nested query values twice");
  const encodedEnvelopeUrl = `https://be.supplycars.com/be1/node.php?${encodeURIComponent(JSON.stringify(`&${opaqueParams}`))}`;
  assert.equal(parseResultRequest(encodedEnvelopeUrl).params.get("key"), opaqueParams.get("key"),
    "a fully encoded envelope must retain its inner query encoding");
  const bootstrapUrl = resultUrl("sub_step1");
  assert.equal(parseResultRequest(bootstrapUrl, { includeFiltered: true }), null,
    "bootstrap HTML must not be captured as an offer page");
  assert.equal(parseResultRequest(bootstrapUrl, { includeBootstrap: true }).params.get("load_type"), "sub_step1");
  assert.equal(parseResultRequest(resultUrl("sub_step2"), { includeBootstrap: true }), null,
    "booking steps are outside search failure observation");

  const configArgs = ["--config", "vipcars.config.example.json"];
  assert.equal(loadConfig(configArgs).networkResults, false);
  assert.equal(loadConfig([...configArgs, "--network-results"]).networkResults, true);
  const page = new EventEmitter();
  const captured = captureInitialResults(page);
  const response = (method, status) => ({ url: () => url, status: () => status, text: async () => "fixture",
    request: () => ({ method: () => method, postData: () => null, headers: () => ({}) }) });
  page.emit("response", response("OPTIONS", 204));
  assert.equal(await captured.read(), undefined);
  page.emit("response", mockResponse(bootstrapUrl, "bootstrap-without-offers"));
  assert.equal(await captured.read(), undefined);
  page.emit("response", response("GET", 400));
  await assert.rejects(captured.read(), (error) => error.retryable === false);
  captured.detach();
  assert.equal(page.listenerCount("response"), 0);

  const observedHeaders = {
    accept: "text/html, */*; q=0.01",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    "cache-control": "no-cache",
    origin: "https://www.vipcars.com",
    referer: expected.href,
    "user-agent": "offline-test-browser",
    cookie: "private-cookie",
    authorization: "private-authorization",
    "x-private": "private-header"
  };
  const safeHeaders = Object.fromEntries([
    "accept", "content-type", "cache-control", "origin", "referer", "user-agent"
  ].map((name) => [name, observedHeaders[name]]));
  const unfilteredFirstUrl = resultUrl("get_result_desktop", 0, 0);
  const filteredNextUrl = resultUrl("get_result_desktop_filter", 10, 1);
  const filteredFirstUrl = resultUrl("get_result_desktop_filter", 0, 0);

  const filteredPage = new EventEmitter();
  const filteredCapture = captureInitialResults(filteredPage, { filtered: true });
  filteredPage.emit("response", mockResponse(unfilteredFirstUrl, "unfiltered-zero"));
  filteredPage.emit("response", mockResponse(filteredNextUrl, "filtered-next-page"));
  filteredPage.emit("response", mockResponse(filteredFirstUrl, "first-filtered", observedHeaders));
  filteredPage.emit("response", mockResponse(filteredFirstUrl, "second-filtered"));
  const filteredResult = await filteredCapture.read();
  assert.equal(filteredResult.html, "first-filtered");
  assert.equal(filteredResult.source.params.get("load_type"), "get_result_desktop_filter");
  assert.equal(filteredResult.source.params.get("offset"), "0");
  assert.equal(filteredResult.source.params.get("pickup_loc"), expected.searchParams.get("pickup_location"));
  assert.equal(filteredResult.source.params.get("currency"), "EUR");
  validateResultRequest(filteredResult.source, expected.href);
  assert.deepEqual(filteredResult.source.headers, safeHeaders);
  filteredCapture.detach();
  assert.equal(filteredPage.listenerCount("response"), 0);

  const implicitFilteredUrl = plainResultUrl("get_result_desktop_filter");
  const implicitFilteredPage = new EventEmitter();
  const implicitFilteredCapture = captureInitialResults(implicitFilteredPage, { filtered: true });
  implicitFilteredPage.emit("response", mockResponse(implicitFilteredUrl, "implicit-filtered"));
  const implicitFilteredResult = await implicitFilteredCapture.read();
  assert.equal(implicitFilteredResult.html, "implicit-filtered");
  assert.equal(implicitFilteredResult.source.params.has("offset"), false);
  assert.equal(implicitFilteredResult.source.params.has("car_page"), false);
  assert.doesNotThrow(() => validateResultRequest(implicitFilteredResult.source, expected.href));
  assert.throws(() => requestUrl(implicitFilteredResult.source, 10, 1), /cursor/);
  const nativeFilters = new URLSearchParams(parseResultRequest(implicitFilteredUrl, { includeFiltered: true }).params);
  nativeFilters.delete("load_type");
  nativeFilters.set("key", opaqueParams.get("key"));
  const nativeSource = parseResultRequest(`https://be.supplycars.com/be1/node.php?load_type=get_result_desktop_filter&${nativeFilters}&_=123`, { includeFiltered: true });
  const nativeData = { endpoint: "https://be.supplycars.com/be1/node.php", filters: nativeFilters.toString(), affiliate: "fixture-affiliate" };
  const nativePage = { evaluate: async () => nativeData };
  const paginationSource = await preparePaginationSource(nativePage, nativeSource);
  const implicitNextUrl = requestUrl(paginationSource, 10, 1);
  assert.equal(paginationSource.quoted, true);
  assert.equal(paginationSource.params.get("key"), opaqueParams.get("key"));
  assert.equal(paginationSource.params.has("_"), false);
  assert.equal(paginationSource.params.get("affiliate_cookie_data"), "fixture-affiliate");
  assert.equal(paginationSource.headers["content-type"], "application/json; charset=utf-8");
  validateResultRequest(paginationSource, expected.href);
  assert.equal(parseResultRequest(implicitNextUrl, { includeFiltered: true }).params.get("offset"), "10");
  assert.equal(await preparePaginationSource({ evaluate: () => { throw new Error("must not read page"); } }, paginationSource), paginationSource);
  await assert.rejects(preparePaginationSource({ evaluate: async () => null }, nativeSource), /unavailable/);
  await assert.rejects(preparePaginationSource({ evaluate: async () => ({ ...nativeData, endpoint: "https://other.example/node.php" }) }, nativeSource), /unavailable/);
  for (const [field, value] of [["currency", "USD"], ["pickup_date", "2027-01-01"], ["specs_checks", "manual"], ["supplier_checks", "only-one"]]) {
    const changedFilters = new URLSearchParams(nativeFilters);
    changedFilters.set(field, value);
    await assert.rejects(preparePaginationSource({ evaluate: async () => ({ ...nativeData, filters: changedFilters.toString() }) }, nativeSource), /changes.*search or filters/);
  }
  implicitFilteredCapture.detach();
  assert.equal(implicitFilteredPage.listenerCount("response"), 0);

  for (const partialUrl of [
    plainResultUrl("get_result_desktop_filter", { carPage: 0 }),
    plainResultUrl("get_result_desktop_filter", { offset: 0 })
  ]) {
    const partial = parseResultRequest(partialUrl, { includeFiltered: true });
    assert.ok(partial);
    assert.throws(() => validateResultRequest(partial, expected.href), /first page/i);
  }
  const implicitUnfiltered = parseResultRequest(plainResultUrl("get_result_desktop"));
  assert.ok(implicitUnfiltered);
  assert.throws(() => validateResultRequest(implicitUnfiltered, expected.href), /first page/i);

  const defaultPage = new EventEmitter();
  const defaultCapture = captureInitialResults(defaultPage);
  defaultPage.emit("response", mockResponse(filteredFirstUrl, "filtered-zero"));
  defaultPage.emit("response", mockResponse(unfilteredFirstUrl, "first-unfiltered"));
  defaultPage.emit("response", mockResponse(unfilteredFirstUrl, "second-unfiltered"));
  const defaultResult = await defaultCapture.read();
  assert.equal(defaultResult.html, "first-unfiltered");
  assert.equal(defaultResult.source.params.get("load_type"), "get_result_desktop");
  assert.equal(defaultResult.source.params.get("offset"), "0");
  validateResultRequest(defaultResult.source, expected.href);
  defaultCapture.detach();
  assert.equal(defaultPage.listenerCount("response"), 0);

  const allowed = new Set(["https://example.test/page"]);
  const request = (method) => ({ method: () => method, url: () => "https://example.test/page" });
  assert.equal(allowPaginationRequest(request("POST"), allowed), false);
  assert.equal(allowPaginationRequest(request("OPTIONS"), allowed), true);
  assert.equal(allowed.size, 1);
  assert.equal(allowPaginationRequest(request("GET"), allowed), true);
  assert.equal(allowPaginationRequest(request("GET"), allowed), false);
  const source = parseResultRequest(url);
  const wireUrl = new URL(url).href.replace(/%22$/, "&opaque=a%2526b%3Ac+value%22");
  assert.equal(requestUrl(parseResultRequest(wireUrl), 10, 2),
    wireUrl.replace("offset=0", "offset=10").replace("car_page=0", "car_page=2"));
  assert.equal(source.params.get("offset"), "0");
  validateResultRequest(source, expected.href);
  assert.equal(parseResultRequest(url.replace("be.supplycars.com", "example.com")), null);
  const wrong = parseResultRequest(url);
  wrong.params.set("currency", "USD");
  assert.throws(() => validateResultRequest(wrong, expected.href), /currency/);
  assert.throws(() => validateResultRequest(wrong, expected.href), (error) => !error.message.includes("private-test"));
  const duplicate = parseResultRequest(url);
  duplicate.params.append("pickup_loc", "667");
  assert.throws(() => validateResultRequest(duplicate, expected.href), /pickup_location/);
  const initial = { cards: [card(1), card(2)], totalCount: 3, nextOffset: 2, nextPage: 2 };
  const next = { cards: [card(3)], totalCount: 3, nextOffset: 4, nextPage: 3 };
  let calls = 0;
  const collect = (page = next) => collectResultPages({ initial, source, deadlineAt: Date.now() + 1000,
    fetchPage: async (requestUrl, timeout) => {
      calls += 1;
      const request = parseResultRequest(requestUrl);
      assert.equal(request.params.get("offset"), "2");
      assert.equal(request.params.get("car_page"), "2");
      assert.equal(request.params.get("key"), "private-test-session");
      assert.ok(timeout > 0 && timeout <= 1000);
      return page;
    }
  });
  assert.equal((await collect()).length, 3);
  assert.equal(calls, 1);
  const states = [];
  const diagnosticState = createAttemptDiagnostics({ location: "Warsaw" });
  const paged = await collectResultPages({ initial, source, deadlineAt: Date.now() + 1000,
    onState: (state) => { states.push(state); diagnosticState.recordResultState(state); },
    fetchPage: async () => next });
  assert.deepEqual(paged.map((offer) => offer.cardId), ["1", "2", "3"]);
  assert.deepEqual(states.map((state) => state.pageCount), [1, 2]);
  assert.equal(diagnosticState.snapshot().result_state.pageCount, 2);
  states.length = 0;
  await assert.rejects(collectResultPages({ initial, source, deadlineAt: Date.now() + 1000,
    onState: (state) => states.push(state), fetchPage: async () => ({ ...next, cards: [card(1)] }) }), /duplicate/i);
  assert.deepEqual(states.map((state) => state.pageCount), [1], "invalid pages must not count as collected");
  states.length = 0;
  await assert.rejects(collectResultPages({ initial: { ...initial, nextOffset: 3 }, source,
    deadlineAt: Date.now() + 1000, onState: (state) => states.push(state),
    fetchPage: async () => { throw new Error("must not fetch a skipped page"); } }), /skips/i);
  assert.deepEqual(states, [], "a page with a skipped cursor is not a validated page");
  await assert.rejects(collect({ ...next, totalCount: 4 }), /count/i);
  await assert.rejects(collect({ ...next, cards: [card(1)] }), /duplicate/i);
  await assert.rejects(collect({ ...next, cards: [] }), /empty/i);
  await assert.rejects(collect({ ...next, nextOffset: 2 }), /cursor/i);
  await assert.rejects(collect({ ...next, cards: [card(3), card(4)] }), /count/i);
  await assert.rejects(collectResultPages({ initial, source, deadlineAt: 0, fetchPage: async () => { throw new Error("must not fetch"); } }), /deadline/i);
  assert.doesNotThrow(() => compareVisibleCards([card(1)], [card(1)]));
  assert.throws(() => compareVisibleCards([card(1)], [{ ...card(1), payNowText: "Pay Now EUR 4.00" }]), /DOM/i);
  assert.throws(() => compareVisibleCards([card(1)], []), /DOM/i);
  const originalFetch = global.fetch;
  try {
    global.fetch = async (actualUrl, options) => {
      assert.equal(actualUrl, "https://example.test/fixture");
      assert.deepEqual(options.headers, { "content-type": "application/json" });
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      return { status: 200, text: async () => "fixture" };
    };
    assert.deepEqual(await fetchResultPage({ evaluate: (fn, args) => fn(args) }, "https://example.test/fixture", 1000,
      { "content-type": "application/json", cookie: "private-test-cookie", origin: "https://example.test" }),
    { status: 200, html: "fixture" });
    global.fetch = async (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    await assert.rejects(fetchResultPage({ evaluate: (fn, args) => fn(args) }, "https://example.test/fixture", 5), /aborted/);
  } finally { global.fetch = originalFetch; }
  console.log("PASS network pagination, search contract, completeness, deadline and DOM parity");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

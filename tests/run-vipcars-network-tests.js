const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { loadConfig } = require("../src/vipcars/config");
const { parseResultRequest, validateResultRequest, collectResultPages, compareVisibleCards, requestUrl, fetchResultPage, allowPaginationRequest, captureInitialResults } = require("../src/vipcars/resultTransport");

const expected = new URL("https://www.vipcars.com/search/?pickup_country=119&pickup_city=1744&pickup_location=10921&dropoff_country=119&dropoff_city=1744&dropoff_location=10921&pickup_date=2026-09-28&dropoff_date=2026-09-30&pickup_time=10%3A00&dropoff_time=10%3A00&currency=EUR&driver_age=30");
const params = new URLSearchParams(expected.search);
params.set("pickup_loc", params.get("pickup_location"));
params.set("dropoff_loc", params.get("dropoff_location"));
params.delete("pickup_location"); params.delete("dropoff_location");
params.set("load_type", "get_result_desktop"); params.set("offset", "0"); params.set("car_page", "0");
params.set("key", "private-test-session");
const url = `https://be.supplycars.com/be1/node.php?${JSON.stringify(`&${params}`)}`;
const card = (id) => ({ cardId: String(id), provider: "MM Cars Rental", priceText: "EUR 30.00", payNowText: "Pay Now EUR 3.00", automatic: true });

async function main() {
  const configArgs = ["--config", "vipcars.config.example.json"];
  assert.equal(loadConfig(configArgs).networkResults, false);
  assert.equal(loadConfig([...configArgs, "--network-results"]).networkResults, true);
  const page = new EventEmitter();
  const captured = captureInitialResults(page);
  const response = (method, status) => ({ url: () => url, status: () => status, text: async () => "fixture",
    request: () => ({ method: () => method, postData: () => null, headers: () => ({}) }) });
  page.emit("response", response("OPTIONS", 204));
  assert.equal(await captured.read(), undefined);
  page.emit("response", response("GET", 400));
  await assert.rejects(captured.read(), (error) => error.retryable === false);
  captured.detach();
  assert.equal(page.listenerCount("response"), 0);
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

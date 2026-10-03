const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { observeResultFailures } = require("../src/vipcars/resultTransport");

const RESULT_URL = "https://be.supplycars.com/be1/node.php?load_type=get_result_desktop_filter";

function requestEvent(requestId, url = RESULT_URL, method = "GET") {
  return { requestId, request: { url, method } };
}

function responseEvent(requestId, status, hasExtraInfo, headers = {}) {
  return { requestId, response: { status, headers }, hasExtraInfo };
}

function extraInfoEvent(requestId, statusCode, headers = {}) {
  return { requestId, statusCode, headers };
}

function loadingFailedEvent(requestId, options = {}) {
  return {
    requestId,
    type: "Fetch",
    errorText: options.errorText || "net::ERR_FAILED",
    canceled: options.canceled || false,
    corsErrorStatus: options.corsErrorStatus
  };
}

function cdpHarness(options = {}) {
  const page = new EventEmitter();
  const cdp = new EventEmitter();
  let detachCount = 0;
  cdp.send = options.send || (async () => {});
  cdp.detach = async () => { detachCount += 1; cdp.removeAllListeners(); };
  page.context = () => ({ newCDPSession: options.newCDPSession || (async () => cdp) });
  return { page, cdp, detachCount: () => detachCount };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function assertPending(promise, message) {
  const marker = Symbol("pending");
  const result = await Promise.race([
    promise.then(() => "resolved", () => "rejected"),
    new Promise((resolve) => setImmediate(() => resolve(marker)))
  ]);
  assert.equal(result, marker, message);
}

async function main() {
  for (const status of [200, 400]) {
    const { page, cdp } = cdpHarness();
    const failures = [];
    const observer = observeResultFailures(page, (error) => failures.push(error));
    await observer.ready;
    const url = new URL(`https://be.supplycars.com/be1/node.php?${JSON.stringify("&load_type=sub_step1&pickup_date=2026-10-05&currency=EUR&key=private-bootstrap")}`).href;
    cdp.emit("Network.requestWillBeSent", requestEvent("bootstrap", url));
    cdp.emit("Network.loadingFailed", loadingFailedEvent("bootstrap", {
      corsErrorStatus: { corsError: "MissingAllowOriginHeader" }
    }));
    assert.equal(failures.length, 0, "bootstrap CORS failures must wait for wire headers too");
    cdp.emit("Network.responseReceivedExtraInfo", extraInfoEvent("bootstrap", status,
      status === 400 ? { "Retry-After": "3600" } : {}));
    assert.equal(failures.length, 1, "a failed bootstrap must not wait for the search timeout");
    assert.equal(failures[0].code, status === 400 ? "SERVER_COOLDOWN" : "RESULT_TRANSPORT_INVALID");
    assert.doesNotMatch(failures[0].message, /private-bootstrap|pickup_date/);
    await observer.detach();
  }

  {
    const { page, cdp, detachCount } = cdpHarness();
    const failures = [];
    const observer = observeResultFailures(page, (error) => failures.push(error));
    assert.deepEqual(Object.keys(observer).sort(), ["correlate", "detach", "ready"]);
    await observer.ready;
    cdp.emit("Network.requestWillBeSent", requestEvent("delayed"));
    cdp.emit("Network.responseReceived", responseEvent("delayed", 400, true));
    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(failures.length, 0, "a declared extra-info event must not be preempted by a timer");
    cdp.emit("Network.responseReceivedExtraInfo", extraInfoEvent("delayed", 400, {
      "Retry-After": "3600",
      "Set-Cookie": "private-cookie"
    }));
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, "SERVER_COOLDOWN");
    assert.doesNotMatch(failures[0].message, /private-cookie|set-cookie/i);
    await observer.detach();
    assert.equal(detachCount(), 1);
  }

  {
    const { page, cdp } = cdpHarness();
    const sequence = [];
    const observer = observeResultFailures(page, (error) => sequence.push({ type: "callback", error }));
    await observer.ready;
    const correlated = observer.correlate(RESULT_URL, async () => {
      throw new Error(`Failed to fetch ${RESULT_URL}&secret=must-not-leak`);
    });
    correlated.catch((error) => sequence.push({ type: "rejection", error }));
    cdp.emit("Network.requestWillBeSent", requestEvent("correlated-cooldown"));
    cdp.emit("Network.responseReceived", responseEvent("correlated-cooldown", 400, true));
    await new Promise((resolve) => setTimeout(resolve, 160));
    await assertPending(correlated, "an operation rejection must wait for declared CDP extra-info");
    cdp.emit("Network.responseReceivedExtraInfo", extraInfoEvent("correlated-cooldown", 400, {
      "Retry-After": "3600"
    }));
    await assert.rejects(correlated, (error) => {
      assert.equal(error.code, "SERVER_COOLDOWN");
      return true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sequence.map(({ type }) => type), ["callback", "rejection"]);
    assert.strictEqual(sequence[0].error, sequence[1].error,
      "the callback and correlated wrapper must receive the same finalized error");
    await observer.detach();
  }

  {
    const { page, cdp } = cdpHarness();
    const observer = observeResultFailures(page, () => { throw new Error("must not report"); });
    await observer.ready;
    const expected = { status: 200, html: "complete" };
    const nonCanonicalUrl = "https://BE.SUPPLYCARS.COM:443/be1/../be1/node.php?load_type=get_result_desktop_filter";
    const correlated = observer.correlate(nonCanonicalUrl, async () => expected);
    cdp.emit("Network.requestWillBeSent", requestEvent("correlated-success"));
    cdp.emit("Network.responseReceived", responseEvent("correlated-success", 200, true));
    cdp.emit("Network.loadingFinished", { requestId: "correlated-success" });
    await assertPending(correlated, "success must wait for declared response extra-info");
    cdp.emit("Network.responseReceivedExtraInfo", extraInfoEvent("correlated-success", 200));
    assert.strictEqual(await correlated, expected);

    const secondUrl = `${RESULT_URL}&offset=10`;
    const waitsForFinish = observer.correlate(secondUrl, async () => "finished");
    cdp.emit("Network.requestWillBeSent", requestEvent("success-waits-for-finish", secondUrl));
    cdp.emit("Network.responseReceived", responseEvent("success-waits-for-finish", 200, true));
    cdp.emit("Network.responseReceivedExtraInfo", extraInfoEvent("success-waits-for-finish", 200));
    await assertPending(waitsForFinish, "success must also wait for loadingFinished");
    cdp.emit("Network.loadingFinished", { requestId: "success-waits-for-finish" });
    assert.equal(await waitsForFinish, "finished");
    await observer.detach();
  }

  {
    const { page, cdp } = cdpHarness();
    const observer = observeResultFailures(page, () => { throw new Error("must not report"); });
    await observer.ready;
    const correlated = observer.correlate(RESULT_URL, async () => "matched");
    const wrongUrl = `${RESULT_URL}&offset=10`;
    cdp.emit("Network.requestWillBeSent", requestEvent("wrong-url", wrongUrl));
    cdp.emit("Network.responseReceived", responseEvent("wrong-url", 200, false));
    cdp.emit("Network.loadingFinished", { requestId: "wrong-url" });
    await assertPending(correlated, "a different normalized URL must not claim the ticket");
    cdp.emit("Network.requestWillBeSent", requestEvent("right-url"));
    cdp.emit("Network.responseReceived", responseEvent("right-url", 200, false));
    cdp.emit("Network.loadingFinished", { requestId: "right-url" });
    assert.equal(await correlated, "matched");
    await observer.detach();
  }

  {
    const { page, cdp } = cdpHarness();
    const failures = [];
    const observer = observeResultFailures(page, (error) => failures.push(error));
    await observer.ready;
    const correlated = observer.correlate(RESULT_URL, async () => "get-only");
    cdp.emit("Network.requestWillBeSent", requestEvent("preflight", RESULT_URL, "OPTIONS"));
    cdp.emit("Network.responseReceived", responseEvent("preflight", 400, true));
    cdp.emit("Network.responseReceivedExtraInfo", extraInfoEvent("preflight", 400, {
      "Retry-After": "3600"
    }));
    cdp.emit("Network.loadingFinished", { requestId: "preflight" });
    await assertPending(correlated, "an OPTIONS preflight must not claim a GET correlation ticket");
    assert.deepEqual(failures, [], "an OPTIONS preflight must not report a GET result failure");
    cdp.emit("Network.requestWillBeSent", requestEvent("get-after-preflight"));
    cdp.emit("Network.responseReceived", responseEvent("get-after-preflight", 200, false));
    cdp.emit("Network.loadingFinished", { requestId: "get-after-preflight" });
    assert.equal(await correlated, "get-only");
    await observer.detach();
  }

  {
    const { page, cdp } = cdpHarness();
    const failures = [];
    const observer = observeResultFailures(page, (error) => failures.push(error));
    await observer.ready;
    const correlated = observer.correlate(RESULT_URL, async () => {
      throw new Error(`Failed to fetch ${RESULT_URL}&secret=must-not-leak`);
    });
    let rejected;
    correlated.catch((error) => { rejected = error; });
    cdp.emit("Network.requestWillBeSent", requestEvent("correlated-abort-after-reject"));
    await new Promise((resolve) => setImmediate(resolve));
    await assertPending(correlated, "the operation error must wait for a terminal request event");
    cdp.emit("Network.loadingFailed", loadingFailedEvent("correlated-abort-after-reject", {
      canceled: true,
      errorText: "net::ERR_ABORTED"
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rejected?.code, "RESULT_TRANSPORT_INVALID",
      "a correlated canceled request must settle with its completed safe operation error");
    assert.equal(rejected.retryable, true);
    assert.doesNotMatch(rejected.message, /secret|supplycars|node\.php/i);
    assert.deepEqual(failures, [], "correlated cancellation must not report a server failure");
    await observer.detach();
  }

  {
    const { page, cdp } = cdpHarness();
    const failures = [];
    const operation = deferred();
    const observer = observeResultFailures(page, (error) => failures.push(error));
    await observer.ready;
    const correlated = observer.correlate(RESULT_URL, () => operation.promise);
    let rejected;
    correlated.catch((error) => { rejected = error; });
    cdp.emit("Network.requestWillBeSent", requestEvent("correlated-abort-before-settle"));
    await new Promise((resolve) => setImmediate(resolve));
    cdp.emit("Network.loadingFailed", loadingFailedEvent("correlated-abort-before-settle", {
      canceled: true,
      errorText: "net::ERR_ABORTED"
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rejected?.code, "RESULT_TRANSPORT_INVALID",
      "a correlated cancellation must not wait for an unfinished operation");
    assert.equal(rejected.retryable, true);
    assert.match(rejected.message, /canceled/i);
    assert.deepEqual(failures, [], "correlated cancellation must not report a server failure");
    operation.reject(new Error("late private operation failure"));
    await new Promise((resolve) => setImmediate(resolve));
    await observer.detach();
  }

  {
    const { page, cdp } = cdpHarness();
    const failures = [];
    const observer = observeResultFailures(page, (error) => failures.push(error));
    await observer.ready;
    const correlated = observer.correlate(RESULT_URL, async () => "must not win");
    let settled;
    correlated.then(
      (value) => { settled = { value }; },
      (error) => { settled = { error }; }
    );
    cdp.emit("Network.requestWillBeSent", requestEvent("claimed-before-noise"));
    for (let index = 0; index < 300; index += 1) {
      cdp.emit("Network.responseReceived", responseEvent(`unrelated-${index}`, 200, false));
      cdp.emit("Network.loadingFinished", { requestId: `unrelated-${index}` });
    }
    cdp.emit("Network.responseReceived", responseEvent("claimed-before-noise", 400, true));
    cdp.emit("Network.responseReceivedExtraInfo", extraInfoEvent("claimed-before-noise", 400, {
      "Retry-After": "3600"
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled?.error?.code, "SERVER_COOLDOWN",
      "bounded unrelated CDP state must not evict an active correlation");
    assert.strictEqual(settled.error, failures[0]);
    await observer.detach();
  }

  {
    const { page, cdp } = cdpHarness();
    const observer = observeResultFailures(page, () => { throw new Error("must not report"); });
    await observer.ready;
    const timeout = new Error("Search attempt timeout exceeded.");
    timeout.code = "ATTEMPT_TIMEOUT";
    const correlated = observer.correlate(RESULT_URL, async () => { throw timeout; });
    cdp.emit("Network.requestWillBeSent", requestEvent("safe-operation-error"));
    cdp.emit("Network.responseReceived", responseEvent("safe-operation-error", 200, false));
    cdp.emit("Network.loadingFinished", { requestId: "safe-operation-error" });
    await assert.rejects(correlated, (error) => {
      assert.strictEqual(error, timeout, "a known sanitized operation error must retain its code and identity");
      return true;
    });
    await observer.detach();
  }

  {
    const { page } = cdpHarness();
    const observer = observeResultFailures(page, () => { throw new Error("must not report"); });
    await observer.ready;
    let operationCalled = false;
    const correlated = observer.correlate(`${RESULT_URL}#private-fragment`, async () => {
      operationCalled = true;
      throw new Error("private operation failure");
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(operationCalled, true);
    await assertPending(correlated, "an early operation error must remain held until lifecycle or cleanup");
    await observer.detach();
    await assert.rejects(correlated, (error) => {
      assert.equal(error.code, "RESULT_TRANSPORT_INVALID");
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, /private|supplycars|node\.php/i);
      return true;
    });
  }

  {
    const { page, cdp } = cdpHarness();
    const failures = [];
    const observer = observeResultFailures(page, (error) => failures.push(error));
    await observer.ready;
    cdp.emit("Network.requestWillBeSent", requestEvent("cors-200"));
    cdp.emit("Network.loadingFailed", loadingFailedEvent("cors-200", {
      corsErrorStatus: { corsError: "MissingAllowOriginHeader" }
    }));
    assert.equal(failures.length, 0, "a CORS failure must wait for its wire status");
    cdp.emit("Network.responseReceivedExtraInfo", extraInfoEvent("cors-200", 200));
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, "RESULT_TRANSPORT_INVALID");
    assert.equal(failures[0].retryable, true);
    await observer.detach();
  }

  {
    const { page, cdp } = cdpHarness();
    const failures = [];
    const observer = observeResultFailures(page, (error) => failures.push(error));
    await observer.ready;
    cdp.emit("Network.responseReceivedExtraInfo", extraInfoEvent("early", 400, { "Retry-After": "60" }));
    assert.equal(failures.length, 0);
    cdp.emit("Network.requestWillBeSent", requestEvent("early"));
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, "SERVER_COOLDOWN");
    await observer.detach();
  }

  {
    const { page, cdp } = cdpHarness();
    const failures = [];
    const observer = observeResultFailures(page, (error) => failures.push(error));
    await observer.ready;
    for (let index = 0; index < 300; index += 1) {
      cdp.emit("Network.responseReceivedExtraInfo", extraInfoEvent(`bounded-${index}`, 400, {
        "Retry-After": "60",
        "Set-Cookie": `private-${index}`
      }));
    }
    cdp.emit("Network.requestWillBeSent", requestEvent("bounded-0"));
    assert.equal(failures.length, 0, "old unmatched request state must be evicted");
    cdp.emit("Network.requestWillBeSent", requestEvent("bounded-299"));
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, "SERVER_COOLDOWN");
    assert.doesNotMatch(failures[0].message, /private-/);
    await observer.detach();
  }

  {
    const { page, cdp } = cdpHarness();
    const failures = [];
    const observer = observeResultFailures(page, (error) => failures.push(error));
    await observer.ready;
    cdp.emit("Network.requestWillBeSent", requestEvent("physical"));
    cdp.emit("Network.loadingFailed", loadingFailedEvent("physical", {
      errorText: "net::ERR_CONNECTION_RESET"
    }));
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, "RESULT_TRANSPORT_INVALID");
    assert.equal(failures[0].retryable, true);
    await observer.detach();
  }

  {
    const { page, cdp } = cdpHarness();
    const failures = [];
    const observer = observeResultFailures(page, (error) => failures.push(error));
    await observer.ready;
    cdp.emit("Network.requestWillBeSent", requestEvent("aborted"));
    cdp.emit("Network.loadingFailed", loadingFailedEvent("aborted", {
      canceled: true,
      errorText: "net::ERR_ABORTED"
    }));
    assert.deepEqual(failures, []);
    await observer.detach();
  }

  {
    const page = new EventEmitter();
    const setup = deferred();
    page.context = () => ({ newCDPSession: () => setup.promise });
    const observer = observeResultFailures(page, () => { throw new Error("must not report"); });
    let operationCalled = false;
    const correlated = observer.correlate(RESULT_URL, async () => {
      operationCalled = true;
      return "must not run";
    });
    assert.equal(operationCalled, false, "the request operation must not start before CDP metadata is ready");
    setup.reject(new Error("CDP setup rejected"));
    await assert.rejects(observer.ready, { message: "CDP setup rejected", retryable: true });
    await assert.rejects(correlated, { message: "CDP setup rejected", retryable: true });
    assert.equal(operationCalled, false);
    await observer.detach();
    assert.equal(page.listenerCount("requestfailed"), 0);
    assert.equal(page.listenerCount("response"), 0);
  }

  {
    const { page, detachCount } = cdpHarness({
      send: async () => { throw new Error("Network.enable rejected"); }
    });
    const observer = observeResultFailures(page, () => { throw new Error("must not report"); });
    await assert.rejects(observer.ready, { message: "Network.enable rejected", retryable: true });
    assert.equal(detachCount(), 1, "a partially initialized CDP session must be detached");
    await observer.detach();
    assert.equal(detachCount(), 1);
  }

  {
    let resolveSession;
    const pendingSession = new Promise((resolve) => { resolveSession = resolve; });
    const { page, cdp, detachCount } = cdpHarness({ newCDPSession: () => pendingSession });
    const observer = observeResultFailures(page, () => { throw new Error("must not report"); });
    await observer.detach();
    resolveSession(cdp);
    await observer.ready;
    assert.equal(detachCount(), 1, "a session created after detach must be detached immediately");
    assert.equal(cdp.listenerCount("Network.requestWillBeSent"), 0);
  }

  {
    const page = new EventEmitter();
    page.context = () => ({});
    const failures = [];
    const observer = observeResultFailures(page, (error) => failures.push(error));
    await observer.ready;
    const request = {
      url: () => RESULT_URL,
      resourceType: () => "xhr",
      failure: () => ({ errorText: "net::ERR_CONNECTION_RESET" })
    };
    page.emit("requestfailed", request);
    assert.equal(failures.length, 1);
    await observer.detach();
    assert.equal(page.listenerCount("requestfailed"), 0);
    assert.equal(page.listenerCount("response"), 0);
  }

  console.log("PASS correlated VipCars transport failure observation and cleanup");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});

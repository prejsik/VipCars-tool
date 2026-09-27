const { createCooldownError } = require("./requestCooldown");

const ENDPOINT = "https://be.supplycars.com/be1/node.php";
const CONTRACT_FIELDS = ["pickup_country", "pickup_city", "pickup_location", "dropoff_country",
  "dropoff_city", "dropoff_location", "pickup_date", "dropoff_date", "pickup_time", "dropoff_time", "currency", "driver_age"];

function transportError(message, retryable = false) {
  const error = new Error(message);
  error.code = "RESULT_TRANSPORT_INVALID";
  error.retryable = retryable;
  return error;
}

function parseResultRequest(value, { includeFiltered = false } = {}) {
  try {
    const url = new URL(value);
    if (`${url.origin}${url.pathname}` !== ENDPOINT) return null;
    let query = url.search.slice(1);
    if (query.startsWith("%22")) query = decodeURIComponent(query);
    const quoted = query.startsWith('"');
    if (quoted) query = JSON.parse(query);
    const params = new URLSearchParams(query);
    const loadType = params.get("load_type");
    if (loadType !== "get_result_desktop" && !(includeFiltered && loadType === "get_result_desktop_filter")) return null;
    return { params, quoted, url: url.href };
  } catch {
    return null;
  }
}

function observeResultFailures(page, onFailure) {
  let detached = false;
  let cdp;
  let cdpDetached = false;
  let cdpHandlers;
  const httpFailure = (status, headers) => createCooldownError(status, headers)
    || transportError(`VipCars result request returned HTTP ${status}.`, status >= 500 || status === 429);
  const networkFailure = () => transportError(
    "VipCars result request failed before a complete response was received.", true);
  const canceledFailure = () => transportError(
    "VipCars result request observation ended before completion.", true);
  const canceledRequestFailure = () => transportError(
    "VipCars result request was canceled before completion.", true);
  const safeOperationError = (error) => ["RESULT_TRANSPORT_INVALID", "SERVER_COOLDOWN", "ATTEMPT_TIMEOUT"].includes(error?.code)
    ? error : networkFailure();
  const normalizedUrl = (value) => {
    try {
      return new URL(value).href;
    } catch {
      throw transportError("Invalid VipCars result request URL.");
    }
  };
  const isResult = (request) => ["xhr", "fetch"].includes(request.resourceType())
    && parseResultRequest(request.url(), { includeFiltered: true });
  const context = page.context?.();

  if (!context || typeof context.newCDPSession !== "function") {
    const failed = (request) => {
      if (!isResult(request) || request.failure()?.errorText === "net::ERR_ABORTED") return;
      if (!detached) onFailure(networkFailure());
    };
    const responded = (response) => {
      if (!isResult(response.request()) || response.status() < 400 || detached) return;
      onFailure(httpFailure(response.status(), response.headers?.() || {}));
    };
    page.on("requestfailed", failed);
    page.on("response", responded);
    return {
      ready: Promise.resolve(),
      correlate: async (url, operation) => {
        normalizedUrl(url);
        if (detached) throw canceledFailure();
        try {
          return await operation();
        } catch (error) {
          throw safeOperationError(error);
        }
      },
      detach: async () => {
        detached = true;
        page.removeListener("requestfailed", failed);
        page.removeListener("response", responded);
      }
    };
  }

  const requests = new Map();
  const tickets = new Set();
  const pendingByUrl = new Map();
  const settleTicket = (ticket, error, value) => {
    if (!ticket || ticket.settled) return;
    ticket.settled = true;
    tickets.delete(ticket);
    if (pendingByUrl.get(ticket.url) === ticket) pendingByUrl.delete(ticket.url);
    if (error) ticket.reject(error);
    else ticket.resolve(value);
  };
  const advanceTicket = (ticket) => {
    if (!ticket || ticket.settled || !ticket.operationDone || !ticket.lifecycleDone) return;
    if (ticket.operationError) settleTicket(ticket, ticket.operationError);
    else settleTicket(ticket, null, ticket.operationValue);
  };
  const completeTicket = (ticket) => {
    if (!ticket || ticket.settled) return;
    ticket.lifecycleDone = true;
    advanceTicket(ticket);
  };
  const stateFor = (requestId) => {
    let state = requests.get(requestId);
    if (!state) {
      if (requests.size >= 256) {
        const evictable = [...requests].find(([, candidate]) => !candidate.ticket || candidate.ticket.settled);
        if (!evictable) return {};
        requests.delete(evictable[0]);
      }
      state = {};
      requests.set(requestId, state);
    }
    return state;
  };
  const finish = (requestId, state, error) => {
    if (state.reported) return;
    state.reported = true;
    if (state.terminal) requests.delete(requestId);
    if (!detached) {
      try {
        onFailure(error);
      } finally {
        settleTicket(state.ticket, error);
      }
    }
  };
  const advance = (requestId, state) => {
    if (state.isResult === false) {
      requests.delete(requestId);
      return;
    }
    if (state.aborted) {
      requests.delete(requestId);
      if (state.ticket) {
        const error = state.ticket.operationDone && state.ticket.operationError
          ? state.ticket.operationError : canceledRequestFailure();
        settleTicket(state.ticket, error);
      }
      return;
    }
    if (state.isResult !== true) return;
    if (state.reported) {
      if (state.terminal) requests.delete(requestId);
      return;
    }
    if (state.extraError) {
      finish(requestId, state, state.extraError);
      return;
    }
    if (state.physicalFailure) {
      finish(requestId, state, state.physicalFailure);
      return;
    }
    if (state.corsFailure) {
      if (state.extraSeen) finish(requestId, state, networkFailure());
      return;
    }
    if (state.responseError) {
      if (!state.responseHasExtraInfo || state.extraSeen) {
        finish(requestId, state, state.responseError);
      }
      return;
    }
    if (state.terminal && state.responseSeen && (!state.responseHasExtraInfo || state.extraSeen)) {
      completeTicket(state.ticket);
      requests.delete(requestId);
    }
  };

  const requestWillBeSent = ({ requestId, request }) => {
    const state = stateFor(requestId);
    state.isResult = request.method === "GET"
      && Boolean(parseResultRequest(request.url, { includeFiltered: true }));
    if (state.isResult) {
      let url;
      try {
        url = normalizedUrl(request.url);
      } catch {
        url = null;
      }
      const ticket = url ? pendingByUrl.get(url) : null;
      if (ticket && !ticket.settled) {
        pendingByUrl.delete(url);
        ticket.requestId = requestId;
        state.ticket = ticket;
      }
    }
    advance(requestId, state);
  };
  const responseReceived = ({ requestId, response, hasExtraInfo }) => {
    const state = stateFor(requestId);
    state.responseSeen = true;
    state.responseHasExtraInfo = hasExtraInfo === true;
    state.responseError = response.status >= 400
      ? httpFailure(response.status, state.responseHasExtraInfo ? {} : (response.headers || {}))
      : null;
    advance(requestId, state);
  };
  const responseReceivedExtraInfo = ({ requestId, statusCode, headers }) => {
    const state = stateFor(requestId);
    state.extraSeen = true;
    state.extraError = statusCode >= 400 ? httpFailure(statusCode, headers || {}) : null;
    advance(requestId, state);
  };
  const loadingFailed = ({ requestId, errorText, canceled, corsErrorStatus }) => {
    const state = stateFor(requestId);
    state.terminal = true;
    if (canceled === true || errorText === "net::ERR_ABORTED") state.aborted = true;
    else if (corsErrorStatus) state.corsFailure = true;
    else state.physicalFailure = networkFailure();
    advance(requestId, state);
  };
  const loadingFinished = ({ requestId }) => {
    const state = stateFor(requestId);
    state.terminal = true;
    advance(requestId, state);
  };
  cdpHandlers = {
    "Network.requestWillBeSent": requestWillBeSent,
    "Network.responseReceived": responseReceived,
    "Network.responseReceivedExtraInfo": responseReceivedExtraInfo,
    "Network.loadingFailed": loadingFailed,
    "Network.loadingFinished": loadingFinished
  };

  const detachSession = async () => {
    if (!cdp || cdpDetached) return;
    cdpDetached = true;
    for (const [event, handler] of Object.entries(cdpHandlers)) cdp.removeListener(event, handler);
    requests.clear();
    await cdp.detach().catch(() => {});
  };
  const ready = (async () => {
    try {
      cdp = await context.newCDPSession(page);
      if (detached) {
        await detachSession();
        return;
      }
      for (const [event, handler] of Object.entries(cdpHandlers)) cdp.on(event, handler);
      await cdp.send("Network.enable");
    } catch (error) {
      await detachSession();
      if (!detached) {
        error.retryable = true;
        throw error;
      }
    }
    if (detached) await detachSession();
  })();
  const correlate = (url, operation) => {
    let normalized;
    try {
      normalized = normalizedUrl(url);
    } catch (error) {
      return Promise.reject(error);
    }
    if (detached) return Promise.reject(canceledFailure());
    if (tickets.size >= 256 || pendingByUrl.has(normalized)) {
      return Promise.reject(transportError("Too many pending VipCars result request observations.", true));
    }
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const ticket = { url: normalized, resolve, reject, settled: false };
    tickets.add(ticket);
    pendingByUrl.set(normalized, ticket);
    ready.then(() => {
      if (ticket.settled) return;
      if (detached) {
        settleTicket(ticket, canceledFailure());
        return;
      }
      Promise.resolve().then(operation).then((value) => {
        ticket.operationDone = true;
        ticket.operationValue = value;
        advanceTicket(ticket);
      }, (error) => {
        ticket.operationDone = true;
        ticket.operationError = safeOperationError(error);
        advanceTicket(ticket);
      });
    }, (error) => settleTicket(ticket, error));
    return promise;
  };

  return {
    ready,
    correlate,
    detach: async () => {
      detached = true;
      for (const ticket of [...tickets]) settleTicket(ticket, canceledFailure());
      requests.clear();
      await detachSession();
    }
  };
}

function validateResultRequest(source, expectedUrl) {
  const expected = new URL(expectedUrl).searchParams;
  for (const field of CONTRACT_FIELDS) {
    const key = field.replace(/_location$/, "_loc");
    const values = [...new Set(source.params.getAll(key))];
    if (!expected.get(field) || values.length !== 1 || values[0] !== expected.get(field)) {
      throw transportError(`Result request contract mismatch: ${field}.`);
    }
  }
  if (!isInitialPage(source)) {
    throw transportError("Result request must start on the first page.");
  }
}

function requestUrl(source, offset, page) {
  // The endpoint embeds an encoded query inside JSON; preserve opaque session values byte-for-byte.
  let url = source.url;
  if (isImplicitFilteredFirstPage(source) && !source.quoted) {
    return `${url}&offset=${offset}&car_page=${page}`;
  }
  for (const [key, value] of [["offset", offset], ["car_page", page]]) {
    const pattern = new RegExp(`([?&]${key}=)\\d+(?=&|%22|$)`, "g");
    if ([...url.matchAll(pattern)].length !== 1) throw transportError("Ambiguous result request cursor.");
    url = url.replace(pattern, (match, prefix) => `${prefix}${value}`);
  }
  return url;
}

function captureInitialResults(page, { filtered = false } = {}) {
  let captured;
  const listener = (response) => {
    const source = parseResultRequest(response.url(), { includeFiltered: filtered });
    const loadType = filtered ? "get_result_desktop_filter" : "get_result_desktop";
    if (captured || !source || source.params.get("load_type") !== loadType || !isInitialPage(source)) return;
    const request = response.request();
    if (request.method() === "OPTIONS") return;
    if (request.method() !== "GET" || request.postData()) {
      captured = Promise.resolve({ error: transportError("Unexpected result request method or body.") });
      return;
    }
    const headers = request.headers();
    source.headers = Object.fromEntries(["accept", "content-type", "cache-control", "origin", "referer", "user-agent"]
      .filter((name) => headers[name] !== undefined).map((name) => [name, headers[name]]));
    captured = response.text().then((html) => {
      if (response.status() !== 200) throw transportError("Initial result response was not successful.", response.status() >= 500);
      return { source, html };
    }).catch((error) => ({ error: error.code === "RESULT_TRANSPORT_INVALID" ? error
      : transportError("Initial result response could not be read.", true) }));
  };
  page.on("response", listener);
  return { read: async () => {
    const result = await captured;
    if (result?.error) throw result.error;
    return result;
  }, detach: () => page.off("response", listener) };
}

function isImplicitFilteredFirstPage(source) {
  return source.params.get("load_type") === "get_result_desktop_filter"
    && !source.params.has("offset") && !source.params.has("car_page");
}

function isInitialPage(source) {
  return isImplicitFilteredFirstPage(source)
    || (source.params.get("offset") === "0" && source.params.get("car_page") === "0");
}

function allowPaginationRequest(request, allowedUrls) {
  const url = request.url();
  if (!allowedUrls.has(url)) return false;
  if (request.method() === "OPTIONS") return true;
  return request.method() === "GET" && allowedUrls.delete(url);
}

function compareVisibleCards(network, visible) {
  const fields = ["cardId", "provider", "rating", "priceText", "payNowText", "carName", "transmission", "automatic", "vehicleCategory"];
  if (network.length !== visible.length || !network.length) {
    throw transportError("Result response and visible DOM card counts differ.");
  }
  for (let index = 0; index < network.length; index += 1) {
    if (fields.some((field) => network[index][field] !== visible[index][field])) {
      throw transportError("Result response and visible DOM offer values differ.");
    }
  }
}

async function fetchResultPage(page, url, timeout, observedHeaders = {}) {
  const headers = Object.fromEntries(["accept", "content-type", "cache-control"]
    .filter((name) => observedHeaders[name] !== undefined).map((name) => [name, observedHeaders[name]]));
  return page.evaluate(async ({ url, timeout, headers }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { headers, signal: controller.signal, redirect: "error" });
      return { status: response.status, html: await response.text() };
    } finally {
      clearTimeout(timer);
    }
  }, { url, timeout, headers });
}

async function collectResultPages({ initial, source, deadlineAt, fetchPage, onState }) {
  const cards = [];
  const ids = new Set();
  const total = initial.totalCount;
  let batch = initial;
  let offset = 0;
  let page = 0;
  if (!Number.isSafeInteger(total) || total <= 0) throw transportError("Invalid result count.");
  while (true) {
    if (batch.totalCount !== total) throw transportError("Result count changed during pagination.", true);
    if (!batch.cards.length) throw transportError("Empty result page before completion.", true);
    if (!Number.isSafeInteger(batch.nextOffset) || batch.nextOffset <= offset ||
        !Number.isSafeInteger(batch.nextPage) || batch.nextPage <= page) {
      throw transportError("Result cursor did not advance.");
    }
    for (const card of batch.cards) {
      if (!card.cardId || ids.has(card.cardId)) throw transportError("Missing or duplicate result card identity.");
      ids.add(card.cardId);
      cards.push(card);
    }
    if (cards.length > total) throw transportError("Result count exceeded expected total.");
    onState?.({ cardCount: cards.length, totalCount: total, busy: cards.length < total });
    if (cards.length === total) return cards;
    if (batch.nextOffset !== cards.length) throw transportError("Result cursor skips uncollected offers.");
    offset = batch.nextOffset;
    page = batch.nextPage;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw transportError("Result pagination deadline reached.", true);
    batch = await fetchPage(requestUrl(source, offset, page), remaining);
  }
}

module.exports = { parseResultRequest, validateResultRequest, captureInitialResults,
  compareVisibleCards, collectResultPages, transportError, requestUrl, fetchResultPage, allowPaginationRequest,
  observeResultFailures };

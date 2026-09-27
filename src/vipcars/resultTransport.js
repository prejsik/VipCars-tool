const ENDPOINT = "https://be.supplycars.com/be1/node.php";
const CONTRACT_FIELDS = ["pickup_country", "pickup_city", "pickup_location", "dropoff_country",
  "dropoff_city", "dropoff_location", "pickup_date", "dropoff_date", "pickup_time", "dropoff_time", "currency", "driver_age"];

function transportError(message, retryable = false) {
  const error = new Error(message);
  error.code = "RESULT_TRANSPORT_INVALID";
  error.retryable = retryable;
  return error;
}

function parseResultRequest(value) {
  try {
    const url = new URL(value);
    if (`${url.origin}${url.pathname}` !== ENDPOINT) return null;
    let query = url.search.slice(1);
    if (query.startsWith("%22")) query = decodeURIComponent(query);
    const quoted = query.startsWith('"');
    if (quoted) query = JSON.parse(query);
    const params = new URLSearchParams(query);
    if (params.get("load_type") !== "get_result_desktop") return null;
    return { params, quoted, url: url.href };
  } catch {
    return null;
  }
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
  if (source.params.get("offset") !== "0" || source.params.get("car_page") !== "0") {
    throw transportError("Result request must start on the first page.");
  }
}

function requestUrl(source, offset, page) {
  // The endpoint embeds an encoded query inside JSON; preserve opaque session values byte-for-byte.
  let url = source.url;
  for (const [key, value] of [["offset", offset], ["car_page", page]]) {
    const pattern = new RegExp(`([?&]${key}=)\\d+(?=&|%22|$)`, "g");
    if ([...url.matchAll(pattern)].length !== 1) throw transportError("Ambiguous result request cursor.");
    url = url.replace(pattern, (match, prefix) => `${prefix}${value}`);
  }
  return url;
}

function captureInitialResults(page) {
  let captured;
  const listener = (response) => {
    const source = parseResultRequest(response.url());
    if (captured || !source || source.params.get("offset") !== "0") return;
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
  compareVisibleCards, collectResultPages, transportError, requestUrl, fetchResultPage, allowPaginationRequest };

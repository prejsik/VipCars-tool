const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const { parseResultRequest } = require("../src/vipcars/resultTransport");
const { VipCarsScraper } = require("../src/vipcars/scraper");

const SESSION_KEY = "private&nested=one%2Btwo";

const SEARCH_URL = [
  "https://www.vipcars.com/search/?aff=vipcars_web",
  "language=en",
  "googlemap=1",
  "pickup_country=119",
  "pickup_city=1744",
  "pickup_location=10921",
  "dropoff_country=119",
  "dropoff_city=1744",
  "dropoff_location=10921",
  "pickup_date=2026-10-02",
  "pickup_time=10%3A00",
  "dropoff_date=2026-10-04",
  "dropoff_time=10%3A00",
  "rc=pl",
  "currency=EUR",
  "drv_age_chk=1",
  "driver_age=30",
  "page=search"
].join("&");

function resultRequestUrl() {
  const expected = new URL(SEARCH_URL);
  const params = new URLSearchParams(expected.search);
  params.set("pickup_loc", params.get("pickup_location"));
  params.set("dropoff_loc", params.get("dropoff_location"));
  params.delete("pickup_location");
  params.delete("dropoff_location");
  params.set("load_type", "get_result_desktop");
  params.set("offset", "0");
  params.set("car_page", "0");
  params.set("key", SESSION_KEY);
  return `https://be.supplycars.com/be1/node.php?${JSON.stringify(`&${params}`)}`;
}

function cardHtml({ id, provider, price, payNow, name, automatic }) {
  return `<article class="scv-car-box" id="${id}">
    <div class="scv-supp-info"><img alt="${provider}"></div>
    <span id="supplier_rating_${id}">8.5</span>
    <div class="scv-new-amount">${price}</div>
    <div class="scv-pay-now">${payNow}</div>
    <div class="scv-car-name">${name}</div>
    <ul class="scv-car-specs"><li>${automatic ? '<i class="scv-icon autom"></i>Automatic transmission' : "Manual transmission"}</li></ul>
    <div class="scv-car-cat">Economy</div>
  </article>`;
}

function resultPage(cards, { offset, page, total }) {
  return `${cards.join("")}
    <script>
      $("#offset").val(${offset});
      $("#car_page").val(${page});
      $("#car_count_data").val(${total});
    </script>`;
}

function bootstrapPage(initialUrl) {
  return `<!doctype html><html><head><style>
    .scv-car-box { display: block; width: 240px; height: 80px; }
  </style></head><body>
    <input id="pickup_country" value="119">
    <input id="pickup_city" value="1744">
    <input id="pickup_location" value="10921">
    <input id="dropoff_country" value="119">
    <input id="dropoff_city" value="1744">
    <input id="dropoff_location" value="10921">
    <input id="pickdate" value="2026-10-02">
    <input id="dropdate" value="2026-10-04">
    <input id="time_pickup" value="10:00">
    <input id="time_dropoff" value="10:00">
    <input name="currency" value="EUR">
    <input id="page_busy" value="1">
    <span id="car_count_data">3</span>
    <div id="results"></div>
    <script>
      fetch(${JSON.stringify(initialUrl)})
        .then((response) => response.text())
        .then((html) => {
          document.getElementById("results").innerHTML = html;
          document.getElementById("page_busy").value = "0";
        });
    </script>
  </body></html>`;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vipcars-network-runtime-"));
  const initialUrl = resultRequestUrl();
  const initialHtml = resultPage([
    cardHtml({
      id: "offer-1", provider: "MM Cars Rental", price: "EUR 30.00",
      payNow: "Pay Now EUR 3.00", name: "Automatic One", automatic: true
    }),
    cardHtml({
      id: "offer-2", provider: "Manual Rival", price: "EUR 20.00",
      payNow: "", name: "Manual Two", automatic: false
    })
  ], { offset: 2, page: 1, total: 3 });
  const nextHtml = resultPage([
    cardHtml({
      id: "offer-3", provider: "Automatic Rival", price: "€ 25.00",
      payNow: "Pay Now € 2.50", name: "Automatic Three", automatic: true
    })
  ], { offset: 3, page: 2, total: 3 });
  const unexpectedRequests = [];
  const paginationRequests = [];

  const browserAdapter = {
    async newContext(options) {
      const context = await browser.newContext(options);
      return {
        addCookies: (...args) => context.addCookies(...args),
        newPage: (...args) => context.newPage(...args),
        close: (...args) => context.close(...args),
        route(pattern, handler) {
          return context.route(pattern, (route) => {
            const requestUrl = route.request().url();
            const adapter = {
              request: () => route.request(),
              abort: (...args) => route.abort(...args),
              continue: async () => {
                if (requestUrl === SEARCH_URL) {
                  await route.fulfill({ status: 200, contentType: "text/html", body: bootstrapPage(initialUrl) });
                  return;
                }
                const parsed = parseResultRequest(requestUrl);
                if (parsed && parsed.params.get("offset") === "0") {
                  await route.fulfill({
                    status: 200,
                    contentType: "text/html",
                    headers: { "access-control-allow-origin": "*" },
                    body: initialHtml
                  });
                  return;
                }
                if (parsed && parsed.params.get("offset") === "2") {
                  assert.equal(parsed.params.get("car_page"), "1");
                  paginationRequests.push(requestUrl);
                  await route.fulfill({ status: 200, contentType: "text/html",
                    headers: { "access-control-allow-origin": "*" }, body: nextHtml });
                  return;
                }
                unexpectedRequests.push(requestUrl);
                await route.abort();
              }
            };
            return handler(adapter);
          });
        }
      };
    }
  };

  const scraper = new VipCarsScraper({
    baseUrl: "https://www.vipcars.com",
    pickupDate: "2026-10-02",
    dropoffDate: "2026-10-04",
    pickupTime: "10:00",
    dropoffTime: "10:00",
    currentDurationDays: 2,
    driverAge: 30,
    currency: "EUR",
    transmission: "automatic",
    networkResults: true,
    vehicleCategory: "",
    maxProvidersPerLocation: 25,
    timeoutMs: 2000,
    attemptBudgetMs: 5000,
    artifactsDir
  });
  const extractSearchOffers = scraper.extractSearchOffers.bind(scraper);
  scraper.extractSearchOffers = async (page, location, networkCards) => {
    assert.deepEqual(networkCards.map((card) => card.cardId), ["offer-1", "offer-2", "offer-3"]);
    return extractSearchOffers(page, location, networkCards);
  };

  try {
    assert.equal(scraper.buildSearchUrl("Warsaw"), SEARCH_URL);
    const outcome = await scraper.runSingleLocation(browserAdapter, "Warsaw", {
      attempt: 1,
      deadlineAt: Date.now() + 5000
    });
    assert.equal(outcome.ok, true, outcome.error?.stack || outcome.error?.message);
    assert.equal(paginationRequests.length, 1);
    const expectedPaginationUrl = new URL(initialUrl).href
      .replace("offset=0", "offset=2")
      .replace("car_page=0", "car_page=1");
    assert.equal(paginationRequests[0], expectedPaginationUrl);
    assert.deepEqual(unexpectedRequests, []);
    assert.deepEqual(outcome.results.map((offer) => offer.provider), [
      "Automatic Rival",
      "MM Cars Rental"
    ]);
    assert.deepEqual(outcome.results.map((offer) => offer.total_price), [25, 30]);
    assert.deepEqual(outcome.results.map((offer) => offer.currency), ["EUR", "EUR"]);
    assert.deepEqual(outcome.results.map((offer) => offer.pay_now_currency), ["EUR", "EUR"]);
    assert.equal(outcome.results.some((offer) => offer.provider === "Manual Rival"), false);
    console.log("PASS offline Chromium network capture, pagination, contract and local filtering");
  } finally {
    await browser.close();
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});

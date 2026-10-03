const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { VipCarsScraper } = require("../src/vipcars/scraper");
const { parseResultRequest } = require("../src/vipcars/resultTransport");

function card(id, provider, price, automatic = true) {
  return `<article class="scv-car-box" id="${id}">
    <div class="scv-supp-info"><img alt="${provider}"></div>
    <div class="scv-car-name">Fixture car</div><div class="scv-car-cat">Economy</div>
    <div class="scv-new-amount">EUR ${price.toFixed(2)}</div><div class="scv-pay-now">Pay Now EUR ${(price / 10).toFixed(2)}</div>
    <ul class="scv-car-specs"><li>${automatic ? '<i class="scv-icon autom"></i>Automatic' : 'Manual'} transmission</li></ul>
  </article>`;
}

function pageHtml(cards, nextOffset, nextPage, total) {
  return cards.join("") + `<script>$("#offset").val(${nextOffset});$("#car_page").val(${nextPage});
    $("#car_count_data").val(${total});window.unwantedPaginationScript = true;</script>`;
}

function bootstrap(initialUrl, filteredUrl, empty) {
  return `<!doctype html><style>.scv-car-box{display:block;width:240px;height:80px}</style>
    <input id="pickup_country" value="119"><input id="dropoff_country" value="119">
    <input id="pickup_city" value="1744"><input id="dropoff_city" value="1744">
    <input id="pickup_location" value="10921"><input id="dropoff_location" value="10921">
    <input id="pickdate" value="2026-10-02"><input id="dropdate" value="2026-10-04">
    <input id="time_pickup" value="10:00"><input id="time_dropoff" value="10:00">
    <input name="currency" value="EUR"><input id="page_busy" value="1">
    <input id="price_range" value="${new URL(filteredUrl).searchParams.get("price_range")}" data-slider-min="0" data-slider-max="1000">
    <input id="filter_automatic" type="checkbox"><span id="car_count_data">4</span><div id="results"></div>
    <script>
      window.SITE_URL = 'https://be.supplycars.com/be1';
      window.affiliate_cookie_data = 'fixture-affiliate';
      window.create_filter_data_ajax = () => {
        const params = new URL(${JSON.stringify(filteredUrl)}).searchParams;
        params.delete('load_type');
        return params.toString();
      };
      const show = async (url, total) => {
        document.getElementById('page_busy').value = '1';
        const response = await fetch(url);
        document.getElementById('results').innerHTML = await response.text();
        document.getElementById('car_count_data').textContent = total;
        document.getElementById('page_busy').value = '0';
      };
      document.getElementById('filter_automatic').addEventListener('change', () => show(${JSON.stringify(filteredUrl)}, ${empty ? 0 : 4}));
      show(${JSON.stringify(initialUrl)}, 4);
    </script>`;
}

async function runCase(browser, scenario) {
  const empty = scenario.includes("empty");
  const wrongFilter = scenario.includes("wrong-filter");
  const narrowPrice = scenario.includes("narrow-price");
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vipcars-filtered-test-"));
  const config = { baseUrl: "https://www.vipcars.com", pickupDate: "2026-10-02", dropoffDate: "2026-10-04",
    pickupTime: "10:00", dropoffTime: "10:00", currentDurationDays: 2, driverAge: 30, currency: "EUR",
    transmission: "automatic", networkResults: true, maxProvidersPerLocation: 25,
    timeoutMs: 2000, attemptBudgetMs: 12000, artifactsDir };
  const scraper = new VipCarsScraper(config);
  const searchUrl = scraper.buildSearchUrl("Warsaw");
  const params = new URL(searchUrl).searchParams;
  for (const direction of ["pickup", "dropoff"]) {
    params.set(`${direction}_loc`, params.get(`${direction}_location`));
    params.delete(`${direction}_location`);
  }
  params.set("key", "opaque-test-session");
  params.set("load_type", "get_result_desktop");
  params.set("offset", "0"); params.set("car_page", "0");
  const initialUrl = `https://be.supplycars.com/be1/node.php?${params}`;
  params.set("load_type", "get_result_desktop_filter");
  params.set("specs_checks", wrongFilter ? "manual" : "automatic");
  params.set("price_range", narrowPrice ? "0,30" : "0,1000");
  params.delete("offset"); params.delete("car_page");
  const filteredUrl = `https://be.supplycars.com/be1/node.php?${params}`;
  let filteredRequests = 0;
  let nonNativePagination = 0;
  let unfilteredPagination = 0;
  let livePage;
  const observations = [];
  const originalExtract = scraper.extractSearchOffers.bind(scraper);
  scraper.extractSearchOffers = async (page, location, raw) => {
    assert.equal(await page.locator(".scv-car-box").count(), empty ? 0 : 2,
      "subsequent result pages must not grow the live DOM");
    assert.equal(await page.evaluate(() => window.unwantedPaginationScript), undefined);
    if (!empty) assert.equal(raw.length, 4);
    return originalExtract(page, location, raw);
  };
  const adapter = { async newContext(options) {
    const context = await browser.newContext(options);
    return {
      addCookies: (...args) => context.addCookies(...args), close: () => context.close(),
      newPage: async () => { const page = await context.newPage(); livePage ||= page; return page; },
      route: (pattern, handler) => context.route(pattern, (route) => handler({
        request: () => route.request(), abort: (...args) => route.abort(...args),
        continue: async () => {
          const url = route.request().url();
          if (url === searchUrl) return route.fulfill({ status: 200, contentType: "text/html",
            body: bootstrap(initialUrl, filteredUrl, empty) });
          const source = parseResultRequest(url, { includeFiltered: true });
          let html;
          if (!source) return route.abort("aborted");
          if (source.params.get("load_type") === "get_result_desktop") {
            if (source.params.get("offset") !== "0") {
              unfilteredPagination++;
              return route.fulfill({ status: 400, body: "Unfiltered pagination is not expected" });
            }
            html = pageHtml([card("u1", "Manual Rival", 10, false), card("u2", "MM Cars Rental", 40)], 2, 1, 4);
          } else {
            filteredRequests++;
            if (source.params.has("offset")) {
              const headers = route.request().headers();
              if (!source.quoted || source.params.get("affiliate_cookie_data") !== "fixture-affiliate"
                  || headers["content-type"] !== "application/json; charset=utf-8"
                  || headers["cache-control"] !== "no-cache") {
                nonNativePagination++;
                return route.fulfill({ status: 400, headers: { "access-control-allow-origin": "*" },
                  body: "Pagination must use the site's continuation request." });
              }
            }
            observations.push({ offset: source.params.get("offset"), key: source.params.get("key") });
            html = empty
              ? '<div class="notFoundImg"><img alt="No Results Found" width="200" height="200"></div>'
              : !source.params.has("offset")
                ? pageHtml([card("a1", "Competitor A", 30), card("a2", "MM Cars Rental", 40)], 2, 1, 4)
                : source.params.get("offset") === "2"
                  ? pageHtml([card("a3", "Competitor B", 35, scenario !== "mixed-page")], 3, 2, 4)
                  : pageHtml([card("a4", "MM Cars Rental", 25)], 4, 3, 4);
          }
          return route.fulfill({ status: 200, contentType: "text/html",
            headers: { "access-control-allow-origin": "*" }, body: html });
        }
      }))
    };
  } };
  try {
    const result = await scraper.runSingleLocation(adapter, "Warsaw");
    assert.equal(nonNativePagination, 0, "filtered pagination must match the native filter_search request");
    assert.equal(unfilteredPagination, 0, "automatic mode must paginate the filtered search");
    if (wrongFilter || narrowPrice || scenario === "mixed-page") {
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "RESULT_TRANSPORT_INVALID");
      assert.match(result.error.message, narrowPrice ? /price.*range/i : /automatic|filter/i);
      assert.equal(filteredRequests, wrongFilter || narrowPrice ? 1 : 2);
    } else {
      assert.equal(result.ok, true, result.error?.message);
      if (empty) {
        assert.deepEqual(result.results, []);
        assert.equal(filteredRequests, 1);
      } else {
        assert.equal(filteredRequests, 3);
        assert.deepEqual(observations.map((item) => item.offset), [null, "2", "3"]);
        assert.ok(observations.every((item) => item.key === "opaque-test-session"));
        assert.equal(result.cheapest.provider, "MM Cars Rental");
        assert.equal(result.cheapest.total_price, 25);
        assert.equal(result.cheapest.price_per_day, 12.5);
        assert.equal(result.cheapest.pay_now_amount, 2.5);
        assert.equal(result.cheapest.currency, "EUR");
        assert.equal(result.results.length, 3);
      }
    }
    assert.equal(livePage.isClosed(), true);
    console.log(`PASS filtered network workflow: ${scenario}`);
  } finally { fs.rmSync(artifactsDir, { recursive: true, force: true }); }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const scenario of ["narrow-price", "empty-narrow-price", "complete", "empty", "wrong-filter", "empty-wrong-filter", "mixed-page"]) await runCase(browser, scenario);
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

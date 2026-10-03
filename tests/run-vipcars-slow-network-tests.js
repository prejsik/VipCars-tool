const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { VipCarsScraper } = require("../src/vipcars/scraper");
const { parseResultRequest } = require("../src/vipcars/resultTransport");
const { scrapeMatrix } = require("../src/vipcars/pickupPlan");

async function slowInitialResponse() {
  const browser = await chromium.launch({ headless: true });
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vipcars-slow-network-"));
  const scraper = new VipCarsScraper({
    baseUrl: "https://www.vipcars.com", pickupDate: "2026-10-04", dropoffDate: "2026-10-06",
    pickupTime: "10:00", dropoffTime: "10:00", currentDurationDays: 2,
    driverAge: 30, currency: "EUR", transmission: "automatic", networkResults: true,
    timeoutMs: 3000, attemptBudgetMs: 30000, maxProvidersPerLocation: 25, artifactsDir
  });
  const searchUrl = scraper.buildSearchUrl("Warsaw");
  const params = new URL(searchUrl).searchParams;
  for (const direction of ["pickup", "dropoff"]) {
    params.set(`${direction}_loc`, params.get(`${direction}_location`));
    params.delete(`${direction}_location`);
  }
  params.set("load_type", "get_result_desktop");
  params.set("offset", "0");
  params.set("car_page", "0");
  const resultUrl = `https://be.supplycars.com/be1/node.php?${params}`;
  const inputs = [
    ["pickup_country", "119"], ["dropoff_country", "119"],
    ["pickup_city", "1744"], ["dropoff_city", "1744"],
    ["pickup_location", "10921"], ["dropoff_location", "10921"],
    ["pickdate", "2026-10-04"], ["dropdate", "2026-10-06"],
    ["time_pickup", "10:00"], ["time_dropoff", "10:00"], ["page_busy", "1"]
  ].map(([id, value]) => `<input id="${id}" value="${value}">`).join("");
  const bootstrap = `<!doctype html><style>.scv-car-box{width:240px;height:80px}</style>
    ${inputs}<input name="currency" value="EUR"><span id="car_count_data">1</span>
    <div id="results"></div><script>
    setTimeout(async () => {
      const response = await fetch(${JSON.stringify(resultUrl)});
      document.getElementById('results').innerHTML = await response.text();
      document.getElementById('page_busy').value = '0';
    }, 5000);</script>`;
  const responseHtml = `<article class="scv-car-box" id="mm-1">
    <div class="scv-supp-info"><img alt="MM Cars Rental"></div>
    <div class="scv-car-name">Fixture car</div><div class="scv-car-cat">Economy</div>
    <div class="scv-new-amount">EUR 30.00</div><div class="scv-pay-now">Pay Now EUR 3.00</div>
    <ul class="scv-car-specs"><li><i class="scv-icon autom"></i>Automatic transmission</li></ul>
    </article><script>$("#offset").val(1);$("#car_page").val(1);$("#car_count_data").val(1);</script>`;
  const unexpected = [];
  const adapter = { async newContext(options) {
    const context = await browser.newContext(options);
    return {
      addCookies: (...args) => context.addCookies(...args),
      newPage: () => context.newPage(), close: () => context.close(),
      route: (pattern, handler) => context.route(pattern, (route) => handler({
        request: () => route.request(), abort: (...args) => route.abort(...args),
        continue: () => {
          const url = route.request().url();
          if (url === searchUrl) return route.fulfill({ status: 200, contentType: "text/html", body: bootstrap });
          if (parseResultRequest(url)) return route.fulfill({ status: 200, contentType: "text/html",
            headers: { "access-control-allow-origin": "*" }, body: responseHtml });
          unexpected.push(url);
          return route.abort();
        }
      }))
    };
  } };
  try {
    const result = await scraper.runSingleLocation(adapter, "Warsaw");
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].provider, "MM Cars Rental");
    assert.equal(result.results[0].pay_now_amount, 3);
    assert.deepEqual(unexpected, []);
    console.log("PASS slow initial results use the attempt budget without losing coverage");
  } finally {
    await browser.close();
    assert.equal(path.dirname(path.resolve(artifactsDir)), path.resolve(os.tmpdir()));
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  }
}

function matrixCoverage() {
  const config = path.resolve(__dirname, "../vipcars.config.example.json");
  const dates = Array.from({ length: 45 }, (_, index) => {
    const day = new Date(Date.UTC(2026, 9, 4 + index));
    return day.toISOString().slice(0, 10);
  });
  const locations = "Bydgoszcz,Warsaw,Krakow,Gdansk,Katowice,Wroclaw,Poznan";
  const allDurations = "2,3,4,5,6,7,8,9,10,11,12,13,14";
  const matrix = scrapeMatrix(["--config", config, "--pickup-dates", dates.join(","),
    "--locations", locations, "--durations-days", allDurations]);
  assert.equal(matrix.include.length, 135);
  const checks = new Set();
  for (const shard of matrix.include) {
    assert.ok(dates.includes(shard.pickup_dates));
    const durations = shard.durations.split(",").map(Number);
    assert.ok(durations.length * 7 <= 42);
    assert.ok(durations.length * 7 * 240000 < 170 * 60000,
      "every shard must fit a first pass even at the attempt limit");
    for (const duration of durations) {
      for (const location of locations.split(",")) {
        const key = [shard.pickup_dates, duration, location].join("|");
        assert.equal(checks.has(key), false, "no duplicated search");
        checks.add(key);
      }
    }
  }
  assert.equal(checks.size, 4095);
  const manual = scrapeMatrix(["--config", config, "--pickup-dates", dates[0],
    "--locations", "Warsaw", "--durations-days", "2,5,7"]);
  assert.deepEqual(manual.include.map((shard) => shard.durations), ["2,5", "7"]);
  assert.throws(() => scrapeMatrix(["--config", config, "--pickup-rolling-days", "90",
    "--locations", locations, "--durations-days", allDurations]), /256|matrix/i);
  console.log("PASS bounded import-band shards cover every planned search exactly once");
}

(async () => {
  await slowInitialResponse();
  matrixCoverage();
})().catch((error) => { console.error(error); process.exitCode = 1; });

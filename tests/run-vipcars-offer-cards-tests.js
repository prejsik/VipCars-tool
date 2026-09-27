#!/usr/bin/env node

const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const { parseOfferPage, readOfferCards } = require("../src/vipcars/offerCards");

const CARDS_HTML = `
  <div class="scv-car-box" id="car_id_151559579_30691_1615">
    <div class="scv-supp-info"><img alt="  MM Cars Rental  "></div>
    <span id="supplier_rating_mm"> 9.4 </span>
    <div class="scv-new-amount"> EUR 123.45 </div>
    <div class="scv-pay-now"> Pay Now EUR 12.30 </div>
    <div class="scv-car-name"> Toyota Corolla </div>
    <ul class="scv-car-specs"><li><span class="scv-icon autom"></span> Automatic transmission </li></ul>
    <div class="scv-car-cat"> Compact </div>
  </div>
  <div class="scv-car-box" id="car_id_643949">
    <div class="scv-supp-info"><h5> Wheego </h5></div>
    <span id="supplier_rating_wheego"> 8.7 </span>
    <div class="scv-car-price"> EUR 140.50 </div>
    <div class="scv-car-img"><img alt=" Fiat 500 "></div>
    <ul class="scv-car-specs"><li> Transmission: Manual </li></ul>
    <div class="scv-car-cat"> Mini </div>
  </div>`;

const PAGINATION_SCRIPT = `
  $("#offset").val("10");
  jQuery('#car_page').val(2);
  $("#car_count_data").val("2");`;

function inertPageHtml(script = PAGINATION_SCRIPT, hiddenCount = "2") {
  return `<!doctype html><html><body>
    <input type="hidden" id="car_count" value="${hiddenCount}">
    ${CARDS_HTML}
    <script>
      globalThis.__offerCardsScriptRuns += 1;
      ${script}
    </script>
  </body></html>`;
}

function livePageHtml() {
  return `<!doctype html><html><body>
    <input type="hidden" id="car_count" value="2">
    <input type="hidden" id="car_count_data" value="2">
    <input type="hidden" id="offset" value="10">
    <input type="hidden" id="car_page" value="2">
    ${CARDS_HTML}
  </body></html>`;
}

const EXPECTED_CARDS = [
  {
    cardId: "car_id_151559579_30691_1615",
    provider: "MM Cars Rental",
    rating: "9.4",
    priceText: "EUR 123.45",
    payNowText: "Pay Now EUR 12.30",
    location: "Warsaw",
    carName: "Toyota Corolla",
    transmission: "Automatic transmission",
    automatic: true,
    vehicleCategory: "Compact"
  },
  {
    cardId: "car_id_643949",
    provider: "Wheego",
    rating: "8.7",
    priceText: "EUR 140.50",
    payNowText: "",
    location: "Warsaw",
    carName: "Fiat 500",
    transmission: "Transmission: Manual",
    automatic: false,
    vehicleCategory: "Mini"
  }
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  let networkRequests = 0;
  await context.route("**/*", async (route) => {
    networkRequests += 1;
    await route.abort();
  });
  const page = await context.newPage();

  try {
    await page.evaluate(() => { globalThis.__offerCardsScriptRuns = 0; });
    const cards = await page.evaluate(readOfferCards, { html: inertPageHtml(), location: "Warsaw" });
    assert.deepEqual(cards, EXPECTED_CARDS);
    assert.equal(await page.evaluate(() => globalThis.__offerCardsScriptRuns), 0);
    console.log("PASS inert raw-card extraction preserves fields and does not execute scripts");

    const inert = await parseOfferPage(page, inertPageHtml(), "Warsaw");
    assert.deepEqual(inert, {
      cards: EXPECTED_CARDS,
      totalCount: 2,
      nextOffset: 10,
      nextPage: 2
    });
    assert.equal(await page.evaluate(() => globalThis.__offerCardsScriptRuns), 0);
    console.log("PASS inert page parsing reads literal pagination and count values");

    await page.setContent(livePageHtml());
    assert.deepEqual(await page.evaluate(readOfferCards, { location: "Warsaw" }), EXPECTED_CARDS);
    const visible = await parseOfferPage(page, undefined, "Warsaw");
    assert.deepEqual(visible, inert);
    console.log("PASS live DOM and inert response parsing have the same contract");

    await assert.rejects(
      () => parseOfferPage(page, inertPageHtml(`
        $("#offset").val("10");
        $("#car_page").val("2");
        $("#car_count_data").val(totalCars);`), "Warsaw"),
      /car_count_data.*numeric/i
    );
    await assert.rejects(
      () => parseOfferPage(page, inertPageHtml(PAGINATION_SCRIPT, "3"), "Warsaw"),
      /car_count.*match/i
    );
    await assert.rejects(
      () => parseOfferPage(page, inertPageHtml(`${PAGINATION_SCRIPT}\n$("#offset").val("20");`), "Warsaw"),
      /ambiguous.*offset/i
    );
    await assert.rejects(
      () => parseOfferPage(page, inertPageHtml(`
        $("#offset").val("10");
        $("#car_count_data").val("2");`), "Warsaw"),
      /missing.*car_page/i
    );
    console.log("PASS malformed, mismatched, ambiguous and missing page state is rejected");

    const finalPage = await parseOfferPage(page, inertPageHtml(`
      $("#offset").val("20");
      $("#car_page").val("3");
      $("#car_count_data").val("2");`), "Warsaw");
    assert.equal(finalPage.nextOffset, 20);
    assert.equal(finalPage.totalCount, 2);
    console.log("PASS final-page cursor may exceed total count for parent validation");

    assert.equal(networkRequests, 0);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

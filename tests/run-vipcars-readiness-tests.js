const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const {
  applyAutomaticTransmissionFilter,
  loadSearchResultCards,
  waitForSearchOutcome
} = require("../src/vipcars/resultReadiness");

const CARD = '<article class="scv-car-box">offer</article>';
const AUTOMATIC_CARD = '<article class="scv-car-box"><div class="scv-car-specs"><i class="scv-icon autom"></i></div></article>';
const MANUAL_CARD = '<article class="scv-car-box"><div class="scv-car-specs">Manual transmission</div></article>';
const NO_RESULTS = '<div class="notFoundImg"><img alt="No Results Found" style="display:block;width:16px;height:16px"></div>';

async function withPage(browser, html, callback) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await callback(page);
  } finally {
    await page.close();
  }
}

async function expectReadinessError(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.retryable, true);
    return true;
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const tests = [];

  const test = (name, callback) => tests.push({ name, callback });

  test("four of eight cards remains incomplete after the budget", () => withPage(
    browser,
    `<span id="car_count_data">8</span>${CARD.repeat(4)}`,
    async (page) => {
      await assert.rejects(
        () => loadSearchResultCards(page, { timeoutMs: 80, pollIntervalMs: 10 }),
        (error) => {
          assert.equal(error.code, "RESULTS_INCOMPLETE");
          assert.equal(error.retryable, true);
          assert.equal(error.state.cardCount, 4);
          assert.equal(error.state.totalCount, 8);
          return true;
        }
      );
    }
  ));

  test("eight of eight cards completes immediately from span text", () => withPage(
    browser,
    `<span id="car_count_data">8</span>${CARD.repeat(8)}`,
    async (page) => {
      const result = await loadSearchResultCards(page, { timeoutMs: 200 });
      assert.deepEqual(result, {
        status: "complete",
        cardCount: 8,
        totalCount: 8,
        proof: "active-count"
      });
    }
  ));

  test("cards without an active result count fail closed", () => withPage(
    browser,
    CARD.repeat(2),
    async (page) => {
      await expectReadinessError(
        () => loadSearchResultCards(page, { timeoutMs: 60, pollIntervalMs: 10 }),
        "RESULTS_INCOMPLETE"
      );
    }
  ));

  test("a matching counter cannot complete while the page is busy", () => withPage(
    browser,
    '<input id="page_busy" value="1"><span id="car_count_data">0</span>',
    async (page) => {
      await expectReadinessError(
        () => loadSearchResultCards(page, { timeoutMs: 60, pollIntervalMs: 10 }),
        "RESULTS_INCOMPLETE"
      );
    }
  ));

  test("zero count without the explicit no-results marker is not an outcome", () => withPage(
    browser,
    '<span id="car_count_data">0</span>',
    async (page) => {
      await expectReadinessError(
        () => waitForSearchOutcome(page, { timeoutMs: 60, pollIntervalMs: 10 }),
        "SEARCH_OUTCOME_TIMEOUT"
      );
      await expectReadinessError(
        () => loadSearchResultCards(page, { timeoutMs: 60, pollIntervalMs: 10 }),
        "RESULTS_INCOMPLETE"
      );
    }
  ));

  test("search cards are not ready until page_busy becomes idle", () => withPage(
    browser,
    `<input id="page_busy" value="0">${CARD}`,
    async (page) => {
      await page.locator("#page_busy").evaluate((element) => { element.value = "1"; });
      await expectReadinessError(
        () => waitForSearchOutcome(page, { timeoutMs: 60, pollIntervalMs: 10 }),
        "SEARCH_OUTCOME_TIMEOUT"
      );
    }
  ));

  test("explicit no results are not ready until page_busy becomes idle", () => withPage(
    browser,
    `<input id="page_busy" value="0">${NO_RESULTS}`,
    async (page) => {
      await page.locator("#page_busy").evaluate((element) => { element.value = "1"; });
      await expectReadinessError(
        () => waitForSearchOutcome(page, { timeoutMs: 60, pollIntervalMs: 10 }),
        "SEARCH_OUTCOME_TIMEOUT"
      );
    }
  ));

  test("late cards load until the active count is reached", () => withPage(
    browser,
    `<span id="car_count_data">8</span><div id="results">${CARD.repeat(4)}</div>
      <script>
        setTimeout(() => {
          document.getElementById("results").insertAdjacentHTML("beforeend", ${JSON.stringify(CARD.repeat(4))});
        }, 40);
      </script>`,
    async (page) => {
      const result = await loadSearchResultCards(page, { timeoutMs: 500, pollIntervalMs: 10 });
      assert.equal(result.cardCount, 8);
      assert.equal(result.proof, "active-count");
    }
  ));

  test("an absolute deadline bounds result loading", () => withPage(
    browser,
    `<span id="car_count_data">8</span>${CARD.repeat(4)}`,
    async (page) => {
      const startedAt = Date.now();
      await expectReadinessError(
        () => loadSearchResultCards(page, {
          timeoutMs: 1000,
          deadlineAt: Date.now() + 60,
          pollIntervalMs: 10
        }),
        "RESULTS_INCOMPLETE"
      );
      assert.ok(Date.now() - startedAt < 400, "absolute deadline was not respected");
    }
  ));

  test("an unsettled automatic filter throws a retryable typed timeout", () => withPage(
    browser,
    `<input id="filter_automatic" type="checkbox">
      <input id="page_busy" value="1">
      <span id="car_count_data">4</span>${CARD.repeat(4)}`,
    async (page) => {
      await expectReadinessError(
        () => applyAutomaticTransmissionFilter(page, { timeoutMs: 70, pollIntervalMs: 10 }),
        "FILTER_TIMEOUT"
      );
    }
  ));

  test("checking the filter cannot reuse an unfiltered complete card set", () => withPage(
    browser,
    `<input id="filter_automatic" type="checkbox">
      <span id="car_count_data">2</span>${AUTOMATIC_CARD}${MANUAL_CARD}`,
    async (page) => {
      await expectReadinessError(
        () => applyAutomaticTransmissionFilter(page, { timeoutMs: 70, pollIntervalMs: 10 }),
        "FILTER_TIMEOUT"
      );
    }
  ));

  test("a known busy indicator must cycle after the filter is checked", () => withPage(
    browser,
    `<input id="filter_automatic" type="checkbox">
      <input id="page_busy" value="0">
      <span id="car_count_data">2</span>${AUTOMATIC_CARD.repeat(2)}`,
    async (page) => {
      await expectReadinessError(
        () => applyAutomaticTransmissionFilter(page, { timeoutMs: 70, pollIntervalMs: 10 }),
        "FILTER_TIMEOUT"
      );
    }
  ));

  test("initial search busy state is idle before click and cannot prove filter activation", () => withPage(
    browser,
    `<input id="filter_automatic" type="checkbox">
      <input id="page_busy" value="0">
      <span id="car_count_data">2</span>${AUTOMATIC_CARD.repeat(2)}
      <script>
        const filter = document.getElementById("filter_automatic");
        const busy = document.getElementById("page_busy");
        filter.addEventListener("change", () => {
          document.body.dataset.busyAtFilterClick = busy.value;
        });
      </script>`,
    async (page) => {
      await page.evaluate(() => {
        const busy = document.getElementById("page_busy");
        busy.value = "1";
        setTimeout(() => { busy.value = "0"; }, 100);
      });
      await expectReadinessError(
        () => applyAutomaticTransmissionFilter(page, { timeoutMs: 220, pollIntervalMs: 10 }),
        "FILTER_TIMEOUT"
      );
      assert.equal(await page.locator("body").getAttribute("data-busy-at-filter-click"), "0");
    }
  ));

  test("a synchronous changed result set proves filter activation when the busy cycle is missed", () => withPage(
    browser,
    `<input id="filter_automatic" type="checkbox">
      <input id="page_busy" value="0">
      <span id="car_count_data">2</span>
      <div id="results">${AUTOMATIC_CARD}${MANUAL_CARD}</div>
      <script>
        document.getElementById("filter_automatic").addEventListener("change", () => {
          const busy = document.getElementById("page_busy");
          busy.value = "1";
          document.querySelector(".scv-car-box:last-child").remove();
          document.getElementById("car_count_data").textContent = "1";
          busy.value = "0";
        });
      </script>`,
    async (page) => {
      assert.equal(await applyAutomaticTransmissionFilter(page, {
        timeoutMs: 200,
        pollIntervalMs: 10
      }), true);
      assert.equal(await page.locator(".scv-car-box").count(), 1);
    }
  ));

  test("an explicit empty-results page is classified as no results", () => withPage(
    browser,
    NO_RESULTS,
    async (page) => {
      assert.equal(await waitForSearchOutcome(page, { timeoutMs: 100 }), "no-results");
    }
  ));

  test("an automatic filter may settle to a verified empty result set", () => withPage(
    browser,
    `<input id="filter_automatic" type="checkbox">
      <input id="page_busy" value="0">
      <span id="car_count_data">4</span><div id="results">${CARD.repeat(4)}</div>
      <script>
        document.getElementById("filter_automatic").addEventListener("change", () => {
          const busy = document.getElementById("page_busy");
          busy.value = "1";
          setTimeout(() => {
            document.getElementById("results").replaceChildren();
            document.getElementById("car_count_data").textContent = "0";
            document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(NO_RESULTS)});
            busy.value = "0";
          }, 30);
        });
      </script>`,
    async (page) => {
      assert.equal(await applyAutomaticTransmissionFilter(page, {
        timeoutMs: 300,
        pollIntervalMs: 10
      }), true);
      const result = await loadSearchResultCards(page, { timeoutMs: 100 });
      assert.equal(result.cardCount, 0);
      assert.equal(result.totalCount, 0);
    }
  ));

  test("the filter settles before the loader scrolls to the full active count", () => withPage(
    browser,
    `<input id="filter_automatic" type="checkbox">
      <input id="page_busy" value="0">
      <span id="car_count_data">4</span><div id="results">${AUTOMATIC_CARD}${MANUAL_CARD}</div>
      <script>
        document.getElementById("filter_automatic").addEventListener("change", () => {
          const busy = document.getElementById("page_busy");
          busy.value = "1";
          setTimeout(() => {
            document.querySelector(".scv-car-box:last-child").remove();
            document.getElementById("car_count_data").textContent = "3";
            busy.value = "0";
          }, 30);
        });
        window.scrollTo = () => {
          const results = document.getElementById("results");
          if (results.children.length === 1) {
            results.insertAdjacentHTML("beforeend", ${JSON.stringify(AUTOMATIC_CARD.repeat(2))});
          }
        };
      </script>`,
    async (page) => {
      assert.equal(await applyAutomaticTransmissionFilter(page, {
        timeoutMs: 300,
        pollIntervalMs: 10
      }), true);
      assert.equal(await page.locator(".scv-car-box").count(), 1);

      const result = await loadSearchResultCards(page, { timeoutMs: 300, pollIntervalMs: 10 });
      assert.equal(result.cardCount, 3);
      assert.equal(result.proof, "active-count");
    }
  ));

  test("an expired deadline prevents the filter click", () => withPage(
    browser,
    '<input id="filter_automatic" type="checkbox">',
    async (page) => {
      await expectReadinessError(
        () => applyAutomaticTransmissionFilter(page, {
          timeoutMs: 1000,
          deadlineAt: Date.now() - 1
        }),
        "FILTER_TIMEOUT"
      );
      assert.equal(await page.locator("#filter_automatic").isChecked(), false);
    }
  ));

  test("filter fallback click is bounded by the remaining deadline", () => withPage(
    browser,
    '<input id="filter_automatic" type="checkbox">',
    async (page) => {
      const filter = page.locator("#filter_automatic");
      const boundedPage = {
        evaluate: (...args) => page.evaluate(...args),
        waitForTimeout: (timeoutMs) => page.waitForTimeout(timeoutMs),
        locator: (selector) => {
          if (selector === "#filter_automatic") {
            return {
              count: () => filter.count(),
              isChecked: () => filter.isChecked(),
              check: async () => {
                await page.waitForTimeout(35);
                throw new Error("primary click failed");
              }
            };
          }
          return {
            click: async ({ timeout }) => {
              await page.waitForTimeout(timeout);
              const error = new Error(`locator.click: Timeout ${timeout}ms exceeded.`);
              error.name = "TimeoutError";
              throw error;
            }
          };
        }
      };
      const startedAt = Date.now();
      await expectReadinessError(
        () => applyAutomaticTransmissionFilter(boundedPage, {
          timeoutMs: 1000,
          deadlineAt: Date.now() + 80
        }),
        "FILTER_TIMEOUT"
      );
      assert.ok(Date.now() - startedAt < 250, "fallback click exceeded the absolute deadline");
    }
  ));

  test("onState receives search, loader, and initial plus polled filter states", () => withPage(
    browser,
    `<input id="filter_automatic" type="checkbox" checked>
      <input id="page_busy" value="0">
      <span id="car_count_data">1</span>${AUTOMATIC_CARD}`,
    async (page) => {
      const searchStates = [];
      const loaderStates = [];
      const filterStates = [];

      assert.equal(await waitForSearchOutcome(page, {
        timeoutMs: 100,
        onState: (state) => searchStates.push(state)
      }), "results");
      assert.equal((await loadSearchResultCards(page, {
        timeoutMs: 100,
        onState: (state) => loaderStates.push(state)
      })).status, "complete");
      assert.equal(await applyAutomaticTransmissionFilter(page, {
        timeoutMs: 100,
        onState: (state) => filterStates.push(state)
      }), true);

      assert.equal(searchStates.length, 1);
      assert.equal(loaderStates.length, 1);
      assert.equal(filterStates.length, 2);
      assert.deepEqual(filterStates.map((state) => state.cardCount), [1, 1]);
    }
  ));

  try {
    for (const { name, callback } of tests) {
      try {
        await callback();
        console.log(`PASS ${name}`);
      } catch (error) {
        console.error(`FAIL ${name}`);
        console.error(error instanceof Error ? error.stack : String(error));
        process.exitCode = 1;
      }
    }
  } finally {
    await browser.close();
  }

  if (!process.exitCode) {
    console.log("All VipCars readiness tests passed.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});

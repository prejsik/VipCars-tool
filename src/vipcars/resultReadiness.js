const CARD_SELECTOR = ".scv-car-box";
const NO_RESULTS_SELECTOR = '.notFoundImg img[alt="No Results Found"]';
const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_POLL_INTERVAL_MS = 200;

class VipCarsReadinessError extends Error {
  constructor(code, message, state = null) {
    super(message);
    this.name = "VipCarsReadinessError";
    this.code = code;
    this.retryable = true;
    this.state = state;
  }
}

async function waitForSearchOutcome(page, options = {}) {
  const deadlineAt = getDeadline(options);
  let lastState = null;

  while (true) {
    lastState = await readResultState(page);
    emitState(options, lastState);
    if (!lastState.busy && lastState.cardCount > 0) {
      return "results";
    }
    if (!lastState.busy && lastState.noResults) {
      return "no-results";
    }
    if (Date.now() >= deadlineAt) {
      throw new VipCarsReadinessError(
        "SEARCH_OUTCOME_TIMEOUT",
        "VipCars search outcome timed out before results or a verified empty state appeared.",
        lastState
      );
    }
    await waitForNextPoll(page, deadlineAt, options.pollIntervalMs);
  }
}

async function loadSearchResultCards(page, options = {}) {
  const deadlineAt = getDeadline(options);
  let lastState = null;
  let nextScrollAt = 0;

  while (true) {
    lastState = await readResultState(page);
    emitState(options, lastState);
    const completion = getCompletion(lastState);
    if (completion) {
      return {
        status: completion.status,
        cardCount: lastState.cardCount,
        totalCount: lastState.totalCount,
        proof: completion.proof
      };
    }
    if (Date.now() >= deadlineAt) {
      throw new VipCarsReadinessError(
        "RESULTS_INCOMPLETE",
        "VipCars result loading timed out before full result coverage was verified.",
        lastState
      );
    }

    if (Date.now() >= nextScrollAt) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      nextScrollAt = Date.now() + 500;
    }
    await waitForNextPoll(page, deadlineAt, options.pollIntervalMs);
  }
}

async function applyAutomaticTransmissionFilter(page, options = {}) {
  const deadlineAt = getDeadline(options);
  const filter = page.locator("#filter_automatic");
  if (!(await filter.count().catch(() => 0))) {
    return false;
  }

  const initiallyChecked = await filter.isChecked().catch(() => false);
  let initialState = await readResultState(page);
  emitState(options, initialState);

  while (!initiallyChecked && initialState.busy) {
    ensureFilterBudget(deadlineAt, initialState);
    await waitForNextPoll(page, deadlineAt, options.pollIntervalMs);
    initialState = await readResultState(page);
    emitState(options, initialState);
  }

  let requiresBusyCycle = !initiallyChecked && initialState.hasBusyIndicator;
  let busySeen = initiallyChecked && initialState.busy;

  if (!initiallyChecked) {
    ensureFilterBudget(deadlineAt, initialState);
    try {
      await filter.check({ force: true, timeout: remainingMs(deadlineAt) });
    } catch (error) {
      ensureFilterBudget(deadlineAt, initialState);
      try {
        await page.locator("label", { has: filter }).click({
          force: true,
          timeout: remainingMs(deadlineAt)
        });
      } catch (fallbackError) {
        if (Date.now() >= deadlineAt || isTimeoutError(error) || isTimeoutError(fallbackError)) {
          throw filterTimeout(initialState);
        }
        return false;
      }
    }
  }

  let lastState = null;

  while (true) {
    lastState = await readResultState(page);
    emitState(options, lastState);
    if (lastState.hasBusyIndicator && !initiallyChecked) {
      requiresBusyCycle = true;
    }
    if (lastState.busy) {
      busySeen = true;
    }
    const filterActionProven = !requiresBusyCycle
      || busySeen
      || hasResultStateChanged(initialState, lastState);
    if (lastState.filterChecked && !lastState.busy && filterActionProven && isFilterSettled(lastState)) {
      return true;
    }
    if (Date.now() >= deadlineAt) {
      throw filterTimeout(lastState);
    }
    await waitForNextPoll(page, deadlineAt, options.pollIntervalMs);
  }
}

function getCompletion(state) {
  if (state.busy) {
    return null;
  }
  if (state.cardCount === 0 && state.noResults) {
    return { status: "no-results", proof: "no-results" };
  }
  if (state.totalCount > 0 && state.cardCount === state.totalCount) {
    return { status: "complete", proof: "active-count" };
  }
  return null;
}

function isFilterSettled(state) {
  if (state.cardCount === 0 && state.noResults) {
    return true;
  }
  return state.cardCount > 0
    && state.automaticCardCount === state.cardCount
    && state.totalCount !== null
    && state.totalCount >= state.cardCount;
}

function hasResultStateChanged(before, after) {
  return before.cardCount !== after.cardCount
    || before.automaticCardCount !== after.automaticCardCount
    || before.totalCount !== after.totalCount
    || before.noResults !== after.noResults;
}

async function readResultState(page) {
  return page.evaluate(({ cardSelector, noResultsSelector }) => {
    const isVisible = (element) => {
      if (!element || element.hidden) {
        return false;
      }
      for (let current = element; current; current = current.parentElement) {
        const style = window.getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
          return false;
        }
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0;
    };

    const parseCount = (value) => {
      if (typeof value === "number") {
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
      }
      const text = String(value ?? "").replace(/\u00a0/g, " ").trim();
      if (!text) {
        return null;
      }
      const totalMatch = text.match(/\b(?:of|total)\s*:?\s*(\d[\d,\s]*)\b/i);
      const numericText = totalMatch?.[1] || (text.match(/\d+/g)?.length === 1 ? text.match(/\d+/)?.[0] : "");
      if (!numericText) {
        return null;
      }
      const parsed = Number(numericText.replace(/[,\s]/g, ""));
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    };

    const readCount = () => {
      for (const id of ["car_count_data", "car_count"]) {
        const element = document.getElementById(id);
        if (!element) {
          continue;
        }
        for (const candidate of [
          element.value,
          element.textContent
        ]) {
          const parsed = parseCount(candidate);
          if (parsed !== null) {
            return { count: parsed, id };
          }
        }
      }
      return { count: null, id: null };
    };

    const readElementValue = (element) => String(
      element?.value ?? element?.getAttribute("aria-busy") ?? element?.textContent ?? ""
    ).trim().toLowerCase();
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isAutomaticCard = (card) => {
      const specsText = normalize(card.querySelector(".scv-car-specs")?.textContent || "");
      const carName = normalize(
        card.querySelector(".scv-car-name")?.textContent
        || card.querySelector(".scv-car-img img[alt]")?.getAttribute("alt")
        || ""
      );
      return Boolean(card.querySelector(".scv-car-specs .scv-icon.autom"))
        || /\bautomatic\b/i.test(`${specsText} ${carName}`);
    };
    const busyElement = document.getElementById("page_busy");
    const busyValue = readElementValue(busyElement);
    const cards = Array.from(document.querySelectorAll(cardSelector)).filter(isVisible);
    const count = readCount();

    return {
      cardCount: cards.length,
      automaticCardCount: cards.filter(isAutomaticCard).length,
      totalCount: count.count,
      counterId: count.id,
      noResults: isVisible(document.querySelector(noResultsSelector)),
      hasBusyIndicator: Boolean(busyElement),
      busy: ["1", "true", "busy", "loading"].includes(busyValue),
      filterChecked: document.getElementById("filter_automatic")?.checked === true
    };
  }, {
    cardSelector: CARD_SELECTOR,
    noResultsSelector: NO_RESULTS_SELECTOR
  });
}

function filterTimeout(state) {
  return new VipCarsReadinessError(
    "FILTER_TIMEOUT",
    "VipCars automatic transmission filter timed out before filter activation was verified.",
    state
  );
}

function ensureFilterBudget(deadlineAt, state) {
  if (Date.now() >= deadlineAt) {
    throw filterTimeout(state);
  }
}

function remainingMs(deadlineAt) {
  return Math.max(1, deadlineAt - Date.now());
}

function isTimeoutError(error) {
  return error?.name === "TimeoutError"
    || /\btimeout\b.*\bexceeded\b|\btimed out\b/i.test(String(error?.message || error || ""));
}

function emitState(options, state) {
  if (typeof options.onState === "function") {
    options.onState(state);
  }
}

function getDeadline(options) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const timeoutDeadline = Date.now() + timeoutMs;
  return Number.isFinite(options.deadlineAt)
    ? Math.min(timeoutDeadline, options.deadlineAt)
    : timeoutDeadline;
}

async function waitForNextPoll(page, deadlineAt, pollIntervalMs) {
  const interval = Number.isFinite(pollIntervalMs) && pollIntervalMs > 0
    ? pollIntervalMs
    : DEFAULT_POLL_INTERVAL_MS;
  const waitMs = Math.max(0, Math.min(interval, deadlineAt - Date.now()));
  if (waitMs > 0) {
    await page.waitForTimeout(waitMs);
  }
}

module.exports = {
  VipCarsReadinessError,
  applyAutomaticTransmissionFilter,
  loadSearchResultCards,
  waitForSearchOutcome
};

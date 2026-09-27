const FIELD_DEFINITIONS = Object.freeze([
  { field: "pickup_country", selector: "#pickup_country" },
  { field: "pickup_city", selector: "#pickup_city" },
  { field: "pickup_location", selector: "#pickup_location" },
  { field: "dropoff_country", selector: "#dropoff_country" },
  { field: "dropoff_city", selector: "#dropoff_city" },
  { field: "dropoff_location", selector: "#dropoff_location" },
  { field: "pickup_date", selector: "#pickdate" },
  { field: "dropoff_date", selector: "#dropdate" },
  { field: "pickup_time", selector: "#time_pickup" },
  { field: "dropoff_time", selector: "#time_dropoff" }
]);

const CONTRACT_FIELDS = Object.freeze([
  ...FIELD_DEFINITIONS.map(({ field }) => field),
  "currency"
]);

class SearchContractError extends Error {
  constructor(expected, actual, mismatches) {
    const fields = [...new Set(mismatches.map(({ field }) => field))];
    super(`Search contract mismatch: ${fields.join(", ") || "expected URL"}.`);
    this.name = "SearchContractError";
    this.code = "SEARCH_CONTRACT_MISMATCH";
    this.retryable = false;
    this.expected = expected;
    this.actual = actual;
    this.mismatches = mismatches;
  }
}

class SearchContractUnavailableError extends Error {
  constructor(cause) {
    super("Search contract is unavailable because the page context closed.", { cause });
    this.name = "SearchContractUnavailableError";
    this.code = "SEARCH_CONTRACT_UNAVAILABLE";
    this.retryable = true;
  }
}

function isSearchContractUnavailable(error) {
  const message = String(error?.message || "");
  return error?.name === "TargetClosedError"
    || /Execution context was destroyed/i.test(message)
    || /Target closed/i.test(message)
    || /Target page, context or browser has been closed/i.test(message)
    || /Page (?:has been )?closed/i.test(message);
}

function readExpectedSearch(expectedUrl) {
  let url;
  try {
    url = new URL(expectedUrl);
  } catch {
    throw new SearchContractError({}, {}, [{
      field: "expected_url",
      reason: "missing",
      expected: "valid URL",
      actual: null
    }]);
  }

  const expected = {};
  const mismatches = [];
  for (const field of CONTRACT_FIELDS) {
    const values = url.searchParams.getAll(field).map((value) => value.trim()).filter(Boolean);
    const uniqueValues = [...new Set(values)];
    expected[field] = uniqueValues.length === 1 ? uniqueValues[0] : null;

    if (uniqueValues.length === 0) {
      mismatches.push({ field, reason: "missing", expected: null, actual: null });
    } else if (uniqueValues.length > 1) {
      mismatches.push({ field, reason: "conflict", expected: uniqueValues, actual: null });
    }
  }

  if (mismatches.length > 0) {
    throw new SearchContractError(expected, {}, mismatches);
  }
  return expected;
}

async function readActualSearch(page) {
  try {
    return await page.evaluate(({ fieldDefinitions }) => {
      const actual = {};
      const missing = [];

      for (const { field, selector } of fieldDefinitions) {
        const element = document.querySelector(selector);
        const value = element && "value" in element ? String(element.value).trim() : "";
        actual[field] = value || null;
        if (!value) missing.push(field);
      }

      const currencyElements = Array.from(document.querySelectorAll('input[name="currency"]'));
      const currencies = currencyElements
        .map((element) => String(element.value || "").trim())
        .filter(Boolean);
      const uniqueCurrencies = [...new Set(currencies)];
      actual.currency = uniqueCurrencies.length === 1 ? uniqueCurrencies[0] : null;

      return {
        actual,
        missing,
        currencyValues: uniqueCurrencies
      };
    }, { fieldDefinitions: FIELD_DEFINITIONS });
  } catch (error) {
    if (!isSearchContractUnavailable(error)) throw error;
    throw new SearchContractUnavailableError(error);
  }
}

async function validatePageSearch(page, expectedUrl) {
  const expected = readExpectedSearch(expectedUrl);
  const observed = await readActualSearch(page);
  const mismatches = observed.missing.map((field) => ({
    field,
    reason: "missing",
    expected: expected[field],
    actual: null
  }));

  if (observed.currencyValues.length === 0) {
    mismatches.push({
      field: "currency",
      reason: "missing",
      expected: expected.currency,
      actual: null
    });
  } else if (observed.currencyValues.length > 1) {
    mismatches.push({
      field: "currency",
      reason: "conflict",
      expected: expected.currency,
      actual: observed.currencyValues
    });
  }

  for (const field of CONTRACT_FIELDS) {
    if (field === "currency" && observed.currencyValues.length !== 1) continue;
    if (observed.actual[field] === null) continue;
    if (observed.actual[field] !== expected[field]) {
      mismatches.push({
        field,
        reason: "mismatch",
        expected: expected[field],
        actual: observed.actual[field]
      });
    }
  }

  if (mismatches.length > 0) {
    throw new SearchContractError(expected, observed.actual, mismatches);
  }

  return observed.actual;
}

module.exports = {
  SearchContractError,
  validatePageSearch
};

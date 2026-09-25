const NBP_EUR_RATE_URL = "https://api.nbp.pl/api/exchangerates/rates/a/eur/?format=json";
const DEFAULT_FALLBACK_PLN_PER_EUR = 4.3;
const DEFAULT_TIMEOUT_MS = 5000;

function positiveNumber(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("The fallback EUR/PLN exchange rate must be a finite positive number.");
  }
  return parsed;
}

function fallbackRate(plnPerEur, reason) {
  return {
    pln_per_eur: plnPerEur,
    source: "fallback",
    effective_date: null,
    reason
  };
}

function isValidEffectiveDate(value, now) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value
    && value <= now.toISOString().slice(0, 10);
}

async function fetchEurPlnExchangeRate(options = {}) {
  const fallbackPlnPerEur = positiveNumber(
    options.fallbackPlnPerEur,
    DEFAULT_FALLBACK_PLN_PER_EUR
  );
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("The NBP exchange-rate timeout must be a finite positive number.");
  }
  const now = options.now == null ? new Date() : new Date(options.now);
  if (!Number.isFinite(now.getTime())) {
    throw new Error("The exchange-rate validation time must be a valid date.");
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return fallbackRate(fallbackPlnPerEur, "network_error: fetch_unavailable");
  }

  const controller = new AbortController();
  let timedOut = false;
  let phase = "network";
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(NBP_EUR_RATE_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    if (!response?.ok) {
      return fallbackRate(fallbackPlnPerEur, `http_error: ${response?.status ?? "unknown"}`);
    }

    phase = "response";
    const payload = await response.json();
    const rate = payload?.rates?.[0];
    const mid = rate?.mid;
    const effectiveDate = String(rate?.effectiveDate || "");
    if (
      String(payload?.table || "").toUpperCase() !== "A"
      || String(payload?.code || "").toUpperCase() !== "EUR"
      || typeof mid !== "number"
      || !Number.isFinite(mid)
      || mid <= 0
      || !isValidEffectiveDate(effectiveDate, now)
    ) {
      return fallbackRate(fallbackPlnPerEur, "malformed_response");
    }
    return {
      pln_per_eur: mid,
      source: "NBP",
      effective_date: effectiveDate
    };
  } catch (error) {
    if (timedOut || error?.name === "AbortError") {
      return fallbackRate(fallbackPlnPerEur, `timeout_after_${timeoutMs}ms`);
    }
    const message = String(error?.message || error || "unknown_error").replace(/\s+/g, " ").trim();
    const reason = phase === "response"
      ? `malformed_response: ${message}`
      : `network_error: ${message}`;
    return fallbackRate(fallbackPlnPerEur, reason);
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  DEFAULT_FALLBACK_PLN_PER_EUR,
  NBP_EUR_RATE_URL,
  fetchEurPlnExchangeRate
};

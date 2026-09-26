const path = require("path");
const { chromium } = require("playwright");
const { normalizeVehicleCategory } = require("./config");
const { createAttemptDiagnostics, sanitizeMessage } = require("./diagnostics");
const readiness = require("./resultReadiness");
const {
  ensureDir,
  formatMoney,
  normalizeCurrency,
  normalizeWhitespace,
  parseMoney,
  safeFilePart,
  writeTextFile
} = require("./utils");

const MAX_TIMEOUT_RETRIES = 2;

class VipCarsScraper {
  constructor(config) {
    this.config = config;
    this.attemptCounts = new Map();
  }

  async run(onProgress, options = {}) {
    ensureDir(this.config.artifactsDir);
    const browser = options.browser || await chromium.launch({ headless: this.config.headless });
    const results = [];
    const failures = [];
    const checks = [];

    try {
      for (const location of this.config.locations) {
        const outcome = await this.runLocationWithRetries(browser, location, options);
        if (outcome.ok) {
          results.push(...outcome.results);
          checks.push({ location, status: "complete", resultCount: outcome.results.length });
          if (outcome.cheapest) {
            console.log(`OK  ${location} -> ${outcome.cheapest.provider} -> ${formatMoney(outcome.cheapest.total_price, outcome.cheapest.currency)}`);
          } else {
            console.log(`NONE ${location} -> no automatic-transmission offers.`);
          }
        } else {
          failures.push({ location, error: outcome.error.message,
            retryable: outcome.retryable, attempts: outcome.attempts });
          checks.push({ location, status: "incomplete", resultCount: 0, error: outcome.error.message });
          console.log(`ERR ${location} -> ${outcome.error.message}`);
        }
        if (onProgress) {
          await onProgress(results, checks);
        }
      }
    } finally {
      if (!options.browser) {
        await browser.close();
      }
    }

    return { results, failures, checks };
  }

  async runLocationWithRetries(browser, location, options = {}) {
    const counts = options.attemptCounts || this.attemptCounts;
    const key = [this.config.pickupDate, this.config.dropoffDate,
      this.config.currentDurationDays, location].join("|");
    const maxAttempts = options.maxAttemptsPerCheck ?? MAX_TIMEOUT_RETRIES + 1;
    const passAttempts = options.attemptsPerPass ?? maxAttempts;
    const deadlineAt = options.deadlineAt ?? Infinity;
    let outcome;
    for (let pass = 0; pass < passAttempts; pass += 1) {
      const attempts = counts.get(key) || 0;
      if (Date.now() >= deadlineAt || attempts >= maxAttempts) {
        const code = Date.now() >= deadlineAt ? "JOB_DEADLINE" : "ATTEMPT_LIMIT";
        const error = new Error(`${code}: no further search attempt allowed.`);
        error.code = code;
        return { ok: false, error, attempts, retryable: false };
      }
      counts.set(key, attempts + 1);
      outcome = await this.runSingleLocation(browser, location, {
        attempt: attempts + 1, deadlineAt
      });
      outcome.attempts = attempts + 1;
      outcome.retryable = !outcome.ok && outcome.attempts < maxAttempts
        && Date.now() < deadlineAt && (outcome.error?.retryable === true || isTimeoutError(outcome.error));
      if (outcome.ok || !outcome.retryable) {
        return outcome;
      }
      if (pass + 1 < passAttempts) {
        console.log(`RETRY ${location} -> attempt ${outcome.attempts + 1}/${maxAttempts}`);
      }
    }
    return outcome;
  }

  async runSingleLocation(browser, location, options = {}) {
    const attempt = options.attempt || 1;
    const attemptBudgetMs = this.config.attemptBudgetMs || 90000;
    const deadlineAt = Math.min(options.deadlineAt ?? Infinity, Date.now() + attemptBudgetMs);
    const remaining = () => Math.max(1, deadlineAt - Date.now());
    const diagnostics = createAttemptDiagnostics({
      location, pickup_date: this.config.pickupDate,
      duration_days: this.config.currentDurationDays, attempt
    });
    let context;
    let page;
    let expired = false;
    let rejectDeadline;
    const deadline = new Promise((resolve, reject) => { rejectDeadline = reject; });
    const bounded = (operation) => Promise.race([operation, deadline]);
    const watchdog = setTimeout(() => {
      expired = true;
      rejectDeadline(new Error("Search attempt deadline reached."));
    }, remaining());
    try {
      context = await bounded(browser.newContext({
        viewport: { width: 1440, height: 1200 },
        locale: "en-IE",
        extraHTTPHeaders: {
          "Accept-Language": "en-IE,en;q=0.9,pl;q=0.8"
        }
      }).then((created) => {
        if (expired) {
          created.close().catch(() => {});
          throw new Error("Search attempt deadline reached while opening context.");
        }
        return created;
      }));
      if (expired) throw new Error("Search attempt deadline reached while opening context.");
      await bounded(this.configureCurrency(context));
      await bounded(context.route("**/*", async (route) => {
        const type = route.request().resourceType();
        if (type === "image" || type === "font" || type === "media") {
          await route.abort().catch(() => {});
          return;
        }
        await route.continue().catch(() => {});
      }));

      page = await bounded(context.newPage());
      diagnostics.attach(page);
      page.setDefaultTimeout(remaining());
      page.setDefaultNavigationTimeout(remaining());

      const resolvedLocation = resolveVipCarsLocation(location);
      console.log(`    Search location: ${resolvedLocation.name} (${resolvedLocation.code || resolvedLocation.locationId})`);
      console.log(`    Search time: ${this.config.pickupTime} -> ${this.config.dropoffTime}`);
      const response = await diagnostics.measure("navigation", () => bounded(page.goto(this.buildSearchUrl(location), {
        waitUntil: "domcontentloaded", timeout: Math.min(this.config.timeoutMs || 45000, remaining())
      })));
      if (response && response.status() >= 400) {
        const error = new Error(`HTTP ${response.status()}: search page unavailable.`);
        error.code = `HTTP_${response.status()}`;
        error.retryable = response.status() >= 500;
        throw error;
      }
      const waitOptions = { timeoutMs: attemptBudgetMs, deadlineAt,
        onState: diagnostics.recordResultState };
      const searchOutcome = await diagnostics.measure("search", () => bounded(this.waitForSearchOutcome(page, {
        ...waitOptions, timeoutMs: this.config.timeoutMs || 45000
      })));
      if (searchOutcome === "no-results") {
        console.log("    VipCars returned no available cars for this date/time.");
        return { ok: true, cheapest: null, results: [] };
      }
      if (this.config.transmission !== "any") {
        await diagnostics.measure("automatic_filter", () => bounded(this.applyAutomaticTransmissionFilter(page, waitOptions)));
      }
      await diagnostics.measure("load_cards", () => bounded(this.loadSearchResultCards(page, waitOptions)));
      const offers = await diagnostics.measure("extract", () => bounded(this.extractSearchOffers(page, location)));
      if (!offers.length) {
        return { ok: true, cheapest: null, results: [] };
      }

      const selected = selectBestOffersByProvider(offers, this.config.maxProvidersPerLocation);
      return { ok: true, cheapest: selected[0], results: selected };
    } catch (error) {
      if (expired || Date.now() >= deadlineAt) {
        error = new Error(`Search attempt timeout exceeded (${attemptBudgetMs}ms maximum).`);
        error.name = "TimeoutError";
        error.code = "ATTEMPT_TIMEOUT";
      }
      error.message = sanitizeMessage(error.message);
      await this.captureFailureArtifacts(page, location, diagnostics.snapshot(error)).catch((artifactError) => {
        console.warn(`Could not save failure artifacts: ${sanitizeMessage(artifactError.message)}`);
      });
      return { ok: false, error };
    } finally {
      clearTimeout(watchdog);
      diagnostics.detach();
      if (context) await settleWithin(context.close().catch(() => {}), 2000);
      const timing = diagnostics.snapshot();
      console.log(`TIMING ${location} attempt=${attempt} total_ms=${timing.elapsed_ms} `
        + timing.stages.map((stage) => `${stage.name}=${stage.elapsed_ms}ms/${stage.status}`).join(" "));
    }
  }

  async waitForSearchOutcome(page, options = {}) {
    return readiness.waitForSearchOutcome(page, { timeoutMs: this.config.timeoutMs, ...options });
  }

  buildSearchUrl(location) {
    const resolvedLocation = resolveVipCarsLocation(location);
    const baseUrl = new URL(this.config.baseUrl);
    const prefix = baseUrl.pathname.replace(/\/+$/g, "");
    const url = new URL(`${prefix}/search/`, baseUrl.origin);
    url.searchParams.set("aff", "vipcars_web");
    url.searchParams.set("language", "en");
    url.searchParams.set("googlemap", "1");
    url.searchParams.set("pickup_country", resolvedLocation.countryId);
    url.searchParams.set("pickup_city", resolvedLocation.cityId);
    url.searchParams.set("pickup_location", resolvedLocation.locationId);
    url.searchParams.set("dropoff_country", resolvedLocation.countryId);
    url.searchParams.set("dropoff_city", resolvedLocation.cityId);
    url.searchParams.set("dropoff_location", resolvedLocation.locationId);
    url.searchParams.set("pickup_date", this.config.pickupDate);
    url.searchParams.set("pickup_time", this.config.pickupTime);
    url.searchParams.set("dropoff_date", this.config.dropoffDate);
    url.searchParams.set("dropoff_time", this.config.dropoffTime);
    url.searchParams.set("rc", "pl");
    url.searchParams.set("currency", this.getCurrency());
    url.searchParams.set("drv_age_chk", "1");
    url.searchParams.set("driver_age", String(this.config.driverAge || 30));
    url.searchParams.set("page", "search");
    return url.toString();
  }

  getCurrency() {
    return normalizeCurrency(this.config.currency || "EUR") || "EUR";
  }

  async configureCurrency(context) {
    const baseUrl = new URL(this.config.baseUrl);
    const cookieUrl = baseUrl.origin;
    const currency = this.getCurrency();
    await context.addCookies([
      { name: "currency", value: currency, url: cookieUrl },
      { name: "rc", value: "pl", url: cookieUrl },
      { name: "cor", value: "pl", url: cookieUrl }
    ]).catch(() => {});
  }

  async loadSearchResultCards(page, options = {}) {
    return readiness.loadSearchResultCards(page, { timeoutMs: this.config.timeoutMs, ...options });
  }

  async applyAutomaticTransmissionFilter(page, options = {}) {
    const applied = await readiness.applyAutomaticTransmissionFilter(page, {
      timeoutMs: this.config.timeoutMs, ...options
    });
    console.log(applied
      ? "    Automatic transmission filter: applied."
      : "    Automatic transmission filter: unavailable; filtering extracted cards only.");
    return applied;
  }

  async extractSearchOffers(page, fallbackLocation) {
    const raw = await page.evaluate((defaultLocation) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const cards = Array.from(document.querySelectorAll(".scv-car-box"));
      return cards.map((card) => {
        const supplierImage = card.querySelector(".scv-supp-info img[alt], img[id^='supplier_']");
        const provider = normalize(
          supplierImage?.getAttribute("alt") ||
          supplierImage?.getAttribute("title") ||
          card.querySelector(".scv-supp-info h5")?.textContent ||
          ""
        );
        const rating = normalize(card.querySelector("[id^='supplier_rating_']")?.textContent || "");
        const priceText = normalize(
          card.querySelector(".scv-new-amount")?.textContent ||
          card.querySelector(".scv-car-price")?.textContent ||
          ""
        );
        const payNowText = normalize(card.querySelector(".scv-pay-now")?.textContent || "");
        const carName = normalize(
          card.querySelector(".scv-car-name")?.textContent ||
          card.querySelector(".scv-car-img img[alt]")?.getAttribute("alt") ||
          ""
        );
        const transmission = normalize(Array.from(card.querySelectorAll(".scv-car-specs li"))
          .map((item) => item.textContent || "")
          .find((text) => /transmission/i.test(text)) || "");
        const automatic = Boolean(card.querySelector(".scv-car-specs .scv-icon.autom")) ||
          /\bautomatic\b/i.test(`${transmission} ${carName}`);
        const vehicleCategory = normalize(card.querySelector(".scv-car-cat")?.textContent || "");
        return { provider, rating, priceText, payNowText, location: defaultLocation, carName, transmission, automatic, vehicleCategory };
      });
    }, fallbackLocation);

    const offers = [];
    const desiredCurrency = this.getCurrency();
    for (const candidate of raw) {
      const money = parseMoney(candidate.priceText);
      const requiresAutomatic = (this.config.transmission || "automatic") !== "any";
      if (!candidate.provider || !money || (requiresAutomatic && !isAutomaticTransmissionCandidate(candidate)) ||
          !isVehicleCategoryCandidate(candidate.vehicleCategory, this.config.vehicleCategory)) {
        continue;
      }
      const currency = normalizeCurrency(money.currency || desiredCurrency);
      if (currency !== desiredCurrency) {
        continue;
      }
      const totalPrice = Number(money.value);
      const payNow = parseMoney(candidate.payNowText);
      const durationDays = Number(this.config.currentDurationDays || 1);
      const pricePerDay = totalPrice / durationDays;
      offers.push({
        location: fallbackLocation,
        duration_days: durationDays,
        pickup_date: this.config.pickupDate,
        dropoff_date: this.config.dropoffDate,
        provider: normalizeProvider(candidate.provider),
        provider_rating: candidate.rating,
        total_price: Number(totalPrice.toFixed(2)),
        price_per_day: Number(pricePerDay.toFixed(2)),
        pay_now_amount: payNow ? Number(payNow.value.toFixed(2)) : "",
        pay_now_currency: payNow ? normalizeCurrency(payNow.currency) : "",
        currency,
        source: "search"
      });
    }

    return dedupeOffers(offers);
  }

  async captureFailureArtifacts(page, location, diagnostics = {}) {
    const scenarioName = `${this.config.pickupDate}-${this.config.currentDurationDays}d-${location}`;
    const baseName = `${safeFilePart(scenarioName) || "location"}-attempt-${diagnostics.attempt || 1}`;
    ensureDir(this.config.artifactsDir);
    writeTextFile(path.join(this.config.artifactsDir, `${baseName}.json`), JSON.stringify(diagnostics, null, 2));
    if (!page) return;
    await settleWithin(page.screenshot({
      path: path.join(this.config.artifactsDir, `${baseName}.png`),
      fullPage: true, timeout: 2000
    }).catch(() => {}), 2000);
    const html = await settleWithin(page.content().catch(() => ""), 2000);
    if (html) {
      writeTextFile(path.join(this.config.artifactsDir, `${baseName}.html`), html);
    }
  }
}

async function settleWithin(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const LOCATION_ALIASES = new Map([
  ["bydgoszcz", { name: "Bydgoszcz Airport [BZG]", code: "BZG", countryId: "119", cityId: "1733", locationId: "676" }],
  ["bydgoszcz airport", { name: "Bydgoszcz Airport [BZG]", code: "BZG", countryId: "119", cityId: "1733", locationId: "676" }],
  ["bzg", { name: "Bydgoszcz Airport [BZG]", code: "BZG", countryId: "119", cityId: "1733", locationId: "676" }],
  ["warsaw", { name: "Warsaw Chopin Airport [WAW]", code: "WAW", countryId: "119", cityId: "1744", locationId: "10921" }],
  ["warsaw chopin", { name: "Warsaw Chopin Airport [WAW]", code: "WAW", countryId: "119", cityId: "1744", locationId: "10921" }],
  ["waw", { name: "Warsaw Chopin Airport [WAW]", code: "WAW", countryId: "119", cityId: "1744", locationId: "10921" }],
  ["krakow", { name: "Krakow Airport [KRK]", code: "KRK", countryId: "119", cityId: "1737", locationId: "668" }],
  ["krakow airport", { name: "Krakow Airport [KRK]", code: "KRK", countryId: "119", cityId: "1737", locationId: "668" }],
  ["krk", { name: "Krakow Airport [KRK]", code: "KRK", countryId: "119", cityId: "1737", locationId: "668" }],
  ["gdansk", { name: "Gdansk Airport [GDN]", code: "GDN", countryId: "119", cityId: "1734", locationId: "665" }],
  ["gdn", { name: "Gdansk Airport [GDN]", code: "GDN", countryId: "119", cityId: "1734", locationId: "665" }],
  ["katowice", { name: "Katowice Pyrzowice Airport [KTW]", code: "KTW", countryId: "119", cityId: "1735", locationId: "667" }],
  ["katowice pyrzowice", { name: "Katowice Pyrzowice Airport [KTW]", code: "KTW", countryId: "119", cityId: "1735", locationId: "667" }],
  ["ktw", { name: "Katowice Pyrzowice Airport [KTW]", code: "KTW", countryId: "119", cityId: "1735", locationId: "667" }],
  ["wroclaw", { name: "Wroclaw Airport [WRO]", code: "WRO", countryId: "119", cityId: "1745", locationId: "674" }],
  ["wro", { name: "Wroclaw Airport [WRO]", code: "WRO", countryId: "119", cityId: "1745", locationId: "674" }],
  ["poznan", { name: "Poznan Airport [POZ]", code: "POZ", countryId: "119", cityId: "1741", locationId: "669" }],
  ["poz", { name: "Poznan Airport [POZ]", code: "POZ", countryId: "119", cityId: "1741", locationId: "669" }]
]);

function resolveVipCarsLocation(value) {
  const key = slugifyLocation(value).replace(/-/g, " ");
  const exactKey = normalizeWhitespace(value).toLowerCase();
  const location = LOCATION_ALIASES.get(exactKey) || LOCATION_ALIASES.get(key);
  if (!location) {
    throw new Error(`Unsupported VipCars location: ${value}. Add its VIPCars country/city/location IDs before scraping.`);
  }
  return location;
}

function normalizeProvider(value) {
  return normalizeWhitespace(value)
    .replace(/^EuropCar$/i, "Europcar")
    .replace(/^Surprice Car Rental$/i, "SurPrice")
    .replace(/^Green motion$/i, "Green Motion")
    .replace(/^Ace$/i, "Ace Rent a Car");
}

function dedupeOffers(offers) {
  const seen = new Set();
  const unique = [];
  for (const offer of offers) {
    const key = `${offer.location}|${offer.provider.toLowerCase()}|${offer.total_price}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(offer);
  }
  return unique;
}

function selectBestOffersByProvider(offers, maxProviders) {
  const byProvider = new Map();
  for (const offer of offers) {
    const key = offer.provider.toLowerCase();
    const existing = byProvider.get(key);
    if (!existing || Number(offer.total_price) < Number(existing.total_price)) {
      byProvider.set(key, offer);
    }
  }
  return [...byProvider.values()]
    .sort((left, right) => Number(left.total_price) - Number(right.total_price))
    .slice(0, Number.isFinite(maxProviders) && maxProviders > 0 ? maxProviders : undefined);
}

function isAutomaticTransmissionCandidate(candidate) {
  if (candidate?.automatic === true) {
    return true;
  }
  const text = `${candidate?.transmission || ""} ${candidate?.carName || ""}`;
  return /\bautomatic\b/i.test(text);
}

function isVehicleCategoryCandidate(categoryText, desiredCategory) {
  const category = normalizeVehicleCategory(desiredCategory);
  if (!category) {
    return true;
  }
  const text = normalizeWhitespace(categoryText).toLowerCase();
  return category === "van"
    ? /\bvan\b|\bminivan\b/.test(text)
    : /\bluxury\b|\bpremium\b/.test(text);
}

function isTimeoutError(error) {
  if (error?.name === "TimeoutError") {
    return true;
  }
  return /\btimeout\b.*\bexceeded\b|\btimed out\b/i.test(String(error?.message || error || ""));
}

function slugifyLocation(value) {
  return normalizeWhitespace(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

module.exports = {
  VipCarsScraper,
  isAutomaticTransmissionCandidate,
  isVehicleCategoryCandidate,
  resolveVipCarsLocation,
  slugifyLocation
};

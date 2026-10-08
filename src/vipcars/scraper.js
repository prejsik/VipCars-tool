const path = require("path");
const { chromium } = require("playwright");
const { normalizeVehicleCategory } = require("./config");
const { createAttemptDiagnostics, sanitizeMessage } = require("./diagnostics");
const readiness = require("./resultReadiness");
const { validatePageSearch } = require("./searchContract");
const transport = require("./resultTransport");
const { createResultRequestGate } = require("./requestThrottle");
const { readOfferCards, parseOfferPage } = require("./offerCards");
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
    if (config.resultRequestIntervalMs !== undefined
        && (!Number.isInteger(config.resultRequestIntervalMs) || config.resultRequestIntervalMs < 3000)) {
      throw new Error("resultRequestIntervalMs must be a finite integer >= 3000.");
    }
    this.config = config;
    this.attemptCounts = new Map();
    this.cooldown = { until: 0 };
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
    const cooldown = options.cooldown || this.cooldown;
    let outcome;
    for (let pass = 0; pass < passAttempts; pass += 1) {
      const attempts = counts.get(key) || 0;
      let waiting = false;
      let cooldownWaitMs = 0;
      while (true) {
        if (Date.now() >= deadlineAt || attempts >= maxAttempts) {
          const code = Date.now() >= deadlineAt ? "JOB_DEADLINE" : "ATTEMPT_LIMIT";
          const error = new Error(`${code}: no further search attempt allowed.`);
          error.code = code;
          return { ok: false, error, attempts, retryable: false };
        }
        if (cooldown.until <= Date.now()) break;
        if (cooldown.until >= deadlineAt) {
          const error = new Error(`VipCars server cooldown until ${new Date(cooldown.until).toISOString()} exceeds this job's remaining time.`);
          error.code = "SERVER_COOLDOWN";
          error.retryAt = cooldown.until;
          return { ok: false, error, attempts, retryable: false };
        }
        if (!waiting) console.log(`WAIT VipCars server cooldown until ${new Date(cooldown.until).toISOString()}`);
        waiting = true;
        const waitStarted = Date.now();
        await new Promise((resolve) => setTimeout(resolve, Math.min(60000, cooldown.until - Date.now())));
        cooldownWaitMs += Date.now() - waitStarted;
      }
      counts.set(key, attempts + 1);
      outcome = await this.runSingleLocation(browser, location, {
        attempt: attempts + 1, deadlineAt, cooldown, onCooldown: options.onCooldown, cooldownWaitMs,
        onDiagnostics: options.onDiagnostics
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
    const cooldown = options.cooldown || this.cooldown;
    if (cooldown.until > Date.now()) {
      const error = new Error(`VipCars server cooldown until ${new Date(cooldown.until).toISOString()}.`);
      error.code = "SERVER_COOLDOWN";
      error.retryAt = cooldown.until;
      error.retryable = true;
      return { ok: false, error };
    }
    const attempt = options.attempt || 1;
    const attemptBudgetMs = this.config.attemptBudgetMs || 180000;
    const deadlineAt = Math.min(options.deadlineAt ?? Infinity, Date.now() + attemptBudgetMs);
    const remaining = () => Math.max(1, deadlineAt - Date.now());
    const diagnostics = createAttemptDiagnostics({
      location, pickup_date: this.config.pickupDate,
      duration_days: this.config.currentDurationDays, attempt, cooldown_wait_ms: options.cooldownWaitMs || 0
    });
    let context;
    let page;
    let initialResults;
    let filteredResults;
    let detachResultFailures;
    let attemptError;
    const allowedResultUrls = new Set();
    let expired = false;
    let rejectDeadline;
    const deadline = new Promise((resolve, reject) => { rejectDeadline = reject; });
    const bounded = (operation) => Promise.race([operation, deadline]);
    const resultRequestGate = createResultRequestGate(cooldown, deadlineAt, this.config.resultRequestIntervalMs);
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
        const resultRequest = transport.parseResultRequest(route.request().url(), { includeFiltered: true, includeBootstrap: true });
        if (this.config.networkResults && resultRequest && resultRequest.params.has("offset") && resultRequest.params.get("offset") !== "0") {
          if (!transport.allowPaginationRequest(route.request(), allowedResultUrls)) {
            await route.abort("aborted").catch(() => {});
            return;
          }
        }
        if (type === "image" || type === "font" || type === "media") {
          await route.abort().catch(() => {});
          return;
        }
        if (resultRequest && route.request().method() === "GET") {
          const pagination = this.config.networkResults && resultRequest.params.has("offset")
            && resultRequest.params.get("offset") !== "0";
          const finishWait = diagnostics.start(pagination ? "network_throttle_wait" : "result_throttle_wait", { aggregate: true });
          try { await resultRequestGate(() => {
            finishWait();
            return route.continue();
          }); }
          catch (error) {
            finishWait("failure");
            rejectDeadline(error);
            await route.abort().catch(() => {});
          }
        } else await route.continue().catch(() => {});
      }));

      page = await bounded(context.newPage());
      diagnostics.attach(page);
      const resultFailures = transport.observeResultFailures(page, (error) => {
        if (Number.isFinite(error.retryAt) && error.retryAt > cooldown.until) {
          cooldown.until = error.retryAt;
          try { options.onCooldown?.(); }
          catch (checkpointError) {
            rejectDeadline(checkpointError);
            return;
          }
        }
        rejectDeadline(error);
      });
      detachResultFailures = resultFailures.detach;
      await bounded(resultFailures.ready);
      if (this.config.networkResults) {
        initialResults = transport.captureInitialResults(page);
        if (this.config.transmission !== "any") filteredResults = transport.captureInitialResults(page, { filtered: true });
      }
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
        ...waitOptions, timeoutMs: Math.max(this.config.timeoutMs || 45000, attemptBudgetMs / 2)
      })));
      await diagnostics.measure("search_contract", () => bounded(validatePageSearch(page, this.buildSearchUrl(location))));
      if (searchOutcome === "no-results") {
        console.log("    VipCars returned no available cars for this date/time.");
        return { ok: true, cheapest: null, results: [] };
      }
      let automaticApplied = false;
      if (this.config.transmission !== "any") {
        automaticApplied = await diagnostics.measure("automatic_filter", () => bounded(this.applyAutomaticTransmissionFilter(page, waitOptions)));
      }
      let raw;
      if (this.config.networkResults) {
        const filteredEmpty = automaticApplied && await bounded(this.waitForSearchOutcome(page, waitOptions)) === "no-results";
        const captured = await bounded((automaticApplied ? filteredResults : initialResults).read());
        if (!captured) throw transport.transportError("Initial result response was not captured.", true);
        raw = await diagnostics.measure("network_offers", () => bounded(this.loadNetworkOffers(
          context, page, captured, location, { ...waitOptions, allowedResultUrls, resultFailures, filteredEmpty,
            measure: (name, action, extra = {}) => diagnostics.measure(name,
              () => bounded(Promise.resolve().then(action)), { aggregate: true, ...extra }) })));
      } else {
        await diagnostics.measure("load_cards", () => bounded(this.loadSearchResultCards(page, waitOptions)));
      }
      await diagnostics.measure("final_search_contract", () => bounded(validatePageSearch(page, this.buildSearchUrl(location))));
      const offers = await diagnostics.measure("extract", () => bounded(this.extractSearchOffers(page, location, raw)));
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
      attemptError = error;
      await this.captureFailureArtifacts(page, location, diagnostics.snapshot(error)).catch((artifactError) => {
        console.warn(`Could not save failure artifacts: ${sanitizeMessage(artifactError.message)}`);
      });
      return { ok: false, error };
    } finally {
      clearTimeout(watchdog);
      if (detachResultFailures) await settleWithin(detachResultFailures(), 1000);
      initialResults?.detach();
      filteredResults?.detach();
      diagnostics.detach();
      if (context) await settleWithin(context.close().catch(() => {}), 2000);
      const timing = diagnostics.snapshot(attemptError);
      console.log(`TIMING ${location} attempt=${attempt} total_ms=${timing.elapsed_ms} `
        + `cooldown_wait_ms=${timing.cooldown_wait_ms} pageCount=${timing.result_state?.pageCount ?? 0} `
        + timing.stages.map((stage) => `${stage.name}=${stage.elapsed_ms}ms/${stage.status}`).join(" "));
      if (options.onDiagnostics) {
        try { await options.onDiagnostics(timing); }
        catch (error) {
          console.warn(`Could not report VipCars diagnostics: ${sanitizeMessage(error?.message || error)}`);
        }
      }
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

  async loadNetworkOffers(context, page, captured, location, options) {
    const measure = options.measure || ((name, action) => action());
    const filtered = await measure("network_prep", async () => {
      transport.validateResultRequest(captured.source, this.buildSearchUrl(location));
      const filtered = captured.source.params.get("load_type") === "get_result_desktop_filter";
      if (filtered) {
        const specs = captured.source.params.getAll("specs_checks");
        const otherFilters = ["supplier_checks", "class_checks", "fuel_checks", "location_checks", "excess_checks",
          "deposit_checks", "seat_checks", "mileage_checks", "fuel_policy_checks", "payment_type_checks"];
        if (specs.length !== 1 || specs[0] !== "automatic"
            || otherFilters.some((field) => captured.source.params.getAll(field).some(Boolean))) {
          throw transport.transportError("Automatic result request contains unexpected filters.");
        }
        const ranges = captured.source.params.getAll("price_range");
        const limits = await page.evaluate(() => Array.from(document.querySelectorAll("#price_range"))
          .map((element) => [element.getAttribute("data-slider-min"), element.getAttribute("data-slider-max")]));
        const number = (value) => /^\d+(?:\.\d+)?$/.test(String(value ?? "").trim()) ? Number(value) : NaN;
        const requestedRange = ranges.length === 1 ? ranges[0].split(",").map(number) : [];
        const fullRange = limits.length === 1 ? limits[0].map(number) : [];
        if (requestedRange.length !== 2 || fullRange.length !== 2
            || ![...requestedRange, ...fullRange].every(Number.isFinite)
            || fullRange[0] > fullRange[1]
            || requestedRange.some((value, index) => value !== fullRange[index])) {
          throw transport.transportError("Automatic result request does not use the full price range.");
        }
      }
      return filtered;
    });
    if (options.filteredEmpty) return [];
    const parserPage = await measure("network_prep", () => context.newPage());
    try {
      const parsePage = (html) => measure("network_parser", async () => {
        const batch = await parseOfferPage(parserPage, html, location);
        if (filtered && batch.cards.some((card) => !card.automatic)) {
          throw transport.transportError("Non-automatic offer in an automatic result page.");
        }
        return batch;
      });
      const initial = await parsePage(captured.html);
      await measure("network_dom_parity", async () => {
        const visible = await page.evaluate(readOfferCards, { location });
        transport.compareVisibleCards(initial.cards, visible);
        const visibleCounts = await page.evaluate(() => ["car_count_data", "car_count"]
          .map((id) => {
            const element = document.getElementById(id);
            return String(element?.value ?? element?.textContent ?? "").trim();
          }).filter(Boolean));
        if (!visibleCounts.length || visibleCounts.some((value) => !/^\d+$/.test(value) || Number(value) !== initial.totalCount)) {
          throw transport.transportError("Result response and visible DOM total counts differ.");
        }
      });
      const paginationSource = await measure("network_prep", () => initial.cards.length < initial.totalCount
        ? transport.preparePaginationSource(page, captured.source) : captured.source);
      const cards = await transport.collectResultPages({ initial, source: paginationSource,
        deadlineAt: options.deadlineAt, onState: options.onState,
        fetchPage: async (url, timeout) => {
          try {
            options.allowedResultUrls.add(url);
            // Fetch includes browser routing; exclude its paced dispatch wait from HTTP time.
            const response = await measure("network_transport_wait", () => options.resultFailures.correlate(url, () =>
              measure("network_http_fetch", () => transport.fetchResultPage(page, url, timeout, paginationSource.headers),
                { exclude: ["network_throttle_wait"] })),
            { exclude: ["network_http_fetch", "network_throttle_wait"] });
            if (response.status !== 200) {
              throw transport.transportError(`Result page HTTP ${response.status}.`, response.status >= 500);
            }
            return await parsePage(response.html);
          } catch (error) {
            if (["RESULT_TRANSPORT_INVALID", "SERVER_COOLDOWN", "ATTEMPT_TIMEOUT"].includes(error.code)) throw error;
            throw transport.transportError("Result page fetch or parsing failed.", true);
          } finally {
            options.allowedResultUrls.delete(url);
          }
        }
      });
      console.log(`    Network results: ${cards.length}/${initial.totalCount}; first-page DOM values verified.`);
      return cards;
    } finally {
      await measure("network_prep", () => parserPage.close());
    }
  }

  async extractSearchOffers(page, fallbackLocation, networkCards) {
    const raw = networkCards || await page.evaluate(readOfferCards, { location: fallbackLocation });

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
        const error = new Error(`Offer currency is ${currency}, expected ${desiredCurrency}.`);
        error.code = "SEARCH_CURRENCY_MISMATCH";
        error.retryable = false;
        throw error;
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
  const sorted = [...byProvider.values()]
    .sort((left, right) => Number(left.total_price) - Number(right.total_price));
  const selected = sorted.slice(0, Number.isFinite(maxProviders) && maxProviders > 0 ? maxProviders : undefined);
  const mm = sorted.find((offer) => normalizeWhitespace(offer.provider).toLowerCase().includes("mm cars rental"));
  if (mm && !selected.includes(mm)) selected.push(mm);
  return selected;
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

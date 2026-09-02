const path = require("path");
const { chromium } = require("playwright");
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
  }

  async run() {
    ensureDir(this.config.artifactsDir);
    const browser = await chromium.launch({ headless: this.config.headless });
    const results = [];
    const failures = [];
    const checks = [];

    try {
      for (const location of this.config.locations) {
        const outcome = await this.runLocationWithRetries(browser, location);
        if (outcome.ok) {
          results.push(...outcome.results);
          checks.push({ location, status: "complete", resultCount: outcome.results.length });
          if (outcome.cheapest) {
            console.log(`OK  ${location} -> ${outcome.cheapest.provider} -> ${formatMoney(outcome.cheapest.total_price, outcome.cheapest.currency)}`);
          } else {
            console.log(`NONE ${location} -> no automatic-transmission offers.`);
          }
        } else {
          failures.push({ location, error: outcome.error.message });
          checks.push({ location, status: "incomplete", resultCount: 0, error: outcome.error.message });
          console.log(`ERR ${location} -> ${outcome.error.message}`);
        }
      }
    } finally {
      await browser.close();
    }

    return { results, failures, checks };
  }

  async runLocationWithRetries(browser, location) {
    for (let retryCount = 0; retryCount <= MAX_TIMEOUT_RETRIES; retryCount += 1) {
      const outcome = await this.runSingleLocation(browser, location);
      if (outcome.ok || !isTimeoutError(outcome.error) || retryCount === MAX_TIMEOUT_RETRIES) {
        return outcome;
      }
      console.log(`RETRY ${location} -> timeout; retry ${retryCount + 1}/${MAX_TIMEOUT_RETRIES}`);
    }
  }

  async runSingleLocation(browser, location) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1200 },
      locale: "en-IE",
      extraHTTPHeaders: {
        "Accept-Language": "en-IE,en;q=0.9,pl;q=0.8"
      }
    });
    await this.configureCurrency(context);
    await context.route("**/*", async (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "font" || type === "media") {
        await route.abort().catch(() => {});
        return;
      }
      await route.continue().catch(() => {});
    });

    const page = await context.newPage();
    page.setDefaultTimeout(this.config.timeoutMs);
    page.setDefaultNavigationTimeout(this.config.timeoutMs);

    try {
      const resolvedLocation = resolveVipCarsLocation(location);
      console.log(`    Search location: ${resolvedLocation.name} (${resolvedLocation.code || resolvedLocation.locationId})`);
      console.log(`    Search time: ${this.config.pickupTime} -> ${this.config.dropoffTime}`);
      await page.goto(this.buildSearchUrl(location), { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".scv-car-box", { timeout: this.config.timeoutMs });
      await this.applyAutomaticTransmissionFilter(page);
      await this.loadSearchResultCards(page);
      const offers = await this.extractSearchOffers(page, location);
      if (!offers.length) {
        return { ok: true, cheapest: null, results: [] };
      }

      const selected = selectBestOffersByProvider(offers, this.config.maxProvidersPerLocation);
      return { ok: true, cheapest: selected[0], results: selected };
    } catch (error) {
      await this.captureFailureArtifacts(page, location);
      return { ok: false, error };
    } finally {
      await context.close();
    }
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

  async loadSearchResultCards(page) {
    let previousCardCount = 0;
    let stableRounds = 0;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const state = await page.evaluate(() => {
        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const isAutomaticCard = (card) => {
          const specsText = normalize(card.querySelector(".scv-car-specs")?.textContent || "");
          const carName = normalize(
            card.querySelector(".scv-car-name")?.textContent ||
            card.querySelector(".scv-car-img img[alt]")?.getAttribute("alt") ||
            ""
          );
          return Boolean(card.querySelector(".scv-car-specs .scv-icon.autom")) ||
            /\bautomatic\b/i.test(`${specsText} ${carName}`);
        };
        const cards = Array.from(document.querySelectorAll(".scv-car-box"));
        const automaticCards = cards.filter(isAutomaticCard);
        const providers = new Set(automaticCards
          .map((card) => normalize(
            card.querySelector(".scv-supp-info img[alt], img[id^='supplier_']")?.getAttribute("alt") ||
            card.querySelector(".scv-supp-info h5")?.textContent ||
            ""
          ))
          .filter(Boolean));
        const totalText = document.getElementById("car_count_data")?.value || document.getElementById("car_count")?.value || "";
        const totalCount = Number.parseInt(totalText, 10);

        return {
          cardCount: cards.length,
          automaticCardCount: automaticCards.length,
          providerCount: providers.size,
          totalCount: Number.isFinite(totalCount) ? totalCount : null
        };
      });

      if (Number.isFinite(state.totalCount) && state.cardCount >= state.totalCount) {
        break;
      }

      stableRounds = state.cardCount === previousCardCount ? stableRounds + 1 : 0;
      if (stableRounds >= 2) {
        break;
      }
      previousCardCount = state.cardCount;

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForFunction(
        ({ previousCount }) => {
          const cards = Array.from(document.querySelectorAll(".scv-car-box"));
          return cards.length > previousCount;
        },
        { previousCount: state.cardCount },
        { timeout: Math.min(this.config.timeoutMs, 10000) }
      ).catch(() => {});
    }
  }

  async applyAutomaticTransmissionFilter(page) {
    const filter = page.locator("#filter_automatic");
    if (!(await filter.count().catch(() => 0))) {
      console.log("    Automatic transmission filter: not found; filtering extracted cards only.");
      return false;
    }

    if (!(await filter.isChecked().catch(() => false))) {
      try {
        await filter.check({ force: true });
      } catch (error) {
        try {
          await page.locator("label", { has: filter }).click({ force: true });
        } catch (fallbackError) {
          console.log("    Automatic transmission filter: could not be clicked; filtering extracted cards only.");
          return false;
        }
      }
    }

    await page.waitForFunction(() => {
      const automaticFilter = document.getElementById("filter_automatic");
      const busy = document.getElementById("page_busy")?.value || "";
      const cards = Array.from(document.querySelectorAll(".scv-car-box"));
      return automaticFilter?.checked && busy !== "1" && cards.length > 0;
    }, null, { timeout: Math.min(this.config.timeoutMs, 15000) }).catch(() => {});

    if (await filter.isChecked().catch(() => false)) {
      console.log("    Automatic transmission filter: applied.");
      return true;
    }

    console.log("    Automatic transmission filter: not confirmed; filtering extracted cards only.");
    return false;
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
        return { provider, rating, priceText, location: defaultLocation, carName, transmission, automatic };
      });
    }, fallbackLocation);

    const offers = [];
    const desiredCurrency = this.getCurrency();
    for (const candidate of raw) {
      const money = parseMoney(candidate.priceText);
      if (!candidate.provider || !money || !isAutomaticTransmissionCandidate(candidate)) {
        continue;
      }
      const currency = normalizeCurrency(money.currency || desiredCurrency);
      if (currency !== desiredCurrency) {
        continue;
      }
      const totalPrice = Number(money.value);
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
        currency,
        source: "search"
      });
    }

    return dedupeOffers(offers);
  }

  async captureFailureArtifacts(page, location) {
    const scenarioName = `${this.config.pickupDate}-${this.config.currentDurationDays}d-${location}`;
    const baseName = safeFilePart(scenarioName) || "location";
    await page.screenshot({
      path: path.join(this.config.artifactsDir, `${baseName}.png`),
      fullPage: true
    }).catch(() => {});
    const html = await page.content().catch(() => "");
    if (html) {
      writeTextFile(path.join(this.config.artifactsDir, `${baseName}.html`), html);
    }
  }
}

const LOCATION_ALIASES = new Map([
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
  resolveVipCarsLocation,
  slugifyLocation
};

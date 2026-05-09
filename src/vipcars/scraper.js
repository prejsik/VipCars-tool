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

class VipCarsScraper {
  constructor(config) {
    this.config = config;
  }

  async run() {
    ensureDir(this.config.artifactsDir);
    const browser = await chromium.launch({ headless: this.config.headless });
    const results = [];
    const failures = [];

    try {
      for (const location of this.config.locations) {
        const outcome = await this.runSingleLocation(browser, location);
        if (outcome.ok) {
          results.push(...outcome.results);
          console.log(`OK  ${location} -> ${outcome.cheapest.provider} -> ${formatMoney(outcome.cheapest.total_price, outcome.cheapest.currency)}`);
        } else {
          failures.push({ location, error: outcome.error.message });
          console.log(`ERR ${location} -> ${outcome.error.message}`);
        }
      }
    } finally {
      await browser.close();
    }

    return { results, failures };
  }

  async runSingleLocation(browser, location) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1200 },
      locale: "en-US"
    });
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
      await page.goto(this.buildLandingUrl(location), { waitUntil: "domcontentloaded" });
      const offers = await this.extractLandingOffers(page, location);
      if (!offers.length) {
        throw new Error("No VipCars offer cards were found on the landing page.");
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

  buildLandingUrl(location) {
    const baseUrl = new URL(this.config.baseUrl);
    return `${baseUrl.origin}/car-rental/poland/${slugifyLocation(location)}`;
  }

  async extractLandingOffers(page, fallbackLocation) {
    const raw = await page.evaluate((defaultLocation) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const cards = Array.from(document.querySelectorAll("#vc-supplier-block .car-deals-grid, .car-deals-grid"));
      return cards.map((card) => {
        const supplierImage = card.querySelector(".supplier-logo img");
        const provider = normalize(
          supplierImage?.getAttribute("alt") ||
          supplierImage?.getAttribute("title") ||
          card.querySelector(".supplier-logo")?.textContent ||
          ""
        );
        const priceText = normalize(
          card.querySelector(".price span")?.textContent ||
          card.querySelector(".price")?.textContent ||
          ""
        );
        const perDay = /\/\s*day|per day/i.test(normalize(card.textContent || ""));
        return { provider, priceText, perDay, location: defaultLocation };
      });
    }, fallbackLocation);

    const offers = [];
    for (const candidate of raw) {
      const money = parseMoney(candidate.priceText);
      if (!candidate.provider || !money) {
        continue;
      }
      const pricePerDay = Number(money.value);
      const totalPrice = candidate.perDay
        ? pricePerDay * Number(this.config.currentDurationDays || 1)
        : pricePerDay;
      offers.push({
        location: fallbackLocation,
        duration_days: Number(this.config.currentDurationDays || 1),
        pickup_date: this.config.pickupDate,
        dropoff_date: this.config.dropoffDate,
        provider: normalizeProvider(candidate.provider),
        provider_rating: "",
        total_price: Number(totalPrice.toFixed(2)),
        price_per_day: Number(pricePerDay.toFixed(2)),
        currency: normalizeCurrency(money.currency || "PLN"),
        source: "landing"
      });
    }

    return dedupeOffers(offers);
  }

  async captureFailureArtifacts(page, location) {
    const baseName = safeFilePart(location) || "location";
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

function slugifyLocation(value) {
  return normalizeWhitespace(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

module.exports = { VipCarsScraper, slugifyLocation };

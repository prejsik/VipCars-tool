function readOfferCards({ html, location, includePageState = false } = {}) {
  if (html !== undefined && typeof html !== "string") {
    throw new Error("Offer page HTML must be a string when provided.");
  }

  const root = html === undefined
    ? document
    : new DOMParser().parseFromString(html, "text/html");
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const cards = Array.from(root.querySelectorAll(".scv-car-box")).map((card) => {
    const supplierImage = card.querySelector(".scv-supp-info img[alt], img[id^='supplier_']");
    const provider = normalize(
      supplierImage?.getAttribute("alt")
      || supplierImage?.getAttribute("title")
      || card.querySelector(".scv-supp-info h5")?.textContent
      || ""
    );
    const rating = normalize(card.querySelector("[id^='supplier_rating_']")?.textContent || "");
    const priceText = normalize(
      card.querySelector(".scv-new-amount")?.textContent
      || card.querySelector(".scv-car-price")?.textContent
      || ""
    );
    const payNowText = normalize(card.querySelector(".scv-pay-now")?.textContent || "");
    const carName = normalize(
      card.querySelector(".scv-car-name")?.textContent
      || card.querySelector(".scv-car-img img[alt]")?.getAttribute("alt")
      || ""
    );
    const transmission = normalize(Array.from(card.querySelectorAll(".scv-car-specs li"))
      .map((item) => item.textContent || "")
      .find((text) => /transmission/i.test(text)) || "");
    const automatic = Boolean(card.querySelector(".scv-car-specs .scv-icon.autom"))
      || /\bautomatic\b/i.test(`${transmission} ${carName}`);
    const vehicleCategory = normalize(card.querySelector(".scv-car-cat")?.textContent || "");
    const cardId = normalize(card.getAttribute("id") || "");
    return {
      cardId,
      provider,
      rating,
      priceText,
      payNowText,
      location,
      carName,
      transmission,
      automatic,
      vehicleCategory
    };
  });

  if (!includePageState) {
    return cards;
  }

  const values = { offset: [], car_page: [], car_count_data: [] };
  const parseInteger = (raw, label) => {
    const text = String(raw).trim();
    const quoted = text.match(/^(['"])(\d+)\1$/);
    const bare = text.match(/^\d+$/);
    const digits = quoted?.[2] || bare?.[0];
    const value = digits === undefined ? NaN : Number(digits);
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${label} must use a numeric literal.`);
    }
    return value;
  };

  const setterPattern = /(?:jQuery|\$)\s*\(\s*(['"])#(offset|car_page|car_count_data)\1\s*\)\s*\.val\s*\(\s*([^)]*?)\s*\)/g;
  for (const script of root.querySelectorAll("script")) {
    setterPattern.lastIndex = 0;
    const source = script.textContent || "";
    let match;
    while ((match = setterPattern.exec(source)) !== null) {
      const argument = match[3].trim();
      if (!argument) continue;
      values[match[2]].push(parseInteger(argument, match[2]));
    }
  }

  for (const id of Object.keys(values)) {
    const nodes = root.querySelectorAll(`#${id}`);
    if (nodes.length > 1) {
      throw new Error(`Ambiguous ${id} value.`);
    }
    if (nodes.length === 1) {
      const node = nodes[0];
      const raw = typeof node.value === "string" ? node.value : node.textContent;
      if (String(raw || "").trim()) {
        values[id].push(parseInteger(raw, id));
      }
    }
  }

  const requireValue = (id) => {
    const unique = [...new Set(values[id])];
    if (!unique.length) {
      throw new Error(`Missing numeric ${id} value.`);
    }
    if (unique.length > 1) {
      throw new Error(`Ambiguous ${id} value.`);
    }
    return unique[0];
  };

  const nextOffset = requireValue("offset");
  const nextPage = requireValue("car_page");
  const totalCount = requireValue("car_count_data");
  const hiddenCounts = root.querySelectorAll("input#car_count");
  if (hiddenCounts.length > 1) {
    throw new Error("Ambiguous car_count value.");
  }
  if (hiddenCounts.length === 1) {
    const raw = String(hiddenCounts[0].value || "").trim();
    if (raw) {
      const hiddenCount = parseInteger(raw, "car_count");
      if (hiddenCount !== totalCount) {
        throw new Error("car_count does not match car_count_data.");
      }
    }
  }

  return { cards, totalCount, nextOffset, nextPage };
}

async function parseOfferPage(page, html, location) {
  return page.evaluate(readOfferCards, { html, location, includePageState: true });
}

module.exports = { readOfferCards, parseOfferPage };

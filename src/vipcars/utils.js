const fs = require("fs");
const path = require("path");

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values ?? []) {
    const normalized = normalizeWhitespace(value);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function writeTextFile(targetPath, content) {
  ensureDir(path.dirname(targetPath));
  fs.writeFileSync(targetPath, content, "utf8");
}

function parseDate(value, fieldName) {
  const raw = normalizeWhitespace(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${fieldName} must use YYYY-MM-DD format. Received: ${value}`);
  }
  const [year, month, day] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`${fieldName} is not a valid date: ${value}`);
  }
  return { year, month, day, raw };
}

function parseTime(value, fieldName) {
  const raw = normalizeWhitespace(value);
  if (!/^\d{2}:\d{2}$/.test(raw)) {
    throw new Error(`${fieldName} must use HH:MM format. Received: ${value}`);
  }
  const [hours, minutes] = raw.split(":").map(Number);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`${fieldName} is not a valid time: ${value}`);
  }
  return { hours, minutes, raw };
}

function parseMoney(rawValue, fallbackCurrency = "") {
  if (rawValue == null) {
    return null;
  }
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return { value: rawValue, currency: fallbackCurrency || "", raw: String(rawValue) };
  }

  const raw = normalizeWhitespace(String(rawValue));
  if (!raw) {
    return null;
  }

  const currencyMatch =
    raw.match(/\b(EUR|USD|GBP|PLN|CHF|CAD|AUD|NZD|SEK|NOK|DKK|CZK|HUF|RON)\b/i) ||
    raw.match(/zl|zł|eur|usd|gbp|€|\$|£/i);
  const currency = currencyMatch ? normalizeCurrency(currencyMatch[0]) : fallbackCurrency || "";
  const numericMatch = raw.match(/(\d{1,3}(?:[\s.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2})|\d+)/);
  if (!numericMatch) {
    return null;
  }

  let numeric = numericMatch[1].replace(/\s+/g, "");
  const hasComma = numeric.includes(",");
  const hasDot = numeric.includes(".");
  if (hasComma && hasDot) {
    numeric = numeric.lastIndexOf(",") > numeric.lastIndexOf(".")
      ? numeric.replace(/\./g, "").replace(",", ".")
      : numeric.replace(/,/g, "");
  } else if (hasComma) {
    const parts = numeric.split(",");
    numeric = parts.length === 2 && parts[1].length <= 2
      ? `${parts[0].replace(/\./g, "")}.${parts[1]}`
      : numeric.replace(/,/g, "");
  } else if (hasDot) {
    const parts = numeric.split(".");
    numeric = parts.length === 2 && parts[1].length <= 2 ? numeric : numeric.replace(/\./g, "");
  }

  const value = Number.parseFloat(numeric);
  return Number.isFinite(value) ? { value, currency, raw } : null;
}

function normalizeCurrency(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) {
    return "";
  }
  if (normalized === "ZL" || normalized === "ZŁ") {
    return "PLN";
  }
  if (normalized === "€" || normalized === "EUR") {
    return "EUR";
  }
  if (normalized === "$" || normalized === "USD") {
    return "USD";
  }
  if (normalized === "£" || normalized === "GBP") {
    return "GBP";
  }
  return normalized;
}

function formatMoney(value, currency = "") {
  if (!Number.isFinite(value)) {
    return "";
  }
  return `${value.toFixed(2)}${currency ? ` ${currency}` : ""}`;
}

function toCsv(rows) {
  const header = [
    "location",
    "duration_days",
    "pickup_date",
    "dropoff_date",
    "provider",
    "provider_rating",
    "total_price",
    "price_per_day",
    "currency",
    "source"
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((key) => escapeCsv(row[key])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function escapeCsv(value) {
  const stringValue = String(value ?? "");
  return /[",\n]/.test(stringValue) ? `"${stringValue.replace(/"/g, "\"\"")}"` : stringValue;
}

function safeFilePart(value) {
  return normalizeWhitespace(value).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

function addDaysToIsoDate(dateString, daysToAdd) {
  const baseDate = new Date(`${dateString}T00:00:00Z`);
  baseDate.setUTCDate(baseDate.getUTCDate() + daysToAdd);
  return baseDate.toISOString().slice(0, 10);
}

module.exports = {
  addDaysToIsoDate,
  ensureDir,
  formatMoney,
  normalizeCurrency,
  normalizeWhitespace,
  parseDate,
  parseMoney,
  parseTime,
  safeFilePart,
  toCsv,
  uniqueStrings,
  writeTextFile
};

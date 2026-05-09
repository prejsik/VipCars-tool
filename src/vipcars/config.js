const fs = require("fs");
const path = require("path");
const {
  normalizeWhitespace,
  parseDate,
  parseTime,
  uniqueStrings
} = require("./utils");

function parseCliArgs(argv) {
  const args = { locations: [], durationDays: [], pickupWeekdays: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    if (key === "headed") {
      args.headless = false;
      continue;
    }
    if (key === "headless") {
      args.headless = true;
      continue;
    }
    if (key === "help") {
      args.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) {
      throw new Error(`Missing value for argument: ${token}`);
    }
    index += 1;
    if (key === "location") {
      args.locations.push(value);
    } else if (key === "locations") {
      args.locations.push(...splitList(value));
    } else if (key === "duration-days") {
      args.durationDays.push(value);
    } else if (key === "durations-days") {
      args.durationDays.push(...splitList(value));
    } else if (key === "pickup-weekday") {
      args.pickupWeekdays.push(value);
    } else if (key === "pickup-weekdays") {
      args.pickupWeekdays.push(...splitList(value));
    } else {
      args[key] = value;
    }
  }
  return args;
}

function splitList(value) {
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function parseDurationDaysInput(rawValue, fieldName) {
  if (rawValue == null) {
    return [];
  }
  const parts = Array.isArray(rawValue)
    ? rawValue.flatMap((item) => String(item).split(","))
    : String(rawValue).split(",");
  const values = [];
  for (const part of parts) {
    const normalized = normalizeWhitespace(part);
    if (!normalized) {
      continue;
    }
    const parsed = Number.parseInt(normalized, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error(`${fieldName} must contain positive integers. Received: ${part}`);
    }
    values.push(parsed);
  }
  return [...new Set(values)].sort((left, right) => left - right);
}

function parsePickupWeekdaysInput(rawValue, fieldName) {
  if (rawValue == null) {
    return [];
  }
  const parts = Array.isArray(rawValue)
    ? rawValue.flatMap((item) => String(item).split(","))
    : String(rawValue).split(",");
  const mapping = new Map([
    ["sunday", 0], ["sun", 0], ["niedziela", 0],
    ["monday", 1], ["mon", 1], ["poniedzialek", 1],
    ["tuesday", 2], ["tue", 2], ["wtorek", 2],
    ["wednesday", 3], ["wed", 3], ["sroda", 3],
    ["thursday", 4], ["thu", 4], ["czwartek", 4],
    ["friday", 5], ["fri", 5], ["piatek", 5],
    ["saturday", 6], ["sat", 6], ["sobota", 6]
  ]);
  const weekdays = [];
  for (const part of parts) {
    const normalized = String(part || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    if (!normalized) {
      continue;
    }
    if (/^[0-6]$/.test(normalized)) {
      weekdays.push(Number.parseInt(normalized, 10));
      continue;
    }
    const value = mapping.get(normalized);
    if (value == null) {
      throw new Error(`${fieldName} contains unsupported day: ${part}`);
    }
    weekdays.push(value);
  }
  return [...new Set(weekdays)];
}

function nearestWeekdayDateFromNow(targetWeekday) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const offset = (targetWeekday - today.getDay() + 7) % 7;
  today.setDate(today.getDate() + offset);
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
}

function loadConfig(argv) {
  const cli = parseCliArgs(argv);
  if (cli.help) {
    return { help: true };
  }

  let fileConfig = {};
  if (cli.config) {
    fileConfig = JSON.parse(fs.readFileSync(path.resolve(cli.config), "utf8"));
  }

  const merged = { ...fileConfig, ...cli };
  const locations = uniqueStrings([
    ...(Array.isArray(fileConfig.locations) ? fileConfig.locations : []),
    ...(cli.locations || [])
  ]);

  const pickupDate = merged.pickupDate ?? merged["pickup-date"];
  const pickupTime = merged.pickupTime ?? merged["pickup-time"];
  const dropoffDate = merged.dropoffDate ?? merged["dropoff-date"];
  const dropoffTime = merged.dropoffTime ?? merged["dropoff-time"];
  if (!locations.length) {
    throw new Error("At least one location is required.");
  }
  if (!pickupDate || !pickupTime || !dropoffDate || !dropoffTime) {
    throw new Error("pickupDate, pickupTime, dropoffDate, and dropoffTime are required.");
  }

  parseDate(pickupDate, "pickupDate");
  parseDate(dropoffDate, "dropoffDate");
  parseTime(pickupTime, "pickupTime");
  parseTime(dropoffTime, "dropoffTime");

  const configuredDurations = parseDurationDaysInput([
    ...parseDurationDaysInput(
      fileConfig.durationsDays ?? fileConfig["durations-days"] ?? fileConfig.durationDays,
      "durationsDays"
    ),
    ...parseDurationDaysInput(cli.durationDays, "duration-days")
  ], "durationsDays");

  const pickupWeekdays = [
    ...parsePickupWeekdaysInput(fileConfig.pickupWeekdays ?? fileConfig["pickup-weekdays"], "pickupWeekdays"),
    ...parsePickupWeekdaysInput(cli.pickupWeekdays, "pickup-weekdays")
  ];

  return {
    baseUrl: normalizeWhitespace(merged.baseUrl || "https://www.vipcars.com/pl"),
    locations,
    pickupDate,
    pickupDateOptions: pickupWeekdays.length
      ? [...new Set(pickupWeekdays)].map(nearestWeekdayDateFromNow).sort()
      : [pickupDate],
    pickupTime: normalizeWhitespace(pickupTime),
    dropoffDate,
    dropoffTime: normalizeWhitespace(dropoffTime),
    durationDays: configuredDurations.length ? configuredDurations : [2],
    residenceCountry: normalizeWhitespace(merged.residenceCountry || merged["residence-country"] || "Poland"),
    driverAge: Number.parseInt(merged.driverAge || merged["driver-age"] || "30", 10),
    maxProvidersPerLocation: Number.parseInt(merged.maxProvidersPerLocation || "25", 10),
    timeoutMs: Number.parseInt(merged.timeoutMs || merged["timeout-ms"] || "45000", 10),
    locationConcurrency: Number.parseInt(merged.locationConcurrency || merged["location-concurrency"] || "1", 10),
    headless: merged.headless !== false,
    outputCsv: path.resolve(merged.outputCsv || merged["output-csv"] || path.join("output", "vipcars-results.csv")),
    artifactsDir: path.resolve(merged.artifactsDir || merged["artifacts-dir"] || path.join("artifacts", "vipcars"))
  };
}

function printHelp() {
  process.stdout.write(`VipCars scraper

Usage:
  node src/vipcars/cli.js --config vipcars.config.example.json

Options:
  --config PATH
  --location TEXT
  --locations "A,B,C"
  --pickup-date YYYY-MM-DD
  --pickup-time HH:MM
  --dropoff-date YYYY-MM-DD
  --dropoff-time HH:MM
  --pickup-weekdays "thursday,friday"
  --durations-days "2,3"
  --output-csv PATH
  --headed
  --help
`);
}

module.exports = { loadConfig, printHelp };

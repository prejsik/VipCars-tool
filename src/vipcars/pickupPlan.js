const { loadConfig } = require("./config");
const { parseTime } = require("./utils");

function referenceStartDate(referenceAt, pickupTime, fieldName) {
  const isoTimestamp = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
  const reference = new Date(referenceAt);
  const calendarDate = new Date(`${String(referenceAt).slice(0, 10)}T00:00:00Z`);
  if (typeof referenceAt !== "string" || !isoTimestamp.test(referenceAt)
      || !Number.isFinite(reference.getTime()) || !Number.isFinite(calendarDate.getTime())
      || calendarDate.toISOString().slice(0, 10) !== referenceAt.slice(0, 10)) {
    throw new Error(`${fieldName} must be a valid ISO timestamp with an explicit timezone (Z or +/-HH:MM).`);
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(reference).map(({ type, value }) => [type, value]));
  const start = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  const { hours, minutes } = parseTime(pickupTime, "pickupTime");
  if (Number(parts.hour) * 60 + Number(parts.minute) >= hours * 60 + minutes) {
    start.setUTCDate(start.getUTCDate() + 1);
  }
  return start;
}

function dateAfterDays(start, offset) {
  // Step through calendar dates in UTC so DST cannot repeat or skip a pickup day.
  const date = new Date(start);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function scheduledPickupDates(scheduledAt, dayCount) {
  const start = referenceStartDate(scheduledAt, "16:30", "scheduled-at");
  if (!Number.isSafeInteger(dayCount) || dayCount < 1) {
    throw new Error("dayCount must be a positive integer; scheduled mode requires pickup-rolling-days.");
  }
  return Array.from({ length: dayCount }, (_, index) => dateAfterDays(start, index));
}

function runPickupDates(runCreatedAt, argv = process.argv.slice(2)) {
  const config = loadConfig(argv);
  const start = referenceStartDate(runCreatedAt, config.pickupTime, "run-created-at");
  if (argv.includes("--pickup-dates")) return config.pickupDateOptions;
  const dates = config.pickupRollingDays
    ? Array.from({ length: config.pickupRollingDays }, (_, index) => dateAfterDays(start, index))
    : config.pickupWeekdays.length
    ? config.pickupWeekdays.map((weekday) => dateAfterDays(start, (weekday - start.getUTCDay() + 7) % 7)).sort()
    : [config.pickupDate];
  return loadConfig([...argv, "--pickup-dates", dates.join(",")]).pickupDateOptions;
}

function pickupCount(argv = process.argv.slice(2)) {
  return loadConfig(argv).pickupDateOptions.length;
}

function scrapeMatrix(argv = process.argv.slice(2)) {
  const config = loadConfig(argv);
  if (config.locations.length > 21) {
    throw new Error("Scrape plan supports at most 21 locations per shard; split the requested locations.");
  }
  const durationGroups = [[], [], []];
  for (const duration of config.durationDays) {
    durationGroups[duration <= 6 ? 0 : duration <= 8 ? 1 : 2].push(duration);
  }
  const maxDurations = Math.floor(21 / config.locations.length);
  const include = [];
  for (const date of config.pickupDateOptions) {
    for (const durations of durationGroups) {
      for (let offset = 0; offset < durations.length; offset += maxDurations) {
        include.push({ chunk: include.length + 1, pickup_dates: date,
          durations: durations.slice(offset, offset + maxDurations).join(",") });
      }
    }
  }
  if (include.length > 256) {
    throw new Error("Scrape plan exceeds the 256-job matrix limit; split the requested date range.");
  }
  return { include };
}

if (require.main === module) {
  try {
    const argv = process.argv.slice(2);
    const scheduledAtIndex = argv.indexOf("--scheduled-at");
    const runCreatedAtIndex = argv.indexOf("--run-created-at");
    if (scheduledAtIndex !== -1 && runCreatedAtIndex !== -1) {
      throw new Error("Use only one of --scheduled-at and --run-created-at.");
    }
    if ((scheduledAtIndex !== -1 || runCreatedAtIndex !== -1)
        && (!argv.includes("--dates") || argv.includes("--matrix"))) {
      throw new Error(`${scheduledAtIndex !== -1 ? "scheduled-at" : "run-created-at"} is only supported with --dates.`);
    }
    const configArgs = argv.filter((arg) => !["--dates", "--matrix"].includes(arg));
    if (argv.includes("--matrix")) console.log(JSON.stringify(scrapeMatrix(configArgs)));
    else {
      const dates = scheduledAtIndex !== -1
        ? scheduledPickupDates(argv[scheduledAtIndex + 1], loadConfig(configArgs).pickupRollingDays)
        : runCreatedAtIndex !== -1
        ? runPickupDates(argv[runCreatedAtIndex + 1], configArgs)
        : loadConfig(configArgs).pickupDateOptions;
      console.log(argv.includes("--dates") ? dates.join(",") : dates.length);
    }
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

module.exports = { pickupCount, scrapeMatrix, scheduledPickupDates, runPickupDates };

const { loadConfig } = require("./config");

function pickupCount(argv = process.argv.slice(2)) {
  return loadConfig(argv).pickupDateOptions.length;
}

function scrapeMatrix(argv = process.argv.slice(2)) {
  const config = loadConfig(argv);
  const durationGroups = [[], [], []];
  for (const duration of config.durationDays) {
    durationGroups[duration <= 6 ? 0 : duration <= 8 ? 1 : 2].push(duration);
  }
  const maxDurations = Math.max(1, Math.floor(42 / config.locations.length));
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
    const configArgs = argv.filter((arg) => !["--dates", "--matrix"].includes(arg));
    if (argv.includes("--matrix")) console.log(JSON.stringify(scrapeMatrix(configArgs)));
    else {
      const dates = loadConfig(configArgs).pickupDateOptions;
      console.log(argv.includes("--dates") ? dates.join(",") : dates.length);
    }
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

module.exports = { pickupCount, scrapeMatrix };

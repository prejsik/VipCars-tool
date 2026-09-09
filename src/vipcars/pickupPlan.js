const { loadConfig } = require("./config");

function pickupCount(argv = process.argv.slice(2)) {
  return loadConfig(argv).pickupDateOptions.length;
}

if (require.main === module) {
  try {
    const argv = process.argv.slice(2);
    const dates = loadConfig(argv.filter((arg) => arg !== "--dates")).pickupDateOptions;
    console.log(argv.includes("--dates") ? dates.join(",") : dates.length);
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

module.exports = { pickupCount };

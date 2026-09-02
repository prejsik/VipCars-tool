const { loadConfig } = require("./config");

function pickupCount(argv = process.argv.slice(2)) {
  return loadConfig(argv).pickupDateOptions.length;
}

if (require.main === module) {
  try {
    console.log(pickupCount());
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

module.exports = { pickupCount };

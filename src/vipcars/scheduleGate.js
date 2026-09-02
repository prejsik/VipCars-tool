#!/usr/bin/env node

const WARSAW_TIME_ZONE = "Europe/Warsaw";
const SCHEDULES = [
  { cron: "30 0 * * *", utcHour: "00" },
  { cron: "30 1 * * *", utcHour: "01" }
];

function selectScheduleForWarsawDate(isoDate) {
  const matching = SCHEDULES.filter(({ utcHour }) => {
    const local = localDateTime(`${isoDate}T${utcHour}:30:00Z`);
    return local.date === isoDate && local.time === "02:30";
  });

  if (matching.length) {
    return matching[matching.length - 1].cron;
  }
  return SCHEDULES[SCHEDULES.length - 1].cron;
}

function localDateTime(isoDateTime) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: WARSAW_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(isoDateTime));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`
  };
}

if (require.main === module) {
  const isoDate = process.argv[2];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ""))) {
    throw new Error("Expected Warsaw date in YYYY-MM-DD format.");
  }
  process.stdout.write(`${selectScheduleForWarsawDate(isoDate)}\n`);
}

module.exports = { selectScheduleForWarsawDate };

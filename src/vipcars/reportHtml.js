const fs = require("fs");
const path = require("path");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseCsv(content) {
  const rows = [];
  let field = "";
  let row = [];
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const [header = [], ...dataRows] = rows.filter((item) => item.length && item.some(Boolean));
  return dataRows.map((dataRow) => Object.fromEntries(header.map((key, index) => [key, dataRow[index] ?? ""])));
}

function scenarioKey(row) {
  return `${row.pickup_date}|${row.dropoff_date}|${row.duration_days}`;
}

function groupByScenario(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = scenarioKey(row);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .map(([key, scenarioRows]) => {
      const [pickupDate, dropoffDate, durationDays] = key.split("|");
      return { pickupDate, dropoffDate, durationDays, rows: scenarioRows };
    })
    .sort((left, right) => {
      if (left.pickupDate !== right.pickupDate) {
        return left.pickupDate.localeCompare(right.pickupDate);
      }
      return Number(left.durationDays || 0) - Number(right.durationDays || 0);
    });
}

function groupLocationOffers(rows) {
  const byLocation = new Map();
  for (const row of rows) {
    const location = row.location || "Unknown";
    if (!byLocation.has(location)) {
      byLocation.set(location, []);
    }
    byLocation.get(location).push(row);
  }
  return [...byLocation.entries()]
    .map(([location, offers]) => ({
      location,
      offers: [...offers].sort((left, right) => dailyRate(left) - dailyRate(right))
    }))
    .sort((left, right) => left.location.localeCompare(right.location));
}

function isMmCarsProvider(value) {
  return String(value || "").trim().toLowerCase().includes("mm cars rental");
}

function isEurOffer(offer) {
  return String(offer?.currency || "").toUpperCase() === "EUR";
}

function isSameCurrency(left, right) {
  return String(left?.currency || "").toUpperCase() === String(right?.currency || "").toUpperCase();
}

function dailyRate(offer) {
  const rawRate = String(offer?.price_per_day ?? "").trim();
  if (rawRate) {
    const explicitRate = Number(rawRate);
    if (Number.isFinite(explicitRate)) {
      return explicitRate;
    }
  }
  const totalPrice = Number(offer?.total_price);
  const durationDays = Number(offer?.duration_days);
  return Number.isFinite(totalPrice) && Number.isFinite(durationDays) && durationDays > 0
    ? totalPrice / durationDays
    : NaN;
}

function mmClassName(offer, rankedOffers) {
  if (!isMmCarsProvider(offer?.provider)) {
    return "";
  }
  if (!Number.isFinite(dailyRate(offer)) || !isEurOffer(offer)) {
    return "mm";
  }

  const offers = Array.isArray(rankedOffers) ? rankedOffers.filter(Boolean) : [];
  const rank = offers.findIndex((item) => item === offer);
  const thresholdPerDay = 2.5;

  if (rank === 0) {
    const nextCompetitor = offers.find((item) => item && !isMmCarsProvider(item.provider) && isSameCurrency(offer, item));
    if (!nextCompetitor || !Number.isFinite(dailyRate(nextCompetitor))) {
      return "mm";
    }
    const gapPerDay = dailyRate(nextCompetitor) - dailyRate(offer);
    return gapPerDay > thresholdPerDay ? "mm mm-top1-gap" : "mm";
  }

  const cheaperCompetitors = offers
    .slice(0, rank < 0 ? offers.length : rank)
    .filter((item) => item && !isMmCarsProvider(item.provider) && isSameCurrency(offer, item));
  for (const competitor of cheaperCompetitors) {
    if (!Number.isFinite(dailyRate(competitor))) {
      continue;
    }
    const gapPerDay = dailyRate(offer) - dailyRate(competitor);
    if (gapPerDay >= 0 && gapPerDay <= thresholdPerDay) {
      return "mm mm-close";
    }
  }

  return "mm";
}

function formatProvider(offer) {
  if (!offer) {
    return "Not available";
  }
  const rating = offer.provider_rating ? ` (${offer.provider_rating})` : "";
  return `${offer.provider || "Not available"}${rating}`;
}

function formatDailyRate(offer) {
  const rate = dailyRate(offer);
  if (!Number.isFinite(rate)) {
    return "Not available";
  }
  return `${rate.toFixed(2)} ${offer.currency || ""}/day`.trim();
}

function buildOfferCells(offers, index) {
  const offer = offers[index];
  const className = mmClassName(offer, offers);
  const classAttribute = className ? ` class="${className}"` : "";
  return `<td${classAttribute}>${escapeHtml(formatProvider(offer))}</td><td${classAttribute}>${escapeHtml(formatDailyRate(offer))}</td>`;
}

function buildScenarioTable(scenario, index, total) {
  const rows = groupLocationOffers(scenario.rows).map((group, rowIndex) => `<tr>
        <td class="index">${rowIndex}</td>
        <td>${escapeHtml(group.location)}</td>
        ${buildOfferCells(group.offers, 0)}
        ${buildOfferCells(group.offers, 1)}
        ${buildOfferCells(group.offers, 2)}
      </tr>`).join("\n");

  return `<section class="scenario">
    <h2>Scenario ${index + 1}/${total}: ${escapeHtml(scenario.pickupDate)} -> ${escapeHtml(scenario.dropoffDate)} (${escapeHtml(scenario.durationDays)} days)</h2>
    <table>
      <thead>
        <tr>
          <th>(index)</th>
          <th>location</th>
          <th>top1_offer</th>
          <th>top1_rate_per_day</th>
          <th>top2_offer</th>
          <th>top2_rate_per_day</th>
          <th>top3_offer</th>
          <th>top3_rate_per_day</th>
        </tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="8">No offers extracted.</td></tr>`}</tbody>
    </table>
  </section>`;
}

function buildHtmlReport(rows, generatedAt = new Date().toISOString()) {
  const scenarios = groupByScenario(rows);
  return `<!doctype html>
<html lang="pl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VipCars report</title>
  <style>
    :root {
      --bg: #0b0d10;
      --line: #d7d7d7;
      --text: #e9edf2;
      --muted: #9aa4b2;
      --green: #22e642;
      --yellow-bg: #caa300;
      --yellow-text: #253040;
      --blue-bg: #1e5bd7;
      --blue-text: #ffffff;
      --good-bg: #14823b;
      --good-text: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Consolas, "Cascadia Mono", "Courier New", monospace;
      padding: 24px;
    }
    h1 { margin: 0 0 6px; font-size: 22px; }
    .meta { color: var(--muted); margin-bottom: 24px; font-size: 13px; }
    .scenario { margin: 0 0 34px; padding-top: 8px; border-top: 2px solid #2d333b; overflow-x: auto; }
    h2 { margin: 0 0 8px; font-size: 16px; }
    table { width: 100%; border-collapse: collapse; background: #0d0f12; border: 2px solid var(--line); }
    th, td { border: 2px solid var(--line); padding: 8px 11px; text-align: left; white-space: nowrap; }
    th { color: var(--text); background: #111; }
    td { color: var(--green); font-weight: 700; }
    td.index { color: var(--text); width: 72px; }
    .mm { background: var(--yellow-bg); color: var(--yellow-text); }
    .mm-close { background: var(--blue-bg); color: var(--blue-text); }
    .mm-top1-gap { background: var(--good-bg); color: var(--good-text); }
    .legend { margin: 0 0 18px; color: var(--muted); font-size: 13px; }
    .badge { display: inline-block; padding: 2px 7px; background: var(--yellow-bg); color: var(--yellow-text); }
    .badge.close { background: var(--blue-bg); color: var(--blue-text); }
    .badge.good { background: var(--good-bg); color: var(--good-text); }
    @media (max-width: 980px) { body { padding: 14px; } table { min-width: 900px; } }
  </style>
</head>
<body>
  <h1>VipCars report</h1>
  <div class="meta">Generated at: ${escapeHtml(generatedAt)} | Source: https://www.vipcars.com</div>
  <div class="legend">
    <span class="badge">MM Cars Rental</span> MM Cars Rental in table
    <span class="badge close">MM close</span> MM max 2.5 EUR/day above a cheaper competitor
    <span class="badge good">MM top1 gap</span> MM is cheapest and next competitor is over 2.5 EUR/day more expensive
  </div>
  ${scenarios.map((scenario, index) => buildScenarioTable(scenario, index, scenarios.length)).join("\n") || "<p>No offers extracted.</p>"}
</body>
</html>`;
}

function generateReportFromFile(inputPath, outputPath) {
  const rows = parseCsv(fs.readFileSync(inputPath, "utf8"));
  const targetPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, buildHtmlReport(rows), "utf8");
  return targetPath;
}

if (require.main === module) {
  const inputPath = process.argv[2] || "output/vipcars-results.csv";
  const outputPath = process.argv[3] || "output/vipcars-report.html";
  console.log(`VipCars HTML report saved to ${generateReportFromFile(inputPath, outputPath)}`);
}

module.exports = { buildHtmlReport, generateReportFromFile, parseCsv };

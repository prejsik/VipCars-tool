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

  const previousCompetitor = rank > 0 ? offers[rank - 1] : null;
  if (
    previousCompetitor &&
    !isMmCarsProvider(previousCompetitor.provider) &&
    isSameCurrency(offer, previousCompetitor) &&
    Number.isFinite(dailyRate(previousCompetitor))
  ) {
    const gapPerDay = dailyRate(offer) - dailyRate(previousCompetitor);
    if (gapPerDay > 0 && gapPerDay <= thresholdPerDay) {
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

function mmOfferSummary(offers) {
  const rankIndex = offers.findIndex((offer) => isMmCarsProvider(offer?.provider));
  if (rankIndex < 0) {
    return {
      offer: null,
      rankLabel: "Brak MM",
      cheaperOffers: "Brak danych",
      state: "missing",
      className: ""
    };
  }

  const offer = offers[rankIndex];
  const className = mmClassName(offer, offers);
  let state = "normal";
  if (className.includes("mm-top1-gap")) {
    state = "top1-gap";
  } else if (className.includes("mm-close")) {
    state = "close";
  }

  return {
    offer,
    rankLabel: `Top ${rankIndex + 1}`,
    cheaperOffers: String(rankIndex),
    state,
    className
  };
}

function buildMmSummaryCells(summary) {
  const classAttribute = summary.className ? ` class="${summary.className}"` : " class=\"muted\"";
  return `<td${classAttribute}>${escapeHtml(formatDailyRate(summary.offer))}</td>
        <td class="rank-cell">${escapeHtml(summary.rankLabel)}</td>
        <td class="count-cell">${escapeHtml(summary.cheaperOffers)}</td>`;
}

function buildScenarioTable(scenario, index, total) {
  const rows = scenario.locations.map((group, rowIndex) => {
    const mmSummary = mmOfferSummary(group.offers);
    return `<tr data-location="${escapeHtml(group.location)}" data-mm-state="${escapeHtml(mmSummary.state)}">
        <td class="index">${rowIndex}</td>
        <td>${escapeHtml(group.location)}</td>
        ${buildOfferCells(group.offers, 0)}
        ${buildOfferCells(group.offers, 1)}
        ${buildOfferCells(group.offers, 2)}
        ${buildOfferCells(group.offers, 3)}
        ${buildMmSummaryCells(mmSummary)}
      </tr>`;
  }).join("\n");

  return `<section class="scenario" data-date="${escapeHtml(scenario.pickupDate)}" data-duration="${escapeHtml(scenario.durationDays)}">
    <h2>Scenario ${index + 1}/${total}: ${escapeHtml(scenario.pickupDate)} + ${escapeHtml(scenario.durationDays)} day(s)</h2>
    <div class="period">${escapeHtml(scenario.pickupDate)} -> ${escapeHtml(scenario.dropoffDate)} (rental_days=${escapeHtml(scenario.durationDays)})</div>
    <table>
      <colgroup>
        <col class="col-index">
        <col class="col-location">
        <col class="col-company"><col class="col-rate">
        <col class="col-company"><col class="col-rate">
        <col class="col-company"><col class="col-rate">
        <col class="col-company"><col class="col-rate">
        <col class="col-mm-rate"><col class="col-rank"><col class="col-count">
      </colgroup>
      <thead>
        <tr>
          <th>#</th>
          <th>Lokalizacja</th>
          <th>Top 1 firma</th>
          <th>Top 1 EUR/d</th>
          <th>Top 2 firma</th>
          <th>Top 2 EUR/d</th>
          <th>Top 3 firma</th>
          <th>Top 3 EUR/d</th>
          <th>Top 4 firma</th>
          <th>Top 4 EUR/d</th>
          <th>MM EUR/d</th>
          <th>Pozycja MM</th>
          <th>Tańsze oferty</th>
        </tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="13">No offers extracted.</td></tr>`}</tbody>
    </table>
  </section>`;
}

function uniqueValues(values, compare) {
  return [...new Set(values.filter(Boolean))].sort(compare);
}

function buildMultiFilter(id, label, options) {
  const optionHtml = options.map(({ value, text }) => `<label class="multi-option"><input type="checkbox" value="${escapeHtml(value)}"><span>${escapeHtml(text)}</span></label>`).join("");
  return `<div class="filter-field">
      <span class="filter-label">${escapeHtml(label)}</span>
      <details class="multi-filter" id="${escapeHtml(id)}" data-all-label="Wszystkie">
        <summary>Wszystkie</summary>
        <div class="multi-options">${optionHtml}</div>
      </details>
    </div>`;
}

function reportSummary(scenarios) {
  const locationGroups = scenarios.flatMap((scenario) => scenario.locations);
  const mmStates = locationGroups.map((group) => mmOfferSummary(group.offers).state);
  return {
    scenarioCount: scenarios.length,
    locationCheckCount: locationGroups.length,
    missingMmCount: mmStates.filter((state) => state === "missing").length,
    closeMmCount: mmStates.filter((state) => state === "close").length,
    top1GapCount: mmStates.filter((state) => state === "top1-gap").length
  };
}

function buildHtmlReport(rows, generatedAt = new Date().toISOString()) {
  const scenarios = groupByScenario(rows).map((scenario) => ({
    ...scenario,
    locations: groupLocationOffers(scenario.rows)
  }));
  const summary = reportSummary(scenarios);
  const locations = uniqueValues(rows.map((row) => row.location || "Unknown"), (left, right) => left.localeCompare(right));
  const durations = uniqueValues(rows.map((row) => row.duration_days), (left, right) => Number(left) - Number(right));
  const locationFilter = buildMultiFilter("filter-location", "Lokalizacja", locations.map((location) => ({ value: location, text: location })));
  const durationFilter = buildMultiFilter("filter-duration", "Duration", durations.map((duration) => ({ value: duration, text: `${duration} dni` })));
  const stateFilter = buildMultiFilter("filter-state", "Stan MM", [
    { value: "missing", text: "Brak MM" },
    { value: "top1-gap", text: "Top1: przewaga ponad 2,5 EUR/d" },
    { value: "close", text: "Do 2,5 EUR/d od wyższej pozycji" },
    { value: "normal", text: "Pozostałe" }
  ]);
  return `<!doctype html>
<html lang="pl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VipCars report</title>
  <style>
    :root {
      --bg: #0b0d10;
      --panel: #11151b;
      --line: #d7d7d7;
      --text: #e9edf2;
      --muted: #9aa4b2;
      --green: #22e642;
      --yellow-bg: #caa300;
      --yellow-text: #253040;
      --blue-bg: #1e5bd7;
      --blue-text: #ffffff;
      --red-bg: #c62828;
      --red-text: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Consolas, "Cascadia Mono", "Courier New", monospace;
      padding: 24px;
    }
    [hidden] { display: none !important; }
    h1 { margin: 0 0 6px; font-size: 22px; font-weight: 700; }
    .meta { color: var(--muted); margin-bottom: 24px; font-size: 13px; }
    .summary { color: var(--muted); margin-bottom: 14px; font-size: 13px; }
    .scenario { margin: 0 0 34px; padding-top: 8px; border-top: 2px solid #2d333b; overflow-x: visible; }
    h2 { margin: 0 0 4px; font-size: 16px; font-weight: 700; }
    .period { color: var(--text); margin-bottom: 8px; font-size: 14px; }
    table { width: 100%; border-collapse: collapse; background: #0d0f12; border: 2px solid var(--line); table-layout: fixed; }
    col.col-index { width: 3%; }
    col.col-location { width: 11%; }
    col.col-company { width: 9%; }
    col.col-rate { width: 7%; }
    col.col-mm-rate { width: 7%; }
    col.col-rank { width: 7%; }
    col.col-count { width: 8%; }
    th, td {
      border: 2px solid var(--line);
      padding: 6px 7px;
      text-align: left;
      white-space: normal;
      vertical-align: middle;
      overflow-wrap: anywhere;
      line-height: 1.25;
    }
    th { color: var(--text); font-weight: 700; background: #111; font-size: 11px; }
    td { color: var(--green); font-weight: 700; font-size: 12px; }
    th:nth-child(4), th:nth-child(6), th:nth-child(8), th:nth-child(10), th:nth-child(11), th:nth-child(12), th:nth-child(13),
    td:nth-child(4), td:nth-child(6), td:nth-child(8), td:nth-child(10), td:nth-child(11), td:nth-child(12), td:nth-child(13) {
      text-align: right;
      white-space: nowrap;
    }
    td.index { color: var(--text); text-align: center; }
    .mm { background: var(--yellow-bg); color: var(--yellow-text); }
    .mm-close { background: var(--red-bg); color: var(--red-text); }
    .mm-top1-gap { background: var(--blue-bg); color: var(--blue-text); }
    .legend { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 24px; color: var(--muted); font-size: 13px; }
    .badge { display: inline-block; padding: 3px 8px; border-radius: 4px; background: var(--yellow-bg); color: var(--yellow-text); font-weight: 700; }
    .badge.close { background: var(--red-bg); color: var(--red-text); }
    .badge.good { background: var(--blue-bg); color: var(--blue-text); }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: 10px;
      margin: 0 0 18px;
      padding: 12px 0;
      border-top: 1px solid #2d333b;
      border-bottom: 1px solid #2d333b;
    }
    .toolbar > label, .filter-label { color: var(--muted); font-size: 12px; }
    .toolbar select, .toolbar input[type="date"], .multi-filter > summary {
      display: block;
      margin-top: 4px;
      min-height: 34px;
      border: 1px solid #596273;
      border-radius: 4px;
      background: var(--panel);
      color: var(--text);
      padding: 5px 8px;
    }
    .toolbar select:disabled { opacity: 1; }
    .filter-field { min-width: 150px; }
    .filter-label { display: block; }
    .multi-filter { position: relative; margin-top: 4px; }
    .multi-filter > summary { min-width: 150px; cursor: pointer; list-style: none; line-height: 22px; }
    .multi-filter > summary::-webkit-details-marker { display: none; }
    .multi-filter > summary::after { content: "▾"; float: right; margin-left: 12px; }
    .multi-filter[open] > summary::after { content: "▴"; }
    .multi-options {
      position: absolute;
      z-index: 20;
      top: calc(100% + 4px);
      left: 0;
      min-width: 220px;
      max-width: 340px;
      max-height: 280px;
      overflow-y: auto;
      border: 1px solid #596273;
      border-radius: 4px;
      background: var(--panel);
      box-shadow: 0 8px 20px #00000066;
      padding: 6px;
    }
    .multi-option { display: flex; align-items: flex-start; gap: 8px; padding: 7px 6px; color: var(--text); font-size: 12px; cursor: pointer; }
    .multi-option:hover { background: #242b35; }
    .multi-option input { flex: 0 0 auto; margin: 1px 0 0; }
    .rank-cell, .count-cell { color: var(--text); }
    .muted { color: var(--muted); }
    @media (max-width: 1100px) {
      body { padding: 14px; }
      th, td { padding: 5px; }
      td { font-size: 11px; }
    }
    @media (max-width: 1200px) {
      body { padding: 10px; }
      .scenario { margin-bottom: 26px; }
      table, tbody, tr, td { display: block; width: 100%; }
      table { border: 0; background: transparent; }
      colgroup, thead { display: none; }
      tbody { display: grid; gap: 10px; }
      tr { border: 1px solid var(--line); background: #0d0f12; }
      td, td.index,
      td:nth-child(4), td:nth-child(6), td:nth-child(8), td:nth-child(10), td:nth-child(11), td:nth-child(12), td:nth-child(13) {
        display: grid;
        grid-template-columns: minmax(92px, 38%) 1fr;
        gap: 8px;
        border: 0;
        border-bottom: 1px solid #3d434b;
        padding: 7px 9px;
        text-align: left;
        white-space: normal;
      }
      td:last-child { border-bottom: 0; }
      td::before { color: var(--muted); font-weight: 400; }
      td:nth-child(1)::before { content: "#"; }
      td:nth-child(2)::before { content: "Lokalizacja"; }
      td:nth-child(3)::before { content: "Top 1 firma"; }
      td:nth-child(4)::before { content: "Top 1 EUR/d"; }
      td:nth-child(5)::before { content: "Top 2 firma"; }
      td:nth-child(6)::before { content: "Top 2 EUR/d"; }
      td:nth-child(7)::before { content: "Top 3 firma"; }
      td:nth-child(8)::before { content: "Top 3 EUR/d"; }
      td:nth-child(9)::before { content: "Top 4 firma"; }
      td:nth-child(10)::before { content: "Top 4 EUR/d"; }
      td:nth-child(11)::before { content: "MM EUR/d"; }
      td:nth-child(12)::before { content: "Pozycja MM"; }
      td:nth-child(13)::before { content: "Tańsze oferty"; }
    }
  </style>
</head>
<body>
  <h1>VipCars report</h1>
  <div class="meta">Generated at: ${escapeHtml(generatedAt)} | Time zone: Europe/Warsaw | Source: https://www.vipcars.com</div>
  <div class="summary">Scenariusze: ${summary.scenarioCount} | sprawdzenia lokalizacji: ${summary.locationCheckCount} | brak MM Cars Rental: ${summary.missingMmCount} | MM close: ${summary.closeMmCount} | MM top1 gap: ${summary.top1GapCount}</div>
  <div class="legend">
    <span><span class="badge">MM Cars Rental</span> MM Cars Rental in table</span>
    <span><span class="badge close">MM close</span> MM up to 2.5 EUR/day above the previous competitor</span>
    <span><span class="badge good">MM top1 gap</span> MM is cheapest and next competitor is over 2.5 EUR/day more expensive</span>
  </div>
  <div class="toolbar">
    <label>Skrzynia<select disabled><option selected>Tylko automaty</option></select></label>
    <label>Data<input id="filter-date" type="date"></label>
    ${locationFilter}
    ${durationFilter}
    ${stateFilter}
  </div>
  ${scenarios.map((scenario, index) => buildScenarioTable(scenario, index, scenarios.length)).join("\n") || "<p>No offers extracted.</p>"}
  <script>
    const dateControl = document.getElementById("filter-date");
    const multiControls = ["filter-location", "filter-duration", "filter-state"].map((id) => document.getElementById(id));

    function selectedValues(control) {
      return new Set(Array.from(control.querySelectorAll("input:checked")).map((input) => input.value));
    }

    function updateMultiSummary(control) {
      const checked = Array.from(control.querySelectorAll("input:checked"));
      const summaryElement = control.querySelector("summary");
      if (!checked.length) {
        summaryElement.textContent = control.dataset.allLabel;
      } else if (checked.length === 1) {
        summaryElement.textContent = checked[0].closest("label").querySelector("span").textContent;
      } else {
        summaryElement.textContent = checked.length + " wybrane";
      }
    }

    function applyFilters() {
      const date = dateControl.value;
      const selectedLocations = selectedValues(multiControls[0]);
      const selectedDurations = selectedValues(multiControls[1]);
      const selectedStates = selectedValues(multiControls[2]);
      multiControls.forEach(updateMultiSummary);

      for (const section of document.querySelectorAll(".scenario")) {
        const scenarioMatch = (!date || section.dataset.date === date)
          && (!selectedDurations.size || selectedDurations.has(section.dataset.duration));
        let visibleRows = 0;
        for (const row of section.querySelectorAll("tbody tr")) {
          const locationMatch = !selectedLocations.size || selectedLocations.has(row.dataset.location);
          const stateMatch = !selectedStates.size || selectedStates.has(row.dataset.mmState);
          const visible = scenarioMatch && locationMatch && stateMatch;
          row.hidden = !visible;
          if (visible) visibleRows += 1;
        }
        section.hidden = visibleRows === 0;
      }
    }

    dateControl.addEventListener("input", applyFilters);
    multiControls.forEach((control) => control.addEventListener("change", applyFilters));
    applyFilters();
  </script>
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

#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const { parseCsv } = require("./reportHtml");
const { createCoveragePlan } = require("./coverage");

function isMmCarsProvider(provider) {
  return String(provider || "").trim().toLowerCase().includes("mm cars rental");
}

function buildRunStatus(coverageRows, scrapeResult = "success") {
  const complete = coverageRows.filter((row) => row.status === "complete").length;
  const errors = coverageRows.filter((row) => row.status === "incomplete");
  const pending = coverageRows.length - complete - errors.length;
  const timeouts = errors.filter((row) => /timeout|timed\s+out/i.test(row.error || "")).length;
  if (!coverageRows.length) {
    return "czesciowy; brak danych kontroli";
  }
  const status = errors.length || pending ? "czesciowy"
    : scrapeResult === "success" ? "gotowy" : "wymaga sprawdzenia";
  return `${status}; kompletne kontrole: ${complete}/${coverageRows.length}; `
    + `bledy: ${errors.length} (timeout: ${timeouts}); niedokonczone: ${pending}; GitHub: ${scrapeResult}`;
}

function validateRateUpdateSummary(summary) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return "brak poprawnego podsumowania vipcars-rate-update-summary.json";
  }
  const counts = [summary.verified_duration_count, summary.blocked_band_count, summary.change_count];
  if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0)) {
    return "podsumowanie vipcars-rate-update-summary.json zawiera nieprawidlowe liczniki";
  }
  return "";
}

function importReadyFromFile(summaryPath) {
  try {
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    return !validateRateUpdateSummary(summary) && summary.verified_duration_count > 0;
  } catch {
    return false;
  }
}

function buildWorkbookSection({ baselineStatus, workbookStatus, reportExists, importExists, pageUrl,
  summary, summaryError } = {}) {
  if (!["confirmed_imported", "verified_live"].includes(baselineStatus)) {
    return "Pliki stawek XLSX: zablokowane. Brak potwierdzenia aktualnosci pliku bazowego w Wheels; import nie zostal wygenerowany.";
  }
  const summaryIssue = summaryError || validateRateUpdateSummary(summary);
  if (workbookStatus !== "success" || !reportExists || !importExists || !pageUrl) {
    return `Pliki stawek XLSX: nie powstaly kompletne pliki. Blad generowania lub walidacji; szczegoly w GitHub Actions. Import XLSX ukryty: ${summaryIssue || "pliki wyjsciowe sa niekompletne"}.`;
  }
  const base = `${String(pageUrl).replace(/\/+$/, "")}/`;
  const recommendation = `Rekomendacje XLSX:\n${base}vipcars-recommendations.xlsx`;
  if (summaryIssue) {
    return `${recommendation}\n\nImport XLSX ukryty: ${summaryIssue}.`;
  }

  const { verified_duration_count: verified, blocked_band_count: blocked, change_count: changes } = summary;
  const metrics = `Zweryfikowane okresy: ${verified}; zablokowane pasma cenowe: ${blocked}; zmiany cen: ${changes}.`;
  if (verified === 0) {
    return `${metrics}\n${recommendation}\n\nBrak zweryfikowanych pasm cenowych. Plik importu zawiera wyłącznie bazę i nie stanowi nowej rekomendacji; import nie jest udostępniany.`;
  }

  const status = blocked > 0 ? "czesciowy" : "zweryfikowany";
  const warning = blocked > 0 ? "\nOstrzeżenie: baza pozostała dla zablokowanych zakresów." : "";
  return `${status}; ${metrics}\n${recommendation}\n\nImport XLSX:\n${base}vipcars-rates-import-ready.xlsx${warning}`;
}

function readWorkbookState(manifestPath, workbookStatus, pageUrl, outputDir = "output") {
  let baselineStatus;
  try { baselineStatus = JSON.parse(fs.readFileSync(manifestPath, "utf8")).status; }
  catch { baselineStatus = undefined; }
  let summary;
  let summaryError = "";
  const summaryPath = path.join(outputDir, "vipcars-rate-update-summary.json");
  try {
    summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    summaryError = validateRateUpdateSummary(summary);
  } catch (error) {
    summaryError = error.code === "ENOENT"
      ? "brak pliku vipcars-rate-update-summary.json"
      : error instanceof SyntaxError
        ? "nieprawidlowy JSON w vipcars-rate-update-summary.json"
        : `nie mozna odczytac vipcars-rate-update-summary.json: ${error.message}`;
  }
  return { baselineStatus, workbookStatus, pageUrl, summary, summaryError,
    reportExists: fs.existsSync(path.join(outputDir, "vipcars-recommendations.xlsx")),
    importExists: fs.existsSync(path.join(outputDir, "vipcars-rates-import-ready.xlsx")) };
}

function buildWorkbookSectionFromFiles(manifestPath, workbookStatus, pageUrl, outputDir = "output") {
  return buildWorkbookSection(readWorkbookState(manifestPath, workbookStatus, pageUrl, outputDir));
}

function buildTelegramMessage({ coverageRows = [], rows = [], workbooks = {}, env = {} } = {}) {
  const list = (value) => [...new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean))];
  const locations = list(env.LOCATIONS), pickupDateOptions = list(env.PICKUP_DATES), durationDays = list(env.DURATIONS).map(Number);
  if (locations.length && pickupDateOptions.length && durationDays.length) {
    const key = (row) => [row.location, row.pickup_date, Number(row.duration_days)].join("|");
    const recordedChecks = new Map(coverageRows.map((row) => [key(row), row]));
    // Missing chunk artifacts remain pending checks in the prepared run's full plan.
    coverageRows = createCoveragePlan({ locations, pickupDateOptions, durationDays })
      .map((planned) => recordedChecks.get(key(planned)) || planned);
  }
  const dateLabel = (date) => date.split("-").reverse().join(".");
  const dates = [...new Set(coverageRows.map((row) => row.pickup_date).filter((date) =>
    /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))
      && new Date(date).toISOString().slice(0, 10) === date))].sort();
  let startDates = "brak danych";
  if (dates.length) {
    const contiguous = dates.every((date, index) => !index || Date.parse(date) - Date.parse(dates[index - 1]) === 86400000);
    const first = dates[0], last = dates[dates.length - 1];
    startDates = dates.length === 1 ? dateLabel(first) : contiguous
      ? `${first.slice(0, 7) === last.slice(0, 7) ? first.slice(8) : dateLabel(first)}–${dateLabel(last)}`
      : dates.map(dateLabel).join(", ");
  }
  const durations = [...new Set((coverageRows.length ? coverageRows.map((row) => row.duration_days)
    : String(env.DURATIONS || "").split(",")).map(Number).filter((days) => Number.isInteger(days) && days > 0))]
    .sort((a, b) => a - b);
  const contiguousDurations = durations.every((days, index) => !index || days === durations[index - 1] + 1);
  const durationLabel = !durations.length ? "brak danych" : durations.length > 1 && contiguousDurations
    ? `${durations[0]}–${durations[durations.length - 1]}` : durations.join(", ");
  const priceChecks = coverageRows.filter((row) => row.status === "complete"
    && Number.isSafeInteger(Number(row.result_count)) && Number(row.result_count) > 0).length;
  const percent = coverageRows.length ? new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 2 })
    .format(priceChecks === coverageRows.length ? 100 : Math.min(99.99, priceChecks / coverageRows.length * 100)) : null;
  const summaryIssue = workbooks.summaryError || validateRateUpdateSummary(workbooks.summary);
  const importReady = ["confirmed_imported", "verified_live"].includes(workbooks.baselineStatus)
    && workbooks.workbookStatus === "success" && workbooks.reportExists && workbooks.importExists
    && workbooks.pageUrl && !summaryIssue && workbooks.summary.verified_duration_count > 0;
  const partial = !coverageRows.length || coverageRows.some((row) => row.status !== "complete")
    || (env.SCRAPE_RESULT || "success") !== "success" || !importReady || workbooks.summary.blocked_band_count > 0;
  const lines = [partial ? "VipCars | NIEPEŁNY" : "VipCars", "",
    `Daty startu: ${startDates}`, `Czas trwania: ${durationLabel} dni`,
    percent == null ? "Dane cenowe: brak danych." : `Dane cenowe uzyskano dla ${priceChecks}/${coverageRows.length} sprawdzeń (${percent}%).`,
    "Tam, gdzie nie znaleziono lub nie potwierdzono ceny, nie zmieniano stawek."];
  const mmAlert = buildMissingMmStartDateAlert(rows, coverageRows);
  if (mmAlert) lines.push(mmAlert);
  if (partial) lines.push(`Status: ${buildRunStatus(coverageRows, env.SCRAPE_RESULT || "success")}`);
  lines.push("");
  if (!summaryIssue) {
    const summary = workbooks.summary, stats = summary.change_statistics;
    const validStats = stats && [stats.increase_count, stats.decrease_count].every((count) => Number.isSafeInteger(count) && count >= 0)
      && stats.increase_count + stats.decrease_count === summary.change_count;
    lines.push(validStats ? `Zmiany w Excelu: podwyżki ${stats.increase_count}, obniżki ${stats.decrease_count}.`
      : `Zmiany w Excelu: ${summary.change_count} zmian stawek (brak podziału na podwyżki i obniżki).`);
    if (validStats) {
      for (const [count, average, label] of [[stats.increase_count, stats.average_increase_net_eur_day, "podwyżka"],
        [stats.decrease_count, stats.average_decrease_net_eur_day, "obniżka"]]) {
        if (count > 0 && typeof average === "number" && Number.isFinite(average) && average > 0) {
          lines.push(`Średnia ${label} względem bazy: ${new Intl.NumberFormat("pl-PL", {
            minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(average)} EUR netto/dobę.`);
        }
      }
    }
    if (summary.blocked_band_count > 0) lines.push(`Zablokowane pasma cenowe: ${summary.blocked_band_count}. Baza pozostała dla zablokowanych zakresów.`);
  }
  lines.push("");
  const base = `${String(workbooks.pageUrl || "").replace(/\/+$/, "")}/`;
  if (importReady) {
    lines.push(`Import: ${base}vipcars-rates-import-ready.xlsx`, `Rekomendacje: ${base}vipcars-recommendations.xlsx`);
  } else {
    lines.push(buildWorkbookSection(workbooks));
  }
  if (workbooks.pageUrl) lines.push(`Raport cen: ${base}report.html`);
  if (partial) {
    if (env.ARTIFACT_URL) lines.push(`Kopia wyników: ${env.ARTIFACT_URL}`);
    if (env.RUN_URL) lines.push(`GitHub Actions: ${env.RUN_URL}`);
  }
  return lines.join("\n");
}

function buildTelegramMessageFromFiles(env = process.env) {
  const outputDir = env.OUTPUT_DIR || "output";
  const readCsv = (filename) => fs.existsSync(path.join(outputDir, filename))
    ? parseCsv(fs.readFileSync(path.join(outputDir, filename), "utf8")) : [];
  return buildTelegramMessage({ env, coverageRows: readCsv("vipcars-coverage.csv"), rows: readCsv("vipcars-results.csv"),
    workbooks: readWorkbookState("input/vipcars-baseline-manifest.json", env.RATE_WORKBOOK_STATUS, env.PAGE_URL, outputDir) });
}

function classifyStartDatesWithoutMm(rows, coverageRows) {
  const mmPickupDates = new Set(
    rows
      .filter((row) => isMmCarsProvider(row.provider))
      .map((row) => row.pickup_date)
      .filter(Boolean)
  );
  const coverageByDate = new Map();
  for (const row of coverageRows) {
    if (!row.pickup_date) {
      continue;
    }
    if (!coverageByDate.has(row.pickup_date)) {
      coverageByDate.set(row.pickup_date, []);
    }
    coverageByDate.get(row.pickup_date).push(row);
  }
  if (!coverageByDate.size) {
    for (const row of rows) {
      if (row.pickup_date && !coverageByDate.has(row.pickup_date)) {
        coverageByDate.set(row.pickup_date, []);
      }
    }
  }

  const confirmed = [];
  const incomplete = [];
  for (const [pickupDate, checks] of [...coverageByDate.entries()].sort()) {
    if (mmPickupDates.has(pickupDate)) {
      continue;
    }
    if (checks.length && checks.every((check) => check.status === "complete")) {
      confirmed.push(pickupDate);
    } else {
      incomplete.push(pickupDate);
    }
  }
  return { confirmed, incomplete };
}

function buildMissingMmStartDateAlert(rows, coverageRows) {
  const { confirmed, incomplete } = classifyStartDatesWithoutMm(rows, coverageRows);
  if (!confirmed.length && !incomplete.length) {
    return "";
  }

  const sections = ["ALERT MM CARS RENTAL"];
  if (confirmed.length) {
    sections.push(["Brak MM - pełne dane:", ...confirmed.map((pickupDate) => `- ${pickupDate}`)].join("\n"));
  }
  if (incomplete.length) {
    sections.push(["Nie można potwierdzić - niepełne dane:", ...incomplete.map((pickupDate) => `- ${pickupDate}`)].join("\n"));
  }
  return `${sections[0]}\n${sections.slice(1).join("\n\n")}`;
}

function buildAlertFromFiles(csvPath, coveragePath) {
  const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
  const coverageRows = fs.existsSync(coveragePath) ? parseCsv(fs.readFileSync(coveragePath, "utf8")) : [];
  return buildMissingMmStartDateAlert(rows, coverageRows);
}

if (require.main === module) {
  if (process.argv[2] === "--message") {
    process.stdout.write(`${buildTelegramMessageFromFiles()}\n`);
  } else if (process.argv[2] === "--import-ready") {
    process.exitCode = importReadyFromFile(process.argv[3]) ? 0 : 1;
  } else if (process.argv[2] === "--workbooks") {
    process.stdout.write(`${buildWorkbookSectionFromFiles(process.argv[3], process.argv[4], process.argv[5], process.argv[6])}\n`);
  } else if (process.argv[2] === "--status") {
    const coveragePath = process.argv[3];
    const coverage = fs.existsSync(coveragePath) ? parseCsv(fs.readFileSync(coveragePath, "utf8")) : [];
    process.stdout.write(`${buildRunStatus(coverage, process.argv[4])}\n`);
  } else {
    const csvPath = process.argv[2] || "output/vipcars-results.csv";
    const coveragePath = process.argv[3] || "output/vipcars-coverage.csv";
    const alert = buildAlertFromFiles(csvPath, coveragePath);
    if (alert) {
      process.stdout.write(`${alert}\n`);
    }
  }
}

module.exports = {
  buildTelegramMessage,
  buildTelegramMessageFromFiles,
  buildRunStatus,
  buildWorkbookSection,
  buildWorkbookSectionFromFiles,
  importReadyFromFile,
  buildAlertFromFiles,
  buildMissingMmStartDateAlert,
  classifyStartDatesWithoutMm
};

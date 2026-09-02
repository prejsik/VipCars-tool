# VipCars Tool

VipCars scraper, HTML report publisher, pricing recommendations, and global rate import generator.

## Local run

```powershell
npm install
npm run vipcars
npm run vipcars:report
npm run vipcars:recommendations
python -m pip install -r requirements.txt
npm run vipcars:rates
```

The recommendations command derives the required coverage matrix from `vipcars.config.example.json` and refuses to generate output when locations, durations, or the pickup-date count do not match the scrape plan.

## GitHub Pages

The workflow `.github/workflows/vipcars-daily.yml` publishes:

```text
https://prejsik.github.io/VipCars-tool/report.html
https://prejsik.github.io/VipCars-tool/vipcars-recommendations.xlsx
https://prejsik.github.io/VipCars-tool/vipcars-rates-import-ready.xlsx
```

`vipcars-recommendations.xlsx` is the control workbook with changed positions, recommendation details, and validation. `vipcars-rates-import-ready.xlsx` keeps the original 13-column `RateGroup Export` layout and contains only the clean import sheet.

The import is global because the VipCars source export has no location column. A duration band is changed only when all scheduled locations and all durations in that band have complete data. The most conservative allowed multiplier is applied proportionally to automatic-transmission rate groups; manual-transmission groups remain unchanged. Automatic updates of the open-ended `8+ per day` column are disabled because the scraper schedule covers only 8-14 days.

For every MM Cars Rental offer, the scraper also reads the current `Pay Now` amount from the same result card. Recommendations subtract that amount from both the current site price and the target site price, then calculate the import adjustment from the resulting net daily rates. A recommendation is blocked when `Pay Now` is missing, invalid, uses a different currency, implies a broker multiplier outside `1.00-1.25`, or produces an import multiplier outside `0.70-1.60`. The observed amount and markup are shown in `Recommendations Review`; the clean 13-column import layout is unchanged.

## Scheduled scenarios

The daily schedule checks 60 rolling pickup dates from the run date and rental durations from 2 to 14 days.

## Telegram notification

The workflow sends a Telegram message after the GitHub Pages report is deployed, when these repository secrets are set:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_IDS
```

`TELEGRAM_CHAT_IDS` can contain one chat ID or several IDs separated with commas, for example `123456789,987654321`.
The older single-recipient `TELEGRAM_CHAT_ID` secret is still supported as a fallback.
The message also lists every attempted pickup date where MM Cars Rental is not visible in any scraped location or rental duration.
It includes direct links to the HTML report, recommendations workbook, and clean import workbook.

## Baseline safety

The user-provided import template is stored as `input/vipcars-rate-group-export.xlsx`. Its approved SHA-256 is stored in `input/vipcars-baseline-manifest.json`; generation fails before writing outputs when the file does not match the manifest.
The generator also fails when a planned date, duration band, or automatic group is absent from that baseline. After importing a generated workbook or changing rates outside this tool, replace the baseline and its manifest before using a later recommendation; the repository cannot detect an external import by itself.

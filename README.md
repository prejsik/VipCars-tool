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

`vipcars-recommendations.xlsx` is the control workbook with changed positions, recommendation details, and validation. `vipcars-rates-import-ready.xlsx` keeps the current 12-column `RateGroup Export` layout from `RateGroup Export (8).xlsx`, with duration bands `1`, `2-6`, `7-8`, and `9+`, and contains only the clean import sheet. Headers are checked against the configured duration bands before any rate is changed.

The import is one global workbook divided by the `Rate zone` column. Rates are calculated independently for each configured zone, and a duration band is changed only when all durations in that band have complete data for that zone. Workbook generation requires a scrape covering every configured location, so a partial manual run cannot produce an import that overwrites untested zones. The most conservative allowed multiplier is applied proportionally to automatic-transmission rate groups; manual-transmission groups remain unchanged. Automatic updates of the open-ended `9+ per day` column are disabled because the scraper schedule covers only up to 14 days. The 1-day column is unchanged when no 1-day scenarios were checked.

For every MM Cars Rental offer, the scraper also reads the current `Pay Now` amount from the same result card. Site prices and comparison thresholds are gross EUR. Import rates are net EUR, with VAT set to 23% in `pricing.vat_rate_percent`. Recommendations retain the existing broker calibration: subtract the observed `Pay Now` amount from both current and target site prices, then divide the remaining daily amounts by `1.23`. For example, `123 EUR/day` after the broker deduction is `100 EUR/day` net. The target/current net ratio is applied to the already-net baseline; the baseline is NOT divided by VAT again. VAT cancels in that ratio, so adding correct tax reporting alone does not create a 23% price change. Holding the observed broker amount constant for the proposed target is a calibration assumption, not a guarantee of the broker's future charge. A recommendation is blocked when `Pay Now` is missing, invalid, uses a different currency, implies a broker multiplier outside `1.00-1.25`, or produces an import multiplier outside `0.70-1.60`. Gross targets, net targets, VAT, and the observed markup are shown in `Recommendations Review`.

Recommendations and import rows are separated by the VipCars rate zones configured in `vipcars-rate-update.config.json`: `BYD`, `GDA`, `KAT`, `KRA`, `POZ`, `WAR`, and `WRO`. The generated import remains one `RateGroup Export` worksheet with 12 columns; the `Rate zone` column identifies the city-specific row. `Recommendations Review` shows the scraper location, zone code, zone name, and metroplex for every decision.

## Scheduled scenarios

The daily schedule starts at **19:17 Europe/Warsaw the previous evening** to prepare the next morning's report before 07:00. GitHub handles summer/winter time through the workflow's `timezone` setting; there is one scheduled run per day.

On September 11-15, 2026, GitHub delivered the old 02:30 trigger about 4 hours 19 minutes to 4 hours 44 minutes late, and the full run then took about 4 hours 8 minutes to 5 hours 7 minutes. Telegram itself took about one second. The earlier start allows for these observed delays, a 30-minute margin, and the hour lost on the spring DST transition. GitHub schedules are best-effort, so this is a delivery target, not a guaranteed deadline. Telegram is sent as soon as the report is published, which may be during the night.

The daily scan still checks all seven locations, 60 rolling pickup dates and rental durations from 2 to 14 days, in EUR with automatic transmission. Since pickup is at 10:00, an evening run starts its pickup plan on the following day; a run delayed past midnight keeps that same first date until 10:00. The plan is fixed in the prepare job and shared by all 60 chunks. An evening start means prices may be collected the previous evening or during the night.

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
The current source is `RateGroup Export (8).xlsx`. Source row 12326 (`FVMD`, 16/09/2026-31/08/2027) had no rate zone. It was removed with the user's approval because the missing branch could not be inferred unambiguously; all other source rates remain unchanged. The manifest records the source hash and this exclusion.
The generator also fails when a planned date, duration band, or automatic group is absent from that baseline. After importing a generated workbook or changing rates outside this tool, replace the baseline and its manifest before using a later recommendation; the repository cannot detect an external import by itself.

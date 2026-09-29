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

The HTML includes every planned date/duration/location from coverage, even when no offers were collected. Incomplete checks and verified empty searches are distinguished; an unsuccessful check is not reported as confirmed absence of MM Cars. A partial report cannot reconstruct prices that were never fetched. XLSX links are available only when baseline validation and workbook generation succeed.

`vipcars-recommendations.xlsx` is the control workbook with changed positions, recommendation details, and validation. `vipcars-rates-import-ready.xlsx` keeps the current 12-column `RateGroup Export` layout from `RateGroup Export (3).xlsx`, with duration bands `1`, `2-6`, `7-8`, and `9+`, and contains only the clean import sheet. Headers are checked against the configured duration bands before any rate is changed. Both output workbooks show all rate rows on opening: source filter criteria, sorting and hidden-row flags are cleared, and the filter dropdowns cover the full expanded grid. This does not alter any rate or the source workbook.

The import is one global workbook divided by the `Rate zone` column. For each zone, pickup date and enabled duration band, all twelve approved groups receive the SAME absolute net EUR/day price, not a percentage change from their old prices. The groups are `CDMR`, `CFAR`, `CFAR1`, `CFAR2`, `CFMR`, `CWAR`, `CWAR1`, `CWAR2`, `CWAR3`, `CWMR`, `EDAR`, and `EDMR`, with no premiums. All other groups are untouched. This explicitly includes some manual-transmission import groups, but the market benchmark is always the automatic-offer result set; this is not a separate competitor ranking for each vehicle class.

The permanent policy aims at top1, otherwise top2, otherwise top3, at 0.50 EUR gross/day below the relevant competitor. It can raise or lower rates. The old 2.50 EUR gap trigger and 0.70-1.60 adjustment limits do not apply. There are no holiday, city/airport, or extra seasonal pricing rules. Columns `1` and `9+` remain unchanged; only `2-6` and `7-8` are updated. An optional van/premium or any-transmission scrape can still produce an HTML report, but cannot generate this global pricing import.

Every duration in a band must have complete, valid data for that zone, and the number of saved offers must match its coverage record. For each duration the engine finds the best attainable rank, respecting the minimum after import rounding. The shared price is the lowest of those per-duration caps, so it meets all their rank constraints. The exporter independently checks every predicted gross price and minimum at the final shared rate. If any duration lacks a valid target, including when its floor blocks top3, the entire band retains its baseline prices. Workbook generation also requires all configured locations. Blocked bands are explicitly shown in the review and validation sheets.

For every MM Cars Rental offer the scraper reads `Pay Now` from the same card. With gross total `T` and Pay Now `P`, the observed broker multiplier is `m = T / (T - P)`. The net import cap for a gross daily site target `S` is `S / m / 1.23`. The predicted site price is `net import * 1.23 * m`. This assumes the observed percentage markup persists at the proposed price, not that Pay Now remains a fixed amount; it is an estimate rather than a guarantee of a future live rank. MM's current rate and valid Pay Now are mandatory. Missing/invalid amounts, mixed currencies, incomplete data, and broker multipliers outside `1.00-1.25` block the affected band. No historical or default broker markup is substituted.

Only the minimum is time-limited: for pickup dates through **2026-10-25 inclusive**, MM must retain at least **30 PLN gross/day after the broker deduction for 2-6 days**, and **40 PLN gross/day for 7-8 days**. Their net EUR floors are respectively `30 / EURPLN / 1.23` and `40 / EURPLN / 1.23`. On 2026-10-26 these floors expire, but the shared-price and rank policy continue. Rates must always remain positive. Caps round DOWN and floors round UP to the import's three decimal places. Even a baseline with extra decimal places is set to the exact shared rate to avoid breaking group parity.

The CLI fetches the latest published average EUR rate from the [NBP Table A API](https://api.nbp.pl/). A failed or invalid response uses the user-approved fallback **1 EUR = 4.30 PLN**. Each payload and review records the rate, source, publication date when available, and fallback reason. Old percentage-model recommendation JSON is rejected; regenerate it with the current code. The report distinguishes individual targets from the final shared band price, predicted site prices and verified ranks. Existing HTML gap colors remain observations of the scraped prices, not pricing instructions.

Recommendations and import rows are separated by the VipCars rate zones configured in `vipcars-rate-update.config.json`: `BYD`, `GDA`, `KAT`, `KRA`, `POZ`, `WAR`, and `WRO`. The generated import remains one `RateGroup Export` worksheet with 12 columns; the `Rate zone` column identifies the city-specific row. `Recommendations Review` shows the scraper location, zone code, zone name, and metroplex for every decision.

## Scheduled scenarios

The daily schedule starts at **19:17 Europe/Warsaw the previous evening** to prepare the next morning's report before 07:00. GitHub handles summer/winter time through the workflow's `timezone` setting; there is one scheduled run per day.

On September 11-15, 2026, GitHub delivered the old 02:30 trigger about 4 hours 19 minutes to 4 hours 44 minutes late, and the full run then took about 4 hours 8 minutes to 5 hours 7 minutes. Telegram itself took about one second. The earlier start allows for these observed delays, a 30-minute margin, and the hour lost on the spring DST transition. GitHub schedules are best-effort, so this is a delivery target, not a guaranteed deadline. Telegram is sent as soon as the report is published, which may be during the night.

The daily scan still checks all seven locations, 60 rolling pickup dates and rental durations from 2 to 14 days, in EUR with automatic transmission. Since pickup is at 10:00, an evening run starts its pickup plan on the following day; a run delayed past midnight keeps that same first date until 10:00. The plan is fixed in the prepare job and shared by all 60 chunks. An evening start means prices may be collected the previous evening or during the night.

## Scraper reliability

Each CLI process (one workflow chunk) owns one Chromium browser and opens an isolated context for every search attempt. The first pass attempts every planned check once. At most two subsequent recovery passes retry eligible failures, with a shared limit of three attempts per location/date/duration check. Successful checks are not repeated.

Navigation and initial result detection retain the configured `timeoutMs` (45 seconds by default). The entire attempt, including paginated results, has a shared 180-second budget (`--attempt-budget-ms`), capped by the remaining job budget. Result GET requests are serialized with three seconds between starts across attempts and scenarios in the same CLI process. This is conservative pacing, not a documented VipCars rate limit or a guarantee of live availability. The larger attempt budget allows for this pacing; it does not extend the 170-minute job budget (`--job-budget-ms`) or the workflow's 180-minute limit. Large daily runs may still remain incomplete. Failure-artifact capture and context cleanup have separate short limits. Unfinished checks remain explicitly incomplete, never valid empty results. Checkpoints are saved after each location.

Results require a verified complete result state; an unchanged card count alone is not evidence of completeness. Failure artifacts have separate attempt numbers and include stage timings, selected network events and JavaScript errors. Diagnostic JSON excludes URL query parameters, request bodies, headers and cookies. HTML and screenshots remain workflow debugging artifacts and are not sanitized; treat downloaded artifacts accordingly. The publish job installs Node dependencies independently of the scrape jobs.

Both browser and experimental network paths observe failed result requests. Chromium extra response information exposes HTTP status and Retry-After even when CORS hides the normal response. A valid Retry-After on any error response (including the observed HTTP 400) pauses subsequent scenarios and retries in that process. The CLI persists an increased cooldown immediately in the resume checkpoint, before the attempt returns. No new attempt is consumed while waiting, and a cooldown longer than the remaining job budget leaves checks incomplete without more requests. Cooldowns and request pacing are not shared between separate GitHub jobs or independent processes. Without Retry-After, network failures, HTTP 429 and 5xx remain eligible for the existing bounded retries; other 4xx failures are not retried. Intentional request cancellation and unrelated resource failures are ignored. This respects a server-requested pause but does not guarantee complete live results. The DOM-pruning experiment was removed after live validation still failed at 300 of 471 offers.

The scraper verifies the effective page form against the requested airport IDs, dates, times and currency. MM Cars' cheapest matching offer is retained even when it falls outside the competitor limit.

The workflow enables `--network-results` for automatic-transmission searches after the bounded live validation below. Standalone CLI use remains opt-in; workflow searches with `transmission=any` retain the UI path. In automatic mode it applies the UI transmission filter first, then captures the filtered first response. The request must match the search contract, request only automatic transmission, and contain no supplier or category exclusions. Its offer fields and total count must match the first rendered page. If the UI filter is unavailable, the path collects the full unfiltered search and filters transmission locally. Subsequent pages are downloaded sequentially using browser-native fetch in that session, retaining three-second request pacing. Direct HTTP-client pagination returned HTTP 400 in live tests and is not used. Response HTML is parsed without executing its scripts or appending cards to the live page. Every page must retain the same total, advance its cursor, and provide distinct offer IDs; incomplete, inconsistent, or mixed-transmission filtered pages fail the check. All matching pages are collected before choosing each provider's cheapest offer and applying the configured category. First-page parity is checked; this is not an independent visual verification of every later offer. Offline integration tests are not evidence of live-site support or speed.

The filtered request must also use the full minimum/maximum price range declared by the page's slider, including when the UI reports no results. Missing, ambiguous, or narrowed bounds fail the check. Controlled pagination waits for both the fetch result and its matching Chromium request lifecycle, so delayed server cooldown metadata takes precedence over a generic fetch failure. A canceled controlled request fails promptly instead of waiting for the whole search budget; unrelated intentional cancellations remain ignored.

An earlier filtered-response prototype reached 300 of 445 offers before an HTTP 400 with Retry-After: 3600. After that cooldown expired, a default-UI test with three-second pacing still exceeded its 180-second search deadline; the last observed count was 310 of 445 offers. No HTTP 400 or server cooldown was recorded during that attempt, but intervals between the final successful responses grew to 12-14 seconds. These UI failures motivated the filtered-response path.

On 2026-09-28, one authorized local search using the new filtered-response path completed **465/465** automatic offers in **156.066 seconds**, while the live DOM retained ten cards. Scope: Warsaw Chopin, 2026-10-02 to 2026-10-04, 10:00, EUR. MM Cars was retained among the 25 provider results, including its Pay Now amount. No publication or Telegram was performed. This validates that one search, not all seven locations, every duration, or the throughput of the full 5,460-check daily run.

To continue an interrupted local run, repeat its exact CLI arguments with `--resume`. The canonical checkpoint is `<output-coverage>.resume.json`. Resume requires the same planned dates, durations, locations, currency, times and filters, the same Warsaw calendar day, and a checkpoint at most six hours old. It preserves the original job deadline and the three-attempt limit, and skips completed checks. A fresh run without `--resume` starts a new checkpoint. GitHub chunk artifacts include the checkpoint for manual recovery; workflow reruns do not automatically restore it or merge data from previous runs.

Install the test browser with `npx playwright install chromium`, then run `npm run test:all` for the offline regression suite, including local Chromium result-page fixtures. These tests do not send Telegram messages or query live rental offers. They verify retry, deadline and completeness behavior, not a guaranteed live-site response time.

## Telegram notification

The workflow sends a Telegram message after the GitHub Pages report is deployed, when these repository secrets are set:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_IDS
```

`TELEGRAM_CHAT_IDS` can contain one chat ID or several IDs separated with commas, for example `123456789,987654321`.
The older single-recipient `TELEGRAM_CHAT_ID` secret is still supported as a fallback.
The message also lists every attempted pickup date where MM Cars Rental is not visible in any scraped location or rental duration.
It includes a direct HTML link and links to XLSX files only when generation succeeds against a confirmed baseline. Otherwise it distinguishes missing baseline confirmation from a generation/validation failure. Both attempt timeouts and initial-search "timed out" errors are counted. The merged backup contains output files only; raw chunk diagnostics remain in their separate chunk artifacts, avoiding a second multi-gigabyte upload before notification.

## Baseline safety

The user-provided import template is stored as `input/vipcars-rate-group-export.xlsx`. Its approved SHA-256 is stored in `input/vipcars-baseline-manifest.json`; generation fails before writing outputs when the file does not match the manifest. The manifest must also have status `confirmed_imported` or `verified_live`, a timezone-aware `confirmed_at` timestamp and a nonempty `confirmed_by`. A matching hash alone does not establish that these are the current rates in Wheels. An unconfirmed `user_provided` baseline remains blocked; do not invent confirmation metadata to bypass this gate.
The current source is `RateGroup Export (3).xlsx`, supplied by the user on 2026-09-28 as the correct replacement baseline after the currentness question. Its `verified_live` status records that user confirmation, not a direct inspection of Wheels. Source row 13425 (`FVMD`, 16/09/2026-31/08/2027) still had no rate zone. The same previously approved exclusion was applied because the branch cannot be inferred; all other source rates, cell styles and row visibility remain unchanged. The working baseline contains 15,880 rows, or 16,842 after expanding pickup ranges. The manifest records the original hash and this exclusion. Earlier replacement attachments `(5)` and `(2)` are not used.
The generator also fails when a planned date, duration band, or approved group is absent from that baseline. After importing a generated workbook or changing rates outside this tool, replace the baseline and its manifest before using a later recommendation; the repository cannot detect an external import by itself.

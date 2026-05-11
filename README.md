# VipCars Tool

VipCars scraper and HTML report publisher.

## Local run

```powershell
npm install
npm run vipcars
npm run vipcars:report
```

## GitHub Pages

The workflow `.github/workflows/vipcars-daily.yml` publishes:

```text
https://prejsik.github.io/VipCars-tool/report.html
```

## Telegram notification

The workflow sends a Telegram message after the GitHub Pages report is deployed, when these repository secrets are set:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_IDS
```

`TELEGRAM_CHAT_IDS` can contain one chat ID or several IDs separated with commas, for example `123456789,987654321`.
The older single-recipient `TELEGRAM_CHAT_ID` secret is still supported as a fallback.

const assert = require("node:assert/strict");
const { buildHtmlReport } = require("../src/vipcars/reportHtml");

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

const offers = [
  {
    location: "Warsaw", duration_days: "2", pickup_date: "2026-09-28", dropoff_date: "2026-09-30",
    provider: "Competitor A", provider_rating: "8.5", price_per_day: "20", currency: "EUR"
  },
  {
    location: "Warsaw", duration_days: "2", pickup_date: "2026-09-28", dropoff_date: "2026-09-30",
    provider: "MM Cars Rental", provider_rating: "9", price_per_day: "21", currency: "EUR"
  }
];

const coverage = [
  { location: "Warsaw", duration_days: "2", pickup_date: "2026-09-28", dropoff_date: "2026-09-30",
    status: "complete", result_count: "2", error: "" },
  { location: "Krakow", duration_days: "2", pickup_date: "2026-09-28", dropoff_date: "2026-09-30",
    status: "incomplete", result_count: "0",
    error: '<script>bad()</script> https://example.test/result?token=private password=hunter2' },
  { location: "Warsaw", duration_days: "3", pickup_date: "2026-09-29", dropoff_date: "2026-10-02",
    status: "complete", result_count: "0", error: "" },
  { location: "Krakow", duration_days: "3", pickup_date: "2026-09-29", dropoff_date: "2026-10-02",
    status: "pending", result_count: "0", error: "" }
];

const html = buildHtmlReport(offers, "2026-09-28T05:00:00.000Z", coverage);

assert.equal(countMatches(html, /<section class="scenario"/g), 2,
  "every planned date/duration scenario must be rendered");
assert.equal(countMatches(html, /<tr data-location=/g), 4,
  "every planned location check must be rendered even without offers");
assert.match(html, /data-date="2026-09-28"/);
assert.match(html, /data-date="2026-09-29"/);
assert.match(html, /value="Krakow"><span>Krakow<\/span>/);
assert.match(html, /value="Warsaw"><span>Warsaw<\/span>/);
assert.match(html, /data-check-status="incomplete"/);
assert.match(html, /data-check-status="pending"/);
assert.match(html, /data-check-status="no-offers"/);
assert.match(html, /Niepełne/);
assert.match(html, /Oczekuje/);
assert.match(html, /Brak ofert/);
assert.equal(countMatches(html, /<td class="coverage-state-cell" colspan="11">/g), 3,
  "zero-offer coverage checks must use one compact status cell");
assert.equal(countMatches(html, /data-mm-state="missing"/g), 1,
  "Brak MM must only include verified complete absence");
assert.equal(countMatches(html, /data-mm-state="incomplete"/g), 1);
assert.equal(countMatches(html, /data-mm-state="pending"/g), 1);
assert.match(html, /20\.00 EUR\/day/);
assert.match(html, /21\.00 EUR\/day/);
assert.doesNotMatch(html, />0\.00 EUR\/day</,
  "coverage rows must not invent rates for missing offer rows");
assert.doesNotMatch(html, /hunter2|token=private|<script>bad/);
assert.match(html, /password=&lt;redacted&gt;/);
assert.match(html, /https:\/\/example\.test\/result/);

const legacy = buildHtmlReport([{
  location: "Poznan", duration_days: "2", pickup_date: "2026-09-28", dropoff_date: "2026-09-30",
  provider: "Competitor B", price_per_day: "30", currency: "EUR"
}], "2026-09-28T05:00:00.000Z");
assert.equal(countMatches(legacy, /<tr data-location=/g), 1);
assert.match(legacy, /data-mm-state="missing"/);
assert.doesNotMatch(legacy, /data-check-status=/,
  "reports without coverage must retain legacy offer-only rendering");

const missingCount = buildHtmlReport([], "2026-09-28T05:00:00.000Z", [{
  location: "Warsaw", duration_days: "2", pickup_date: "2026-09-28", dropoff_date: "2026-09-30",
  status: "complete", result_count: "", error: ""
}]);
assert.match(missingCount, /data-check-status="incomplete"/);
assert.doesNotMatch(missingCount, /data-mm-state="missing"/,
  "a missing result count must not prove that MM is absent");
assert.match(missingCount, /Raport częściowy: 1 z 1 kontroli nie ma kompletnych danych/);
assert.match(missingCount, /kontrole planowane: 1 \| z ofertami: 0 \| bez ofert: 0 \| niepełne: 1/);

const mismatchedCount = buildHtmlReport([{
  location: "Warsaw", duration_days: "2", pickup_date: "2026-09-28", dropoff_date: "2026-09-30",
  provider: "Competitor C", price_per_day: "18", currency: "EUR"
}], "2026-09-28T05:00:00.000Z", [{
  location: "Warsaw", duration_days: "2", pickup_date: "2026-09-28", dropoff_date: "2026-09-30",
  status: "complete", result_count: "2", error: ""
}]);
assert.match(mismatchedCount, /data-check-status="incomplete"/);
assert.match(mismatchedCount, /Raport częściowy: 1 z 1 kontroli nie ma kompletnych danych/);

const orphanOffer = buildHtmlReport([{
  location: "Krakow", duration_days: "2", pickup_date: "2026-09-28", dropoff_date: "2026-09-30",
  provider: "Competitor D", price_per_day: "19", currency: "EUR"
}], "2026-09-28T05:00:00.000Z", [{
  location: "Warsaw", duration_days: "2", pickup_date: "2026-09-28", dropoff_date: "2026-09-30",
  status: "complete", result_count: "0", error: ""
}]);
assert.match(orphanOffer, /data-location="Krakow" data-mm-state="incomplete" data-check-status="incomplete"/);
assert.match(orphanOffer, /Brak wpisu pokrycia/);
assert.equal(countMatches(orphanOffer, /data-mm-state="missing"/g), 1,
  "only the planned verified no-offer check may be marked Brak MM");
assert.match(orphanOffer, /kontrole planowane: 1 \| z ofertami: 0 \| bez ofert: 1 \| niepełne: 0/);
assert.doesNotMatch(orphanOffer, /Raport częściowy:/,
  "offer-only orphans must not change the planned coverage denominator");

const coverageWithoutDropoff = buildHtmlReport([{
  location: "Warsaw", duration_days: "2", pickup_date: "2026-09-28", dropoff_date: "2026-09-30",
  provider: "Competitor E", price_per_day: "17", currency: "EUR"
}], "2026-09-28T05:00:00.000Z", [{
  location: "Warsaw", duration_days: "2", pickup_date: "2026-09-28",
  status: "complete", result_count: "1", error: ""
}]);
assert.match(coverageWithoutDropoff, /kontrole planowane: 1 \| z ofertami: 1 \| bez ofert: 0 \| niepełne: 0/);
assert.doesNotMatch(coverageWithoutDropoff, /Brak wpisu pokrycia|Raport częściowy:/);

console.log("PASS HTML report renders complete coverage without inventing rates");

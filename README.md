# gridtrace-dr-lab

A synthetic demand-response attribution workbench. It answers one question for a
fictional dispatch: **given the response-day load, what part of the drop can
honestly be called activity, and how sure are we?**

Everything runs locally on generated data. It is not connected to a utility,
meter head-end, or settlement system, and it makes no settlement claim. There is
no dispatch, device control, or write-back of any kind.

## Quick start

```bash
npm install
npm run gen:demo      # writes data/demo-v1/*.csv and pins dataset versions 1 and 2
npm run build         # compile TypeScript to dist/
npm start             # http://127.0.0.1:8080
```

For development, `npm run dev` runs `tsx watch src/server.ts` without a build
step. The server serves the API and the single-page workbench (`web/`) from the
same origin, so no bundler or dev proxy is involved.

Useful environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address (set `0.0.0.0` in a container) |
| `DR_STORE` | `data/store` | Directory holding version snapshots, reports, tasks |
| `DR_BASE_PATH` | *(empty)* | URL prefix when mounted behind a reverse proxy, e.g. `/dr` |

Under `DR_BASE_PATH` the shell is served (and deep links fall back to it) with an
injected `<base href="/dr/">`, and the client prefixes every API call and the
CSV download with the same mount point. At the origin root no `<base>` is
injected, so relative assets and in-page anchors behave normally.

`npm run gen:demo` writes `data/store/dataset-v1.json`, `dataset-v2.json`, and
`versions.json`. These are immutable version snapshots: the server never edits
them, a corrections file always lands as a *new* version with a recorded diff,
and re-running the generator rewrites identical bytes because the data is
seeded. Runtime artifacts (`data/store/reports/`, `data/store/tasks/`) are
gitignored and can be deleted at any time — the server rebuilds its in-memory
index from the store on boot.

If you start the server against a store with no pinned version, `GET /api/health`
returns `{ ok: false, hint: "… Run `npm run gen:demo` …" }` and the data
endpoints answer `503` with the same hint instead of a stack trace. The app shell
still loads and shows the message.

```bash
npm test              # 55 tests: time, ingest, alignment, baseline, report, compare, store, server
npm run typecheck     # tsc --noEmit (also covers test/)
```

## What the pipeline does

1. **Ingest** — strict CSV parsing with quarantine. Missing reads are *never*
   filled with zero. Duplicate/conflicting meter reads, negative or implausible
   values, malformed or non-UTC timestamps, and wrong meter/site pairings are
   rejected with a per-row code (`read_duplicate`, `read_bad_timestamp`,
   `read_unknown_meter`, `read_negative`, `read_absurd`, `csv_malformed`, …) and
   surfaced in the Data Health panel. Files are versioned by SHA-256; a
   corrections file produces a new immutable dataset version with a recorded
   diff, never an in-place edit.
2. **Interval alignment** — builds a local-day grid per site with DST-aware
   length (92 / 96 / 100 intervals). The active meter is selected from the
   registry by installed/removed UTC times. An overlap is a `meter_exchange`
   conflict and is excluded, never averaged; a gap is `no_active_meter`; a
   stale read with no active meter is `invalid`. Temperature is joined by
   nearest hourly observation and every interval records whether it was
   `observed` or `nearest`.
3. **Baseline** — three rules are evaluated for every event, all on the same
   pre-filtered pool:
   - `matched_10of10_weather` — up to 10 matched days of the same day type
     (weekday vs weekend), mean temperature within tolerance, per-slot mean,
     with an additive within-sample temperature slope when the sample supports
     one.
   - `matched_4of5_weather` — the four closest-in-temperature of the five most
     recent eligible days of the event's day type, same correction.
   - `weather_regression` — per-15-minute-slot OLS over eligible history.
   Training is restricted to the **same ISO-style day type** as the event.
   Pooling Saturdays/Sundays into a weekday model makes the weekday/weekend
   schedule effect look like a temperature effect (weekends are both cooler and
   much lighter in this data), which flips the slope sign and produces negative
   savings. The report states whether the pool was day-type restricted and how
   many days fed the slope.
4. **Leakage guard** — the training cutoff is the event's local day start and is
   also capped at `issuedAtUtc`. Post-response reads can never inform the
   baseline that is being scored against them, for any rule including the
   regression fits and the bootstrap refits.
5. **Rules, coverage and attribution** — each rule reports its own sample
   (days, per-slot n, R², temperature range, checks) and its own coverage of the
   window. Attribution is **per interval**: an interval with a missing actual
   read, a meter conflict, no active meter, an excluded estimated read, a
   verified production anomaly, or an unverified anomaly the analyst chose to
   exclude is not credited as savings. The report shows the raw observed drop
   next to attributed savings and the non-DR remainder, plus an exclusion
   breakdown by reason and by interval.
   Production anomalies are evaluated **per record**, not per merged status, so
   a verified maintenance entry on the same interval cannot mask a separate
   unverified outage — both reasons are recorded.
6. **Uncertainty** — a day-level bootstrap (600 replicates, fixed seed, 90%
   percentile interval) resamples the *training days* and refits each slot's
   line per replicate for the regression rule, so the quoted interval reflects
   sampling variability of the chosen rule rather than measurement noise in the
   response window alone.
7. **Compare** — two reports are compared through a full basis fingerprint
   (`datasetVersionId`, `eventRevisionId`, `exclusionsHash`, `businessHash`,
   `windowHash`, `suiteHash`). Mismatches are enumerated with severity instead
   of being silently subtracted. Critical mismatches (different site/event)
   make the pair `incomparable`; a moved window or revised dataset downgrades
   it to `revision`; exclusion or rule changes to `method`; identical basis is
   `exact`. A common-window delta is computed on the intersection of the two
   windows, so a revision that shifted the dispatch can still be compared on the
   hours both revisions cover.

The browser UI exposes all of this: analysis setup with site/event/revision and
a training-validation mode, editable exclusion conditions (production statuses,
unverified anomalies, holidays, other event days, estimated reads, meter
exchanges, DST days, coverage thresholds, lookback, weather correction on/off,
rule policy and rule override), a window profile chart with per-interval
drill-down and keyboard navigation, a rule comparison table with the
difference-versus-selected column and sample detail, an attribution/exclusion
table, report-vs-report comparison, a data-health panel with the quarantine
list and version diff, and a task list where a finished, failed, or interrupted
run can be restored with its exact pinned inputs (optionally overridden).

Tasks are queued server-side, persisted to JSON with atomic writes, and
progress-checkpointed. On boot, any task left `running` or `queued` by a dead
process is marked `interrupted` with its last checkpoint preserved, and can be
restored as a *new* task rather than resumed in place.

## Deliberate edge cases in the demo data

| Case | Where | What it tests |
| --- | --- | --- |
| Planned maintenance, verified | SITE-RIV 2026-08-05 → 08-09 | Excluded from training; not counted as savings |
| Unplanned shutdown, verified | SITE-ARD 2026-08-20, SITE-GLN 2026-08-25 | Response window sits inside an outage; `insufficient_attribution`, no savings claim |
| Unverified anomaly | SITE-RIV 2026-08-20 | Excluded only if the analyst opts in; flagged otherwise |
| Verified pre-window reduction | SITE-RIV 2026-08-27 06:00–12:00 | Verified production anomaly that does not cover the dispatch window |
| 45-min telemetry gap | SITE-RIV 2026-08-27 17:00 | Missing in v1 (excluded, not zero-filled); v2 backfills it as `estimated` |
| Estimated reads | SITE-ARD 2026-08-14, SITE-MTN 2026-09-08 | Excluded when "treat estimated as missing" is on |
| Meter exchange + overlap | SITE-RIV 2026-08-11 (09:20–10:05) | Overlap flagged as conflict; exchange day excluded by default |
| No active meter | SITE-GLN 2026-09-03 08:00–08:30 | 30-minute gap between meters, flagged |
| Fall-back DST window | EV-2026-11-01-DST | Local 01:00–02:00 spans two real hours; window is 8 intervals |
| Spring-forward clock | America/Chicago 2026-03-08 | 92-interval day; nonexistent wall time resolves forward |
| UTC vs local basis | EV-2026-08-21-UTC | Window labels differ from the local clock, UTC instants match |
| Revision shift | EV-2026-09-16-RESCHED rev 1 → 2 | Compare shows the interval impact of the +2 h shift |
| Cancellation | EV-2026-09-02-CANCELLED rev 2 | `no_window` report; no savings, expected interval count still shown |
| Weather outage | WX-NYC 08-23 → 08-25 | Nearest-observation join is marked, or the sample excludes the day |
| Quarantined defects | bad timestamp, wrong meter, negative, absurd, out-of-period, duplicate conflict | Each row rejected with a code in Data Health |
| Late backfill v2 | `data/demo-v1/corrections_v2.csv` | New immutability-versioned dataset; compare v1 vs v2 |

The generator is seeded (`seed: 20260816`), so `npm run gen:demo` is
byte-for-byte reproducible, including `versions.json`. Running it twice and
diffing the output is a cheap sanity check that no result depends on wall-clock
time or iteration order.

## Expected results on the demo data (dataset v2)

These are what a fresh `gen:demo` + `npm start` produces; they are a smoke test,
not a target. Every figure carries a 90% bootstrap interval in the UI.

| Site | Event | Rule chosen | Savings | Coverage | Status |
| --- | --- | --- | --- | --- | --- |
| SITE-RIV | EV-2026-08-27 | `matched_4of5_weather` | +201.0 kWh (13.5%) | 75% (one 45-min gap) | Reportable estimate |
| SITE-RIV | EV-2026-08-18 | `matched_4of5_weather` | +186.3 kWh (9.4%) | 100% | Reportable estimate |
| SITE-MTN | EV-2026-08-21-UTC | `weather_regression` | +91.6 kWh (10.5%) | 100% | Reportable estimate |
| SITE-ARD | EV-2026-09-16-RESCHED rev 2 | `weather_regression` | +180.5 kWh (13.4%) | 100% | Reportable estimate |
| SITE-ARD | EV-2026-11-01-DST | `matched_10of10_weather` | +43.9 kWh | 50% (second repeated hour has no reads) | Partial — below coverage threshold |
| SITE-ARD | EV-2026-08-20 | — | — | 0% | `insufficient_attribution` (verified shutdown covers the window) |
| SITE-GLN | EV-2026-08-25 | — | — | 0% | `insufficient_attribution` (verified feeder outage) |
| SITE-RIV | EV-2026-09-02-CANCELLED rev 2 | — | — | — | `no_window`, 12 scheduled intervals reported for context only |

The cancelled and outage cases still produce a full report — window, expected
intervals, interval-level attribution — they simply refuse to state a savings
number. That is the point: a missing or invalid measurement is reported as
missing, never as a zero that happens to look like savings.

## API

All responses are JSON unless noted; errors use `{ "error": "…" }` with a
meaningful status (400 for bad input, 404 for unknown ids, 405 for bad methods).

- `GET  /api/health` — `{ ok, latestDatasetVersionId, hint }` (`ok: false` when no
  dataset version is pinned; data endpoints then return `503`)
- `GET  /api/state` — versions, sites, events+revisions, exclusion defaults,
  method labels, recent tasks and reports, version diff, data-quality summary,
  disclaimer
- `GET  /api/events` — event catalogue with revisions
- `GET  /api/data-quality` — ingest counts, quarantine rows, version diff
- `POST /api/tasks` — run a report. Body: `datasetVersionId`, `siteId`,
  `eventId`, optional `eventRevisionId`, optional `exclusions` overrides,
  optional `autoPolicy`, optional `methodOverride`, optional `label`, or
  `scope: "training_validation"` + `validationDate`. Returns `202` with the
  queued task.
- `GET  /api/tasks` — task list, newest first
- `GET  /api/tasks/:id` — task with progress, log, and linked report summaries
- `POST /api/tasks/:id/restore` — clone a task with its exact pinned config;
  accepts the same overrides as `POST /api/tasks`, plus `exclusions`
- `POST /api/tasks/:id/cancel` — cancel a queued/running task
- `GET  /api/reports` — report summaries
- `GET  /api/reports/:id` — full report (basis, per-rule results, intervals)
- `GET  /api/reports/:id.csv` — interval-level CSV export (`text/csv`)
- `POST /api/compare` — `{ a, b }` report ids, optional `labelA`/`labelB`;
  returns comparability, mismatches, deltas, and common-window figures

Example run:

```bash
curl -s localhost:8080/api/tasks -H 'content-type: application/json' \
  -d '{"siteId":"SITE-RIV","eventId":"EV-2026-08-27"}' | jq '.task.id'
curl -s localhost:8080/api/reports | jq '.reports[0] | {id, status, savingsKwh}'
```

## Limitations and honest caveats

- Synthetic weather and load. No real weather service, tariff, meter head-end,
  or settlement.
- Weather correction is a single additive temperature slope per slot, not a
  full degree-day or humidity model.
- Matched days are treated as exchangeable in the bootstrap; the UI says so.
- Per-slot regression with one regressor is a cross-check, not a
  state-of-the-art forecast.
- All savings figures are estimates with stated uncertainty. They are not a
  settlement quantity, and nothing in this app can dispatch or curtail load.

# Owner Dashboard handoff

The new `/owner` page is restricted to the Auth0 `owner` role (`https://dendefenders.com/mcp/roles`). As a fallback, an administrator can set `OWNER_DASHBOARD_EMAILS` to a comma-separated list of verified Auth0 email addresses. Other signed-in users receive a 404 and cannot call the reporting API.

The reconciled `owner-dashboard-report.json` from Claude's Sep 28 export is bundled server-side in `data/`, so the charts load as soon as this version is deployed. It contains aggregate financial figures, not customer names or addresses. Earlier rows are reconstructed, the Sep 28 weekly base job list is reconciled to the saved workbook, and future rows are forecasts. The audit workbook stays outside the website code.

Set `OWNER_DATABASE_URL` in the Den Coach Denny deployment to a private Neon Postgres connection string to allow future owner-only imports. The app creates `owner_dashboard_reports` on first access. Each successful import is retained as a new version, superseding the bundled baseline. Do not use a public Blob store for financial data. The current ZIP has no live ServiceTitan credentials or scheduled snapshot collector. Deploying the code does not start daily updates.

The saved snapshot's job list resolved the full $83,401.17 all-open discrepancy. The new audit workbook compares 586 job rows for Sep 14, 21 and 28: each ID, bucket and value matches, including Hold. Sep 28 all-open is $1,024,752.01 on 154 jobs. The dashboard's three-month scheduled portion is $1,015,541.93 on 152 jobs, with $9,210.08 in a job with no future appointment and a $0 job outside the window. The three-month split is based on appointment dates retrieved that afternoon and the unpaid balance is reconstructed from payment history; only the base job list is directly reconciled. Five ambiguous payment dates have null cash fields; older canceled jobs remain unchecked. The notes in the JSON and audit workbook explain the estimation and early-2024 limitations.

The 27-row Sold Estimates PDF was cross-checked. Five entries have real RTI jobs, two only match unrelated older jobs, and 20 entries totaling $143,946.56 have no RTI job. They are excluded from pipeline. The audit workbook's `Estimate cross-check` sheet contains the operational follow-up list and three amount discrepancies.

## Ask Claude for the export

Paste this to Claude with its ServiceTitan and follow-up list access:

> Create `owner-dashboard-report.json` for Den Coach Denny. Use **Security Products only**, Return-to-Install job type **2054262**, unique RTI job IDs. Exclude chimney, fireplaces, gas, RMA, remake, warranty, non-sale visits, canceled and completed jobs. Hold jobs are separate and excluded from the scheduled headline. Cross-check the Sold Estimates/follow-up addresses against actual RTI jobs: retain only addresses with a real matching RTI job and document ambiguous matches; do not turn an estimate into an extra job. Use invoice/job IDs, appointment status and history, paid amounts, refunds, and source timestamps. Never invent an unknown amount.
>
> Produce `weekly` Monday 12:00 AM America/Los_Angeles snapshots from 2024 through the current Monday. Each scheduled pipeline is jobs open at that cutoff with qualifying install appointments from the cutoff to the same calendar day three months later (define whether the end is exclusive and use it consistently). Revenue pipeline is full current sold invoice value; cashflow pipeline is its unpaid balance at that historical cutoff. Weekly `sales`, `deposits`, `installPayments`, `refunds` and `netCash` summarize the preceding Monday–Sunday Pacific week. Separate Hold, unscheduled, and beyond-window totals. Do not substitute the known Sep 14/21/28 **all-open** figures for this rolling-three-month measure.
>
> Produce `daily` end-of-day Pacific snapshots for 2024, 2025 and 2026. The scheduled pipeline runs from the next midnight through December 31 of the row's calendar year, inclusive. `sales` is newly sold Security RTI value that day. `deposits` is actual deposit cash received that day for future security installs. `installPayments` is actual balance cash received that day on security installs; use payment timestamp rather than appointment date. `refunds` is positive dollars refunded that day. `netCash = deposits + installPayments - refunds`. Match payments to eligible Security RTI jobs, dedupe IDs, and reconcile daily/weekly totals. Exclude cash for chimney, fireplace and gas jobs. If a payment's deposit/balance role is ambiguous, document it and mark the affected field null rather than guessing.
>
> Where past Hold releases, reopenings, invoice edits, and historical unpaid balances cannot be verified, use `null` for affected fields and `quality: "reconstructed"`; do not present those rows as verified. Use `quality: "verified"` only where actual snapshots and source events support the values. Future projections through **March 31, 2027** must use `quality: "forecast"`, with a brief method and uncertainty in `notes`. Forecast rows must not be presented as received cash. The 2024 early-deposit gap must be documented. Output a separate job-level audit file with job ID, invoice ID, appointments, status, payment IDs/timestamps, exclusion reason, and source references. Do not put customer names or addresses in the dashboard JSON.
>
> The dashboard JSON must have exactly the shape below. All fields are required; an unknown number is `null`, not 0. Dates are `YYYY-MM-DD` Pacific business dates, money is dollar numbers to cents, not formatted strings. Weekly dates must be Mondays; all dates must be unique within their array. Include every verifiable point rather than interpolating gaps. Save a real `.json` file and a separate audit workbook; give me both files, not a prose summary.

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-28T23:00:00Z",
  "source": "ServiceTitan Security RTI verified export, snapshot cutoff America/Los_Angeles",
  "notes": ["Specify source windows, forecast method and history gaps here."],
  "weekly": [{
    "date": "2026-09-28", "quality": "reconstructed",
    "revenuePipeline": null, "cashflowPipeline": null,
    "holdRevenue": null, "holdCashflow": null,
    "unscheduledRevenue": null, "beyondWindowRevenue": null, "jobCount": null,
    "sales": null, "deposits": null, "installPayments": null,
    "refunds": null, "netCash": null
  }],
  "daily": [{
    "date": "2026-09-28", "quality": "reconstructed",
    "revenuePipeline": null, "cashflowPipeline": null,
    "holdRevenue": null, "holdCashflow": null,
    "unscheduledRevenue": null, "beyondWindowRevenue": null, "jobCount": null,
    "sales": null, "deposits": null, "installPayments": null,
    "refunds": null, "netCash": null
  }]
}
```

The example's null fields are placeholders, not reported zeroes. For future forecasts use the same row fields and `quality: "forecast"`. The import checks date uniqueness, Monday weekly dates, reasonable numeric values, cashflow no greater than revenue, and the net-cash arithmetic when all components are known. The audit workbook remains separate from the chart data.

After Claude returns the actual JSON, sign in as an owner, open `/owner`, and upload the file at the bottom of the page. The API is `POST /api/owner/report`, with the authenticated owner session. The latest import is shown by `GET /api/owner/report`.

## Daily automation still to connect

Build a server-side collector with ServiceTitan credentials and an authorized job that captures end-of-day snapshots and Monday cutoff snapshots into this report store. Schedule in Pacific time with DST-aware local date calculations and record actual capture timestamps. A scheduler may run late, so an invocation time is not itself proof of an exact Monday midnight snapshot. Store job-level evidence before rolling up and flag missed cutoffs. The existing code ZIP provides read-only MCP queries but no snapshot collector or automatic import feed for this dashboard.

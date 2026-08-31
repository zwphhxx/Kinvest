# Administrator report-period diagnostic

Design date: 2026-08-31. Status: awaiting review of this written contract.
Baseline: `origin/main` at `3ab9d6fe0c63d28624eaaa2e700d6ac97e8b1ca7`.
Branch: `feat/ifind-report-period-diagnostic`.

## Goal and authority

Add an administrator-only, fixed Alibaba diagnostic that observes revenue and
report start/end dates in one bounded business request. Development, offline
tests and a feature PR are authorized. Production installation, image transfer,
deployment, vendor authentication and every real business attempt are separate
approval gates and are not authorized by this design.

Do not change the original working tree, deploy scripts, credentials, database
schema, household Mock data or the three full-market manifests. No new Secret,
Environment Variable, network endpoint or provider dependency is needed.

## Evidence already obtained without business queries

The official SuperCommand metadata editor was inspected on 2026-08-31:

<https://quantapi.51ifind.com/gwstatic/static/ds_web/super-command-web/index.html#/BasicData>

| Indicator | Meaning | Parameters observed in the editor |
| --- | --- | --- |
| `revenue_oas` | Revenue (OAS) | `8,1,BB`; `1` means consolidated statements and `BB` original currency |
| `report_sd` | Report start date | `8,1`; `1` means single-quarter report, `2` cumulative report |
| `report_ed` | Report end date | `8,1`; `1` means single-quarter report, `2` cumulative report |
| `regular_report_latest_rp` | Latest report period | As-of-date parameter; not selected for this historical diagnostic |

Selecting year 2026 and first quarter in the revenue editor produces
`20260331,1,BB`. Its selector syntax is official; replacing it with `8` would
change the requested period rather than fix a demonstrated syntax error.
The date-indicator help also maps quarter choices to `0331`, `0630`, `0930`
and `1231`. Those labels do not prove Alibaba's actual fiscal/calendar mapping.

The metadata does not establish that generic `report_sd`/`report_ed` with
single-quarter parameters describes the precise OAS revenue observation.
Ordinary revenue and single-quarter revenue are separate catalog entries.
This feature must not invent the latter's indicator ID or treat them as equal.

## Approach selection

1. Recommended: a separate fixed three-indicator diagnostic. This preserves the
   existing calibration request and result contracts, avoids mixing observations
   from different attempts and retains one authentication plus one business call.
2. Extending the old calibration in place changes its explicitly approved
   single-indicator behavior and existing strict DTO. Do not choose this route.
3. Independent live requests for each field consume more requests and can mix
   observation times. They are unnecessary for this bounded first diagnostic.

## Fixed request

New diagnostic ID: `HK_ALIBABA_REPORT_PERIOD_20260331_SINGLE_QUARTER_V1`.
Shared ledger case: `HK_ALIBABA_9988`. Fixed vendor code: `9988.HK`.

Use the existing `basic_data_service` transport with the following frozen body:

```json
{
  "codes": "9988.HK",
  "indipara": [
    {"indicator": "revenue_oas", "indiparams": ["20260331", "1", "BB"]},
    {"indicator": "report_sd", "indiparams": ["20260331", "1"]},
    {"indicator": "report_ed", "indiparams": ["20260331", "1"]}
  ]
}
```

This is a server-owned request template derived from inspected metadata, not
evidence that the account is entitled to the date fields or that their joint
response shape has passed a real query. The implementation supports offline
fixtures first; a future independently approved attempt tests vendor behavior.
No browser parameter, arbitrary code, indicator, URL or date reaches transport.

## Separation of observations and verified financial evidence

Leave `/api/admin/ifind/calibration` and its result untouched. In particular,
do not change its `periodEvidence.actualPeriod=null` rule or existing seven
`unverified` statuses.

The new result has fixed identity/request metadata, runtime status, an optional
observation, request counts, `dataVol`, attempted timestamp and a stable error
code. All seven verification dimensions remain `unverified`.

An observation contains:

```json
{
  "returnedCode": "9988.HK",
  "revenue": {"value": null, "availability": "missing"},
  "dateEvidence": {
    "requestedDataType": "single-quarter",
    "start": null,
    "end": null,
    "availability": "missing",
    "revenuePeriodLink": "unverified"
  }
}
```

Revenue and valid dates replace their corresponding nulls only from the same
accepted response. This is not a Mock fixture fallback. Missing fields remain
missing; they never become zero, a request-selector date, or an issuer-document
date. Currency, scale, issuer identity, authorization and OAS period linkage are
not promoted by a returned security code, numerical match or plausible dates.

The browser labels dates as report-date indicator observations, not the verified
revenue period. `requestedDataType` describes the request only. Do not infer
quarter/year type from elapsed days or shared end dates, or render a green
verification success badge. A valid differing date range can be displayed as
unverified evidence; it is not by itself proof that revenue is wrong.

Parser requirements:

- Accept exactly one table row for the fixed vendor code. Reject multiple rows,
  duplicate/unknown indicators, arrays longer than one and structural ambiguity.
- Normalize revenue using the existing strict finite decimal convention, without
  unit inference. Reject non-finite values, grouping separators and unit suffixes.
- Initially accept only exact real calendar dates `YYYY-MM-DD` and explicit
  null for date scalars. Do not guess timestamps, serial dates or other formats.
  Unsupported formats fail with a stable error, without exposing raw strings.
- Missing date columns or explicit null produce partial/missing date evidence;
  a structurally malformed supplied column fails the attempt.
- Reject impossible dates and a non-null start later than end. Do not attach any
  observation after parsing failure or quota-settlement failure.
- Strict result copying rejects extra keys, accessors, proxies and fabricated
  verified claims. Rebuild JSON output from allowed primitives only.

## Runtime, quotas and HTTP boundary

Add a dedicated domain module and service rather than making the public adapter
an arbitrary-query interface. The service uses the existing tmpfs provider,
bounded HTTPS transport and SQLite market-diagnostic reservation/settlement.

- Reserve the shared Alibaba attempt before accessing secrets or the transport.
- Preserve the shared pending lease, per-case cooldown and case/global daily
  attempt caps. Do not create a second quota pool.
- Count attempted calls before awaiting them: at most one authentication and
  one business call. No retries, refresh-on-error or automatic probes.
- Keep `dataVol` unknown unless a valid nonnegative vendor integer is supplied;
  three requested fields do not imply three quota units.
- Clear defensive token buffers and respect client ownership during cleanup.
  Busy paths must not clear another running diagnostic's client.
- Settle the ledger as unverified evidence, with no financial point or quote
  snapshot. Results stay in runtime memory and may disappear after restart.
- Late results after lease expiry, local clear or failed settlement cannot
  become published observations.

New routes:

| Route | Behavior |
| --- | --- |
| `GET /api/admin/ifind/report-period-diagnostic` | Authenticated local status only; no secret read or vendor request |
| `POST /api/admin/ifind/report-period-diagnostic/run` | Exact empty JSON object, administrator mutation session, same Origin, CSRF and trusted proxy identity |

Match paths exactly and preserve duplicate-header/body limits. Household device
Cookies are not administrator authorization. Disabled/unavailable diagnostic
runtime returns a stable unavailable result without reading credentials.

## Administrator interface

Add a compact separate section beside existing calibration, keeping the current
design language. Display all three fixed indicators and distinguish the two
meanings of parameter `1`. The explicit confirmation states one authentication
and one three-indicator business request, existing quota consumption and no
family-data activation.

The run button alone initiates the POST. Page load, refresh, polling and error
handling never invoke it. Canceling confirmation makes zero requests. Disable
the button during an attempt and retain server-side concurrency enforcement.

Render only strict validated DTOs using text nodes. Empty state says no attempt
has run, not zero revenue. Session expiry or invalid DTO clears observations.
Revenue-period linkage remains visibly unverified even when both dates exist.

## Implementation boundaries

Expected new runtime files:

- `server/domain/ifind-report-period-diagnostic.js`: immutable request and strict DTO/parser contract.
- `server/services/ifind-report-period-diagnostic-service.js`: shared-ledger bounded execution and memory-only result.
- `public/admin-report-period-contract.js`: browser DTO validation for the new section.

Integration points:

- `server/adapters/ifind-http-client.js`: one fixed transport method; no arbitrary query inputs.
- `server/ifind-diagnostic-runtime.js`: service wiring and cleanup.
- `server/http/ifind-market-diagnostic-http.js`: reuse administrator boundary for the two fixed routes.
- `public/admin.html`, `public/admin.js`: separate diagnostic UI and deliberate confirmation.
- `scripts/build.js`: include each new runtime/browser file in the production allowlist.
- `server/tests/run-tests.js`: register focused suites.
- `server/tests/build.test.js`: runtime artifact and fresh-process loading coverage.
- `docs/operations/ifind-report-period-diagnostic.md`: request, evidence boundary and separate approval gates.

Leave the old calibration domain, service and disclosure-evidence fixture intact
unless a narrowly documented integration requirement demands otherwise. No
unrelated refactor or dependency change belongs in this feature.

## Offline acceptance

Use fake transport and disposable SQLite only. No production secrets, provider
authentication or live response scraping in tests.

1. Exact three-indicator body; original single-indicator request remains exact.
2. One authentication plus one business call; failures counted, never retried.
3. Busy/cooldown/daily-cap rejection before secret access and shared competition
   against the existing calibration/full-market services.
4. Matching, differing, missing, partial and malformed date fields; impossible
   dates, reversed ranges, wrong code, multiple rows and malicious DTO objects.
5. Matching dates/numbers cannot change any verification dimension, fill old
   calibration metadata, populate household data or assert a revenue period.
6. Authentication/CSRF/Origin/trusted-client/body/path failures make zero vendor
   calls; administrator and household authorization remain distinct.
7. Quota-settlement failure, expired lease, late clear and client cleanup cannot
   publish observations or leak temporary token material.
8. Browser empty/loading/cancel/observed/missing/error/session-expired states;
   no automatic run and text-only rendering of all dynamic output.
9. Build allowlist, fresh-process module loading and offline container checks
   include the new server and browser files.
10. Full `npm run check` and PR `verify`, `security`, `container-build` must pass
    before handoff for the user's manual merge. Desktop/mobile local UI testing
    uses only fixtures and must not contact iFinD.

## Next gates

Review this written contract before implementation. Then write the detailed
implementation plan and execute the approved development/offline tests in this
worktree. Agent review is auxiliary, not human merge or deployment approval.

After a green feature PR, the user merges. Image download/import, production
deployment and the first live three-indicator attempt each need their own
explicit approval. No live test may be inferred from this development approval.

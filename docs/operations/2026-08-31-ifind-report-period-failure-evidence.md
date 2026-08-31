# Report-period diagnostic failure evidence

## Baseline and confirmed defect

PR #64 is deployed at commit `c21d9f952ff68cfd057755c0627e35bd293cf4e1`.
The single approved diagnostic at `2026-08-31T12:16:48.465Z` failed after
two requests (authentication plus one business request). Its ledger recorded
`dataVol=3`, `NETWORK`, and `IFIND_REPORT_PERIOD_DIAGNOSTIC_FAILED`.

The service previously assigned NETWORK before awaiting the business adapter,
then discarded the adapter's allowlisted failure code, class and vendor code.
That is a confirmed observability defect. The record does not establish a
network outage, successful indicator values, or a specific date-format mismatch.
Raw provider responses were not retained and cannot be reconstructed from it.

## Approved offline fix

- Preserve existing client failure rules and expected auth/financial stage.
- Keep the public result's generic errorCode unchanged.
- Add nullable, strictly copied `failureEvidence` to the administrator-only DTO.
- Persist the safe underlying code and vendor error code in existing ledger
  columns. Map IFIND_RESPONSE_SHAPE to ledger RESPONSE_SHAPE; map client CONFIG
  to ledger API because CONFIG is not an existing ledger class.
- Classify unknown business exceptions as API, not a claimed network failure.
- Keep structural evidence in runtime memory only. No SQLite schema migration.
- No response validation is relaxed; no date-format conversion is introduced.
- No verified financial records or household real-data access are introduced.

## Failure DTO

`failureEvidence` is null for initial, idle, successful-unverified, cleared and
unclassified results. Non-null evidence requires failed status and a request
count matching its stage: auth=1, financial=2 (one business request).

Its exact keys are `stage`, `failureCode`, `errorClass`, `vendorErrorCode`,
and `responseShape`. Codes/classes/vendor-code eligibility follow the existing
client allowlist. Messages, stack traces, request headers, tokens and arbitrary
error properties are never copied.

`responseShape` is null when no trustworthy parsed structure is available,
including rejected raw JSON. Otherwise it has seven fixed enum-only fields:

| Field | Meaning |
| --- | --- |
| tablesShape | Missing, invalid, empty, single or multiple rows |
| rowShape | Unavailable, invalid, expected field names or extra fields |
| identityShape | Missing, invalid, expected code match or mismatch |
| columnShape | Unavailable, invalid, known-only or extra columns |
| revenueShape | Array cardinality and single-item lexical/type shape |
| reportStartShape | Array cardinality and single-item lexical/type shape |
| reportEndShape | Array cardinality and single-item lexical/type shape |

No unknown field names, raw values or actual dates appear in this summary.
An iso-date/compact-date label describes lexical shape only, not calendar
validity, an established report period, or the cause of rejection.
Malformed or accessor-backed summaries are dropped without discarding a valid
allowlisted failure code. Strict DTO copies reject malformed supplied evidence.

## Regression scope and next gate

Focused offline coverage includes transport -> service -> SQLite propagation,
response-shape rejection, vendor permission/quota/API/auth failures, duplicate
JSON, zeroization, no retries, unchanged quotas and unverified-only results,
defensive copies, proxies/accessors, and runtime build-manifest inclusion.
Administrator rendering uses only fixed labels and text nodes.

Production remains unchanged by this PR. DEPLOY_V5_ENABLED remains false.
After PR checks and the user's manual merge, image preparation and deployment
each require their existing approvals. A subsequent real iFinD diagnostic
requires a separate explicit approval; this PR does not authorize one.

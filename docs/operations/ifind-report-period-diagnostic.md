# Fixed administrator report-period diagnostic

## Scope

This feature adds a separate administrator panel and leaves the original
single-indicator calibration unchanged. It is not a household data source.
Code/fixture approval never authorizes a vendor request or production release.

Fixed ID: `HK_ALIBABA_REPORT_PERIOD_20260331_SINGLE_QUARTER_V1`.
Fixed security: `9988.HK`, existing ledger case `HK_ALIBABA_9988`.

| Indicator | Parameters | Meaning of the second parameter |
| --- | --- | --- |
| `revenue_oas` | `20260331,1,BB` | Consolidated statements |
| `report_sd` | `20260331,1` | Single-quarter report |
| `report_ed` | `20260331,1` | Single-quarter report |

The official metadata editor's fixed 2026/Q1 revenue choice produces
`20260331`. Its default MRQ choice produces `8`, a different request. Neither
the selector nor a numerical disclosure match identifies the returned revenue's
actual period. Date indicators are independent evidence: a returned start/end
does not establish their linkage to the OAS revenue field.

Source inspected without business queries on 2026-08-31:
[official SuperCommand editor](https://quantapi.51ifind.com/gwstatic/static/ds_web/super-command-web/index.html#/BasicData).

## HTTP and query limits

- `GET /api/admin/ifind/report-period-diagnostic`: authenticated local status only.
- `POST /api/admin/ifind/report-period-diagnostic/run`: administrator mutation
  session, CSRF, same Origin, trusted proxy identity and exactly `{}`.
- The server owns code, endpoint, selector and all three indicator parameters.
- One deliberately confirmed attempt makes at most one authentication and one
  `basic_data_service` request containing all three indicators. No retries.
- Reserve the existing market ledger before secrets or requests. Keep its shared
  lease, Alibaba cooldown, five Alibaba attempts and twelve market attempts per
  Shanghai day. Failed attempts also count. These are local limits, not the
  vendor's official account balance or billing quota.
- Three requested fields do not imply `dataVol=3`; absent vendor usage is unknown.

## Result interpretation

The panel can display a finite revenue observation, report-date indicator
observations, availability, counts and a stable status. All seven verification
dimensions and `revenuePeriodLink` stay unverified. No verified success badge,
financial point, quote snapshot or household data is produced.

Dates must be exact valid `YYYY-MM-DD` strings. Missing/null dates stay missing;
other date formats are rejected rather than guessed. Reversed ranges, ambiguous
rows, wrong codes or malformed supplied fields fail closed. A valid but
different date range is evidence to investigate, not proof of an income error.

Revenue is not assigned a currency or scale. Missing values are not zero and are
not replaced by Mock, selectors, dates from disclosures or earlier attempts.
Only evidence from the same accepted response is shown together. Quota
settlement failure or stale completion discards observations.

Normalized observations are held in process/browser memory, not persisted as
financial data. Refreshing status never calls iFinD. Logout clears the panel;
server restart can discard the current observation. Raw vendor payloads, tokens,
messages and request IDs are not rendered, logged or persisted by this feature.

## Offline acceptance and release gates

Focused tests cover strict server/browser DTOs, malformed/missing dates, fixed
transport, shared quotas, administrator boundaries, cleanup and late results.
Browser fixtures cover GET-only initialization, cancellation, duplicate clicks,
CSRF transport, invalid DTOs and session invalidation. Runtime build allowlists
include the new server and browser modules.

Test outcomes and CI status must be reported from actual execution, not assumed
from this runbook. The user manually merges after `verify`, `security` and
`container-build` succeed. Offline image preparation/import, production release
and the first real three-indicator attempt remain separate approval gates.
Do not run any real query as part of PR validation.

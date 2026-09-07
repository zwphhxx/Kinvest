# T11 fixed HK probe response and recovery correction

## Scope and baseline

- Baseline: PR #71, commit `633885f5abf1fd9c8510bd1ce8bfbed23fa681db`.
- Authorized work: offline compatibility, safe diagnostics, cooldown recovery,
  regression tests and a feature-branch PR.
- No production configuration, deployment, database migration or real iFinD
  request is authorized by this code change.
- The family dashboard remains Mock and all seven evidence dimensions remain
  `unverified`. The fixed HK proposal, indicators and parameters are unchanged.

## What the original symptom establishes

The reported generic failure and counters (two requests, one business request)
show that the identity stage was entered after authentication. Counters are
incremented before awaiting transport; they do not establish that a successful
identity response was received. The discarded error detail cannot be recovered
from these counters. This patch fixes reproducible local defects without claiming
to have proven the original production failure's exact vendor cause.

## Response boundary

- The fixed-probe adapter accepts and discards documented envelope metadata:
  `errmsg`, `perf`, `datatype` and `inputParams`.
- Metadata has bounded depth, collection length, node count and string size.
  Dangerous keys, accessors, proxies and unknown envelope fields remain rejected.
- Projected success payloads still contain only `errorcode`, `tables` and optional
  `dataVol`; requested code, fields, row shape and scalar bounds remain strict.
- Nonzero vendor errors with absent or null tables are classified before success
  table validation. Non-null tables still undergo strict validation.
- Public failed-result codes have a fixed allowlist: `IFIND_AUTH_REJECTED`,
  `IFIND_PERMISSION_REJECTED`, `IFIND_QUOTA_REJECTED`, `IFIND_RESPONSE_SHAPE`,
  `IFIND_TIMEOUT`, `IFIND_NETWORK_FAILED`, or the existing generic fallback.
  Arbitrary error messages, response bodies and vendor request identifiers are
  not exposed or stored.
- Compatibility does not establish that the identity indicator is authorized or
  valid for HK equities. That remains a separately approved live-evidence gate.

## Outcome versus eligibility

The strict result DTO adds required `availability`:

```text
ready | busy | cooldown | daily-limit | unavailable
```

`status` describes the most recent result. `availability` describes whether a new
manual attempt is currently permitted. Local status reads recompute eligibility
from the shared repository while preserving the last terminal result, counters,
observations, failure code and failure stage.

A blocked POST returns an idle `busy`, `cooldown` or `daily-limit` result with
zero new request counts. It does not replace the saved result. The following GET
restores the saved terminal display with current eligibility. This distinction
prevents a retained successful result from being announced as a new success.

The new **Update status** control only issues an authenticated local GET. It
does not call iFinD, reset cooldown, reserve quota or retry. A new POST still
requires explicit confirmation and server-side quota/lease admission. Session
epoch checks, latest-request ordering and single-flight guards are retained.

## Offline evidence and release gates

- Envelope tests cover bounded metadata, safe errors, strict payload rejection
  and no retries.
- Runtime tests cover adapter-to-service-to-SQLite failure classification,
  cooldown recovery, terminal retention and zero calls for blocked POSTs.
- Browser controller regressions cover warning-only blocked POST feedback,
  preserved observations, local status refresh, stale sessions and races.
- The HTTP/browser integration fixture includes the required eligibility field.
- Test-only tuple and malformed-payload types are explicit; production validation
  is not loosened to satisfy type checking.
- Focused desktop (1440px) and mobile (390px) visual fixtures were exercised with
  HTTP network blocked. Screenshots are local under `output/playwright/` and are
  not production evidence.
- Full `npm run check` and PR `verify`, `security`, `container-build` results must
  be recorded in the PR before merge. The user performs the merge.
- `npm audit --audit-level=high` passed the high-severity gate. Two inherited
  moderate findings remain in the Tencent common SDK / `uuid` dependency chain;
  no force upgrade or dependency change is included here.

After merge, image preparation, production deployment and a real fixed-probe
attempt each remain separate approval gates. Reload the administrator page after
deployment so browser and server use the same strict DTO contract.

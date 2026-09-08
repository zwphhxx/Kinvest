# T11 fixed HK probe: safe envelope structure summary

## Trigger and approval boundary

After PR #73 deployment, the operator reported an identity-stage
`IFIND_RESPONSE_SHAPE` with `rejectionStage=envelope`. This identifies a local
validator boundary, not a proven token, entitlement or HK indicator failure.
The exact vendor response remains unknown and was not retained.

The operator approved bounded diagnostic instrumentation, offline tests and a
PR. This does not authorize a real vendor probe, server operation, production
deployment, quota change or family real-data publication.

## Contract

All fixed market-probe results have `envelopeSummary`, normally `null`.
It may be non-null only for a failed `IFIND_RESPONSE_SHAPE`, at an identity,
quote or financial business stage, with `rejectionStage=envelope`.

The exact summary keys are `rejectionRule`, `envelopeType`, `fields` and
`unknownFieldCount`. No field value, arbitrary key, vendor text, response
fragment, secret, RequestId or hash of raw content is included.

The `fields` object has exactly these fixed keys:

```text
errorcode tables dataVol errmsg perf datatype inputParams indicators time thscode data
```

Each value is one of the fixed type labels `missing`, `null`, `boolean`,
`integer`, `number`, `string`, `array`, `object`, `accessor`, `other` or
`uninspectable`. `envelopeType` uses the same labels except `missing` and
`accessor`. A missing field differs from a present null value; accessors and
uninspectable inputs are never evaluated or coerced to obtain values.

`unknownFieldCount` counts keys outside the fixed observation list. It is an
integer from 0 through 65, where 65 means at least 65, or null if safe inspection
is unavailable. Unknown key names are never returned. A known observation key
is NOT necessarily an accepted parser key: observing `indicators`, `time`,
`thscode` or `data` does not add it to the accepted envelope whitelist.

| Fixed rejectionRule | Meaning |
| --- | --- |
| `envelope-record` | Outer object shape |
| `envelope-fields` | Existing outer field contract |
| `metadata-errmsg` | Bounded errmsg metadata validation |
| `metadata-perf` | Bounded perf metadata validation |
| `metadata-datatype` | Bounded datatype metadata validation |
| `metadata-inputParams` | Bounded inputParams metadata validation |
| `errorcode-type` | Existing integer protocol-code validation |
| `data-volume-type` | Existing non-negative integer usage validation |
| `success-envelope` | Existing successful-response required fields |

Rules identify the failing local check, not a vendor explanation. The adapter
attaches only its own bounded projection to its branded safe error. Unknown
error origins cannot supply a summary. The service copies only a strict own
data property; malformed summaries become null, without exposing the rejected
value or losing the safe failure code. Lease/settlement failure and explicit
clear discard the summary. Status refresh can retain the last terminal summary
without causing a supplier call. It is not persisted to SQLite, audit or logs.

The browser checks the exact DTO and renders fixed Chinese labels through
textContent only. Its display explicitly distinguishes field observation from
parser acceptance. Original parser acceptance, identity checks, data limits,
single-flight, cooldown, shared quota and zero retries remain unchanged.

## Evidence and deployment gates

The HK identity indicator remains a candidate. The A-share basic-data example
in the [official manual](https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/help-center/manual.html)
does not establish HK applicability or the exact observed HK HTTP envelope.
No indicator substitution, successful identity claim, seven-dimensional
status promotion or liveReady change is part of this patch.

Offline fixtures must distinguish extra known observation fields from unknown
fields, missing/null/string usage, protocol-code types, individual metadata
failures, hostile accessors/proxies and bounded counts. Frontend fixtures must
reject malformed summaries and incompatible result states, render no arbitrary
values, and keep blocked POSTs from retrying. The new runtime module must be
present in built and container artifacts.

After user merge and successful CI, exact-image import and production rollout
require their own approvals. A subsequent real probe needs separate consent.
Offline success is not a claim that the original production incompatibility
has been identified or fixed.

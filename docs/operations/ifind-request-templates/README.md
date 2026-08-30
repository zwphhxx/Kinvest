# iFinD request evidence templates

These are non-executable documentation artifacts, not production manifests or
an implemented request generator. They preserve official metadata so that an
already observed parameter does not need to be rediscovered in the browser.
They do not change R1, authorize a provider call, or enable a live case.

## Available evidence

| Market and case | Recorded template | Current boundary |
| --- | --- | --- |
| HK / `HK_ALIBABA_9988` | [Revenue OAS, requested report end 2026-03-31](hk-alibaba-revenue-oas-20260331.v1.json) | One generated command and a derived HTTP body; no response or entitlement evidence |
| US / `US_APPLE_AAPL` | None | Do not copy HK indicator IDs, parameters, fiscal periods, or units |
| CN / `CN_MOUTAI_600519` | None | Do not copy HK indicator IDs, parameters, fiscal periods, or units |

All three production cases remain `liveReady: false`. This directory does not
supersede the [R1 administrator runbook](../ifind-three-market-admin-diagnostics.md)
or its independent deployment and per-call approval gates.

## Official documentation versus indicator discovery

The [official manual](https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/help-center/manual.html)
documents function and HTTP request contracts. In particular, a basic-data
HTTP request uses `codes` and an `indipara` array, with separate `indicator`
and `indiparams` entries. A generated SDK command is not itself an HTTP body.

The [official FAQ](https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/help-center/faq.html)
says there is no separate indicator document or data dictionary, and directs
users to the desktop or web SuperCommand tool for indicator discovery.
It also distinguishes the initially published consolidated report from the
subsequently adjusted consolidated report. Do not silently interchange those
report scopes.

Use published documentation first. Capture missing indicator metadata once
from the official tool, together with its source, date and applicability.
Do not invent a metadata endpoint, scrape credentials, or use fixture IDs as
vendor evidence. A future official catalog supplied by iFinD can be assessed
as an additional source; its availability is not assumed here.

## Exact observed HK command

On 2026-08-30 the user selected the following in
[official SuperCommand](https://quantapi.51ifind.com/gwstatic/static/ds_web/super-command-web/index.html#/BasicData):

- Global stocks, `9988.HK`, Alibaba's HKD trading counter.
- Revenue OAS, indicator `revenue_oas`.
- Custom report selector `2026 / Q1`, consolidated statements, original currency.
- Generate command only; the result-data panel remained empty.

The assistant read this generated command:

```python
THS_BD('9988.HK','revenue_oas','20260331,1,BB')
```

The corresponding HTTP request body, derived from the official manual but
**not executed**, is:

```json
{
  "codes": "9988.HK",
  "indipara": [
    {
      "indicator": "revenue_oas",
      "indiparams": ["20260331", "1", "BB"]
    }
  ]
}
```

Method: `POST`. Fixed destination:
`https://quantapi.51ifind.com/api/v1/basic_data_service`.
No credential or authentication header belongs in this artifact.

This proves the emitted date parameter, not the returned financial period.
The UI's Q1 label must not be used to label Alibaba's result as calendar Q1;
neither may the requested March year-end alone prove annual/YTD scope.
`BB` selects original currency but does not identify that currency or its
unit. Numeric scale must not be inferred from value magnitude. The candidate
indicator's definition and applicability to Alibaba remain unverified.

The seven runtime verification dimensions remain unverified: issuer identity,
vendor code, entitlement, currency, unit, report period and scope. Observing a
code/name pair in the official UI is useful metadata evidence, not a substitute
for validating the returned issuer and security identity.

## Reuse without repeating every UI operation

1. Reuse the documented HTTP structure and the recorded parameter meanings;
   preserve the evidence date and exact source.
2. Treat this JSON as one concrete fixed request. Changing a company or period
   creates a new reviewed request, not an expansion of the current approval.
3. For the same supported indicator/report type, use a future validated
   request builder to fill verified company codes and report-end dates.
   That builder is not delivered by this documentation change.
4. Validate each response's identity, currency, unit, disclosure scope and
   period. Do not copy Alibaba's fiscal calendar or reporting currency into
   another issuer. Unknown fields stay unknown, not Mock-filled.
5. Return to indicator discovery for a new market, indicator, report type,
   changed definition or unsupported parameter. Batch metadata preparation
   where the official tool supports it; never batch live calls under a
   single-case approval.

`fetchTime` and `sourceMode` are local provenance in PR #60: respectively the
trusted runtime clock and verified adapter boundary. They are not vendor
indicator IDs. An observed metadata template is not itself a verified adapter
result and must not be labeled `real`.

## Why the current R1 button cannot run this probe

The existing R1 run route accepts a JSON empty object and resolves a fixed,
complete case on the server. It rejects incomplete manifests with
`IFIND_MARKET_CASE_UNVERIFIED`. It does not accept this request body and does
not implement a revenue-only mode.

Do not set `liveReady` to true, forge the remaining evidence, add dummy
indicators, submit an arbitrary request body, or patch the running container
to get past that guard. No single-indicator calibration route or runner is
implemented by this change.

## Proposed smallest calibration gate, not approved or implemented

The next separate design/implementation decision is a fixed,
administrator-only calibration entry that can collect missing response
evidence without pretending the complete R1 case is ready.

| Item | Proposed bound |
| --- | --- |
| Company | Only `HK_ALIBABA_9988` / observed vendor code `9988.HK` |
| Business request | Exactly the fixed basic-data request above, at most once |
| Indicator / parameters | Only `revenue_oas`, `20260331,1,BB` |
| Authentication | At most one existing authorized token exchange if required; no credential change |
| Automatic retries | Zero, including authentication/format-repair retries |
| Concurrency | One; reserve the attempt transactionally and count failures |
| Output | Administrator-only, allowlisted and explicitly unverified until validation |
| Persistence | Normalized non-secret evidence and safe status only; no raw provider payload or credentials |
| Prohibited expansion | No quote request, additional company, additional date, run-all or household real-data enablement |

One selected value does not prove actual `dataVol` will be one. Record actual
usage if safely available; an unavailable usage value stays unknown. These
local limits are not evidence of the account's remaining vendor allowance.

Required sequence: approve the limited entry's design and implementation;
complete its tests, PR and user merge; separately approve any production
installation/deployment; then approve one exact live invocation at action
time. Merging this metadata PR authorizes none of those external actions.

Until those gates pass, retain Mock household data, existing login protection,
the current secret handling, and the unchanged R1 fail-closed manifests.

# Alibaba calibration: report-period evidence

Evidence review date: 2026-08-30. Scope: administrator-only calibration;
household pages remain Mock. This change authorizes no live request or release.

## Three different facts

1. The frozen request sends `revenue_oas` with `20260331,1,BB` for `9988.HK`.
2. The vendor's actual reporting period is not established by that request.
3. An issuer disclosure can provide comparison evidence without identifying
   the period, currency or unit of the vendor observation.

Keep these facts separate. A numeric match is a lead, not verification. Do not
assign 2025-06-30 to the observation merely because a published number matches.
Do not assign 2026-03-31 merely because the request contains `20260331`.

## Parameter evidence

The authenticated official [SuperCommand parameter editor](https://quantapi.51ifind.com/gwstatic/static/ds_web/super-command-web/index.html#/BasicData)
was inspected without running a data query on 2026-08-30.

| Parameter | Observed meaning | What it does not prove |
|---|---|---|
| `20260331` | Frozen report selector; earlier command-generation evidence recorded the UI choice `2026 / Q1` | The actual returned calendar/fiscal period, or quarter versus annual/YTD basis |
| `1` | Consolidated statements | Q1; this parameter is not a quarter number |
| `BB` | Original currency | CNY, HKD, USD, or a numerical scale |
| `8` | Latest period (MRQ) in the inspected editor | This is not the selector used by the frozen calibration request |

The editor's then-current draft used `8,1,BB`. It was not substituted into the
frozen request. No custom selector change was saved and no additional business
request was performed during this evidence review. A theory that `1` denotes
fiscal Q1 is expressly rejected by the observed editor labels.

## Primary disclosure comparisons

All rows describe Alibaba Group Holding Limited's consolidated revenue. Values
below are public issuer disclosures, not a persisted vendor response. Converting
a disclosure from CNY million to CNY units is arithmetic on that disclosure;
it does not establish the vendor's currency or unit.

| Evidence ID | Period | Basis | Published value | CNY-unit equivalent | Published on |
|---|---|---|---:|---:|---|
| `ALIBABA_REVENUE_20250630_QUARTER` | 2025-04-01 through 2025-06-30 | Quarter | CNY 247,652 million | 247,652,000,000 | 2025-08-29 |
| `ALIBABA_REVENUE_20260331_QUARTER` | 2026-01-01 through 2026-03-31 | Quarter | CNY 243,380 million | 243,380,000,000 | 2026-05-13 |
| `ALIBABA_REVENUE_20260331_YEAR` | 2025-04-01 through 2026-03-31 | Fiscal year | CNY 1,023,670 million | 1,023,670,000,000 | 2026-05-13 |

- [HKEX: June 2025 quarterly results](https://www1.hkexnews.hk/listedco/listconews/sehk/2025/0829/2025082901541_c.pdf): PDF page 1 identifies the issuer and quarter; PDF pages 5 and 6 contain the consolidated revenue comparison and discussion. The quarter is unaudited. Page numbers here are PDF page numbers, not printed footers.
- [Alibaba: March 2026 quarterly and full-year results](https://www.alibabagroup.com/zh-HK/document-1991237455038119936): the quarterly and full-year summaries distinguish the two bases despite their shared end date.

The June 2025 disclosure is a numerical comparison lead only. The March 2026
rows show why a requested date or a shared period-end cannot alone identify
a financial result. A mismatch between those public numbers and an unscoped
vendor number is not by itself proof of a vendor error.

## Validation boundary

- Preserve the raw selector as request metadata, never as a verified date.
- Keep actual period unknown until direct, reviewable vendor-period evidence
  exists for this exact indicator and selector.
- Compare full periods and basis, not just end dates: a quarter and a fiscal
  year ending on the same day are not equivalent.
- Unknown evidence stays unverified. Contradictory known periods fail closed.
- Source URLs, IDs, publication dates and disclosure values come from curated
  application evidence, not arbitrary vendor strings or browser input.
- A comparison match cannot promote report period, currency, unit, identity,
  entitlement or disclosure scope. All three full-market live manifests remain
  disabled and calibration cannot feed household data.
- Do not add automatic retries, another indicator, or a second period query.

## Remaining gate

Obtain direct official evidence for the exact `20260331` selector mapping and
the returned period/basis, then separately verify currency and scale. Any new
real call, request-template change, production release or household-data
activation still requires its own approval. This PR is local code, fixtures
and documentation only.

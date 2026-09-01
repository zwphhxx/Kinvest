# iFinD five-market template evidence catalog

Date: 2026-09-01. This catalog is a fail-closed preparation artifact for T11-B.
It is not a request generator, a provider entitlement statement or approval to
run a real iFinD query.

## Current decision

Five isolated templates now describe the evidence boundary for HK, US, SH, SZ
and BJ equities. Every template is `executable=false` and `liveReady=false`.
The top-level result is `executionStatus=blocked` with stable reason
`IFIND_TEMPLATE_NOT_EXECUTABLE`.
Every iFinD vendor code, issuer response, quote request and financial request
remains `unverified` until that market completes a separately approved probe.

| Template | Fixed sample | Evidence currently retained | Missing activation evidence |
| --- | --- | --- | --- |
| `HK_EQUITY_V2` | Alibaba `9988.HK` | SuperCommand candidate quote fields and `revenue_oas`; `09988.HK` formatting alias | Returned issuer, vendor code, entitlement, currency, unit, time and financial period/scope |
| `US_EQUITY_V2` | Apple `AAPL.US` | Official date-sequence example mentions `AAPL.O` | Exact vendor code, quote endpoint/fields, extended-hours semantics and 52/53-week financial template |
| `CN_SH_EQUITY_V2` | Kweichow Moutai `600519.SH` | Official A-share basic-data and real-time quotation examples | Sample-specific identity/response, currency/unit and financial indicators/parameters |
| `CN_SZ_EQUITY_V2` | Ping An Bank `000001.SZ` | Official exchange identity and generic A-share examples | iFinD identity plus bank-specific missing/not-applicable financial semantics |
| `CN_BJ_EQUITY_V1` | Guozi Software `920953.BJ` | Official exchange mapping identifies historical-code candidate `872953.BJ` | iFinD identity agreement, vendor code and all quote/financial request evidence |

## Evidence interpretation

The [official QuantAPI manual](https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/help-center/manual.html)
documents the generic Basic Data and Real-Time Quotation HTTP shapes. Its
A-share examples include `ths_stock_short_name_stock` and the real-time fields
`open`, `high`, `low` and `latest`. Those examples do not prove a response for
the fixed SH or SZ sample and cannot be copied to HK, US or BJ.

The [official examples](https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/example.html)
show generic A-share real-time usage. The manual's US date-sequence example
uses `AAPL.O`; this is evidence that Kinvest must keep display code and vendor
code separate, not evidence that `AAPL.O` is already validated for this
account or for another API.

The HK candidate fields came from the official SuperCommand UI observation
already recorded in the repository. A generated command proves only what the
tool emitted. It does not prove entitlement, returned identity, response
shape, currency, unit, time zone, report period or disclosure scope.

The [SZSE disclosure](https://disc.static.szse.cn/download/disc/disk03/finalpage/2026-01-24/93eea4ce-2e60-43ed-a0fa-c57d5fe41871.PDF)
and [BSE code mapping](https://www.bse.cn/service/code_mapping.html) are
exchange identity evidence. They do not prove iFinD vendor identity or
permission. Therefore `872953.BJ` remains a historical-code candidate and is
not exposed as an accepted alias.

## Runtime contract

`server/domain/ifind-market-template-evidence.js` ships a defensive-copy
catalog for future registration work. It rejects accessors, proxies, extra
fields and any attempt to promote a fixed entry to executable or live-ready.
Each source reference records a date and a narrow applicability scope; this
prevents a generic API example or a historical UI observation from silently
becoming market-wide evidence.
Candidate indicator IDs are discovery leads only. They cannot be passed to
the provider by this module.

The four activation blockers are intentionally identical across templates:

```text
IFIND_ISSUER_IDENTITY_UNVERIFIED
IFIND_VENDOR_CODE_UNVERIFIED
IFIND_QUOTE_TEMPLATE_UNVERIFIED
IFIND_FINANCIAL_TEMPLATE_UNVERIFIED
```

Clearing one blocker cannot clear another. A quote template can later become
usable while finance remains unavailable, but no block can silently use Mock
fields under a `real` label.

## Next gates

1. Prepare a reviewed, non-secret request proposal for one market.
2. Obtain explicit approval for that exact real probe.
3. Run at most the approved identity, quote and financial calls with no retry.
4. Store only normalized evidence and a safe summary; do not store raw provider
   responses, credentials or RequestId values.
5. Promote only the dimensions proved by the response. Unknown values remain
   unknown and the other four market templates remain unchanged.

No production deployment, family real-data display or automatic registration
is authorized by this evidence-catalog change.

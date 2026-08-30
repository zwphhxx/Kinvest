# iFinD admin diagnostic wire contract

This document fixes the non-secret HTTP contract for the Kinvest admin diagnostic probe. It does not authorize live calls, and it contains no account identifiers, production response data, or credentials.

## Official sources

- [iFinD HTTP interface deployment instructions](https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/help-center/deploy.html)
- [iFinD official Python HTTP example](https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/example.html)
- [iFinD date-offset response-field manual](https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/help-center/manual.html)

The official material identifies `refresh_token` as the header used to obtain an access token and `access_token` as the header used for data functions. Its HTTP example verifies both endpoint paths and the trade-date request shape. The official token example shows `errorcode`, `errmsg`, `data.access_token`, and `data.expired_time`. The date-offset manual identifies `errorcode`, `errmsg`, `tables`, `datatype`, `inputParams`, `perf`, and `dataVol` as response fields.

## Access-token exchange

```http
POST https://quantapi.51ifind.com/api/v1/get_access_token
Content-Type: application/json
refresh_token: <secret refresh token>
```

The request has an empty body. On a provider-classified success, `data.access_token` is used only for the immediately following probe. It must not be returned, logged, attached to an error, or persisted by this diagnostic client. `data.expired_time` is provider metadata and is not part of the diagnostic result.

## Fixed trade-date probe

```http
POST https://quantapi.51ifind.com/api/v1/get_trade_dates
Content-Type: application/json
access_token: <ephemeral access token>
ifindlang: cn
```

The JSON body is fully fixed. `startdate` uses the official example reference date `2022-07-05`:

```json
{"marketcode":"212001","functionpara":{"dateType":"0","period":"D","offset":"-10","dateFormat":"0","output":"sequencedate"},"startdate":"2022-07-05"}
```

This fixed request is a minimal diagnostic baseline. It deliberately removes weekend and current-date variability so repeated diagnostics exercise the same documented provider contract.

## Diagnostic result and error boundary

- `errorcode` classifies provider success or failure; it is never exposed as raw provider output.
- `errmsg` may inform internal classification and sanitization tests; its text is never exposed to callers.
- `dataVol` is the only provider response value retained in the successful diagnostic result. If supplied on a failed probe, it may be retained as numeric error metadata.
- `tables`, dates, `datatype`, `inputParams`, `perf`, `data.access_token`, and `data.expired_time` are not returned by the diagnostic API.
- Neither token may appear in a result, error message, enumerable error metadata, log, or nested cause.
- Provider text and `RequestId` values are discarded. Caller-visible failures use stable Kinvest error codes and messages.
- The client accepts an injected logger; success and failure logging must use sanitized messages and metadata only.

## Fixture policy

Contract fixtures are offline and synthetic. Tokens are visibly fake, dates are future synthetic dates, and fixtures contain no account IDs, `RequestId` fields, or copied production values.

## Three-market administrator extension

The administrator-only R1 extension is documented in the
[three-market administrator diagnostic runbook](ifind-three-market-admin-diagnostics.md).
It exposes only the fixed cases Alibaba `9988.HK`, Apple `AAPL.US`, and
Kweichow Moutai `600519.SH`; it does not turn this baseline client into an
arbitrary provider proxy. The family dashboard remains Mock.

The current production manifest is unverified and therefore remains fail-closed.
Authenticated indicator evidence and manifest verification are one gate; a
separately approved, single-case real invocation is a second gate. Neither
fixtures nor a successful CI run authorize a live request.

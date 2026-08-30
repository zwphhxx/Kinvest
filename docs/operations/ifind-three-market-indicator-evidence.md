# iFinD three-market indicator evidence

Verification date: 2026-08-29

This is the initial R1 implementation record. The dated follow-up below adds
metadata observations without promoting any production manifest to verified.

## Permitted official sources

| Source | Non-secret location | Redacted evidence summary |
|---|---|---|
| iFinD HTTP interface help center | https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/help-center/manual.html | Confirms the official HTTP interface documentation location and the two allowlisted market-data route families. Public material reviewed here did not establish the exact three-market security-code format, accepted quote fields, financial indicator IDs, or provider period parameters. |
| iFinD HTTP official examples | https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/example.html | Confirms the official examples location. The public examples were not sufficient evidence for the exact R1 metric manifests across Hong Kong, United States, and Mainland A-share listings. |
| iFinD authenticated indicator-query tool | Official iFinD indicator-query interface; no operation performed for this task | This is the required source for exact production indicator metadata when the public help material is insufficient. No authenticated query evidence was available in this implementation task. |

## Verification outcome

| Case | Exchange code | Display code | iFinD vendor code | Quote fields | Financial metric indicator IDs | Financial metadata indicator IDs | Provider period rules | Live manifest |
|---|---|---|---|---|---|---|---|---|
| `HK_ALIBABA_9988` | `9988` | `9988.HK` | unverified | unverified | unverified | unverified | unverified | rejected |
| `US_APPLE_AAPL` | `AAPL` | `AAPL.US` | unverified | unverified | unverified | unverified | unverified | rejected |
| `CN_MOUTAI_600519` | `600519` | `600519.SH` | unverified | unverified | unverified | unverified | unverified | rejected |

The exchange and display codes above identify Kinvest's fixed cases; they are not asserted to be verified iFinD vendor codes. Vendor financial metadata indicator evidence remains unavailable for currency, unit, report period, report date, period type, disclosure scope and source time. After PR #60, `fetchTime` comes from the trusted runtime clock and `sourceMode` comes from the verified adapter boundary; neither requires a vendor indicator ID. No production metric or vendor metadata indicator ID is recorded as verified, and no test-only fixture ID is accepted as production evidence. The catalog therefore fails closed for every production live request until exact official evidence and a non-secret source reference are recorded for every required vendor mapping and verification dimension.

## 2026-08-30 follow-up: reusable metadata, not live readiness

The official web SuperCommand tool displayed `9988.HK` with Alibaba and
generated the following command after the user selected `2026 / Q1`,
consolidated statements and original currency:

```python
THS_BD('9988.HK','revenue_oas','20260331,1,BB')
```

Only command generation was performed; the result-data panel remained empty.
This establishes a concrete date parameter and a candidate revenue indicator,
not the returned accounting definition, currency, unit, annual/YTD scope or
account entitlement. The production cases in the table above remain rejected.

The [request template and reuse policy](ifind-request-templates/README.md)
preserve this evidence, the derived but unexecuted HTTP body and a proposed
single-indicator calibration gate. That gate is not implemented or approved.
The current R1 run endpoint must not be repurposed to bypass its complete-case
evidence requirements. New markets and different report types need their own
metadata; repeated companies must still pass identity and response checks.

This record contains no credentials, account identifiers, raw provider payloads, or provider request identifiers.

## 2026-08-30 follow-up: calibration does not establish actual period

PR #62 subsequently implemented the separately gated administrator-only
calibration. The earlier "not implemented" statements above describe the
historical PR #61 state, not the current endpoint inventory.

The [report-period evidence review](ifind-report-period-evidence.md) records
official parameter labels and public issuer disclosures. The raw `20260331`
selector, actual returned period and comparison-disclosure period are different
facts. No comparison or numeric match promotes a verification dimension or
changes any of the three production full-case manifests to `liveReady: true`.

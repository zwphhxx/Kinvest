# iFinD three-market indicator evidence

Verification date: 2026-08-29

## Permitted official sources

| Source | Non-secret location | Redacted evidence summary |
|---|---|---|
| iFinD HTTP interface help center | https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/help-center/manual.html | Confirms the official HTTP interface documentation location and the two allowlisted market-data route families. Public material reviewed here did not establish the exact three-market security-code format, accepted quote fields, financial indicator IDs, or provider period parameters. |
| iFinD HTTP official examples | https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/example.html | Confirms the official examples location. The public examples were not sufficient evidence for the exact R1 metric manifests across Hong Kong, United States, and Mainland A-share listings. |
| iFinD authenticated indicator-query tool | Official iFinD indicator-query interface; no operation performed for this task | This is the required source for exact production indicator metadata when the public help material is insufficient. No authenticated query evidence was available in this implementation task. |

## Verification outcome

| Case | Exchange code | Display code | iFinD vendor code | Quote fields | Financial indicator IDs | Provider period rules | Live manifest |
|---|---|---|---|---|---|---|---|
| `HK_ALIBABA_9988` | `9988` | `9988.HK` | unverified | unverified | unverified | unverified | rejected |
| `US_APPLE_AAPL` | `AAPL` | `AAPL.US` | unverified | unverified | unverified | unverified | rejected |
| `CN_MOUTAI_600519` | `600519` | `600519.SH` | unverified | unverified | unverified | unverified | rejected |

The exchange and display codes above identify Kinvest's fixed cases; they are not asserted to be iFinD vendor codes. No production indicator ID is recorded as verified, and no test-only fixture ID is accepted as production evidence. The catalog therefore fails closed for every production live request until a separately approved authenticated indicator-query operation records exact official evidence.

This record contains no credentials, account identifiers, raw provider payloads, or provider request identifiers.

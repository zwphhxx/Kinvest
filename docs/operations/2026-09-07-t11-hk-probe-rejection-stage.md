# T11 fixed HK probe: bounded response-rejection location

## Approval and scope

Following PR #72, the operator reported an identity-stage `IFIND_RESPONSE_SHAPE`.
The approved next step is offline diagnostic instrumentation, tests and a PR.
No new vendor call, production deployment, secret access, quota increase or
family-data enablement is authorized by this change.

## What is known, and what is not

- The displayed stage identifies the identity business request, not an
  authentication-stage failure. It does not establish vendor entitlement.
- The exact rejected response is unknown. No raw vendor response is retained
  or requested for chat, logs, database or this document.
- The existing strict parser must not be loosened to guess that response.
- The official basic-data example uses `ths_stock_short_name_stock` with
  A-share codes. This does not prove HK applicability. The fixed proposal
  already records that limitation; its indicator and parameters remain unchanged.
- General multi-language return-field documentation and trade-date examples
  do not prove the precise basic-data HTTP envelope for this HK request.

Public references:

- [Official API manual](https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/help-center/manual.html)
- [Official application examples](https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/example.html)

HK identity remains a candidate requiring authoritative market-specific
indicator evidence. An eventual observation cannot promote issuer, vendor code,
entitlement, currency, unit, report period or scope automatically. `liveReady`
remains false; family data stays Mock.

## Exact additive result contract

Every fixed market-probe result contains `rejectionStage`. Its default is
`null`, including ready, busy, cooldown, daily-limit, successful-unverified,
unavailable, non-shape failures and failures with no known rejection location.

Only a failed `IFIND_RESPONSE_SHAPE` in an identity, quote or financial stage
can carry one of these fixed strings:

| Value | Validation boundary |
| --- | --- |
| `envelope` | Outer record, bounded optional metadata, protocol code or volume |
| `tables` | Table collection or row structure |
| `returned-code` | Returned security code |
| `indicator-fields` | Exact indicator-key record |
| `field-values` | Bounded arrays and primitive field values |

The value describes where validation stopped, not the underlying vendor cause.
It cannot distinguish missing permission, unsupported indicator or an envelope
variant without further approved evidence. No arbitrary key, value, message or
vendor response fragment is exposed. Existing acceptance rules are unchanged.

The service copies only an allowlisted own data property without invoking
getters or proxy traps. Strict server and browser DTOs reject extra fields,
unknown locations and locations attached to incompatible statuses or codes.
Lease/settlement failure clears the location. Local GET refresh preserves a
previous terminal location; blocked POST results remain idle with `null` and
do not announce old observations as a new successful run.

The location is in the authenticated administrator's in-memory result only;
it is not added to database rows, audit records or logs. Rendering uses fixed
Chinese labels and text nodes. Clear/restart may discard it.

## Acceptance and next gate

Offline fixtures cover all five rejection locations, adapter-to-service-to-DTO
propagation, hostile properties, safe clearing, retained cooldown results and
browser text rendering. Existing HTTP fixtures adopt the exact new DTO.
Tests use synthetic responses; they are not evidence of HK API support.

After CI and user merge, image import and production deployment need separate
approval. A subsequent real probe also needs its own approval and keeps the
existing single-flight, shared quota and zero-retry limits. Do not mark the
original production failure resolved merely because these offline tests pass.

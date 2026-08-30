# Fixed administrator-only iFinD calibration

## Scope and approval gates

This feature implements the request syntax preserved by PR #61. Implementation,
offline fixtures and PR approval do not authorize production rollout or a real
iFinD call. Deploy through the existing reviewed release chain only after a
separate production approval. Obtain a separate approval for each live attempt.
No new credential, vendor endpoint, household data source or deployment setting
is introduced. The three existing full market cases remain `liveReady: false`.

The only request is Alibaba `9988.HK`, indicator `revenue_oas`, parameters
`20260331,1,BB`. Neither the browser nor the HTTP request can change these values.
The request is sent to the fixed `basic_data_service` endpoint using `indipara`.
It does not use the full-case financial manifest or bypass that manifest's gate.

## Administrator entry

- `GET /api/admin/ifind/calibration`: local status only; no vendor request.
- `POST /api/admin/ifind/calibration/run`: exactly `{}`, administrator session,
  same-origin JSON, session-bound CSRF and trusted Nginx client identity.
- A deliberate confirmation is required in the administrator UI. No polling,
  page load or automatic retry can run a calibration.
- One attempt performs at most one authentication request and one business
  request. Authentication failure does not trigger a business request. A failed
  business request does not trigger token refresh or a retry.
- The existing tmpfs iFinD provider supplies a defensive refresh-token copy;
  temporary token buffers are cleared after the attempt.

## Quota and evidence isolation

Calibration reserves an Alibaba attempt in the existing SQLite market diagnostic
ledger before reading a secret or making a request. It shares the three-market
ledger's single pending lease, five-minute per-case cooldown, five Alibaba
attempts per Shanghai day and twelve market attempts per day. Failed attempts
still count. The older fixed trade-calendar probe retains its separate existing
quota; these market-ledger limits are not a vendor account allowance.

The ledger intentionally cannot record calibration as verified financial data.
An observed result is settled with `IFIND_CALIBRATION_OBSERVED_UNVERIFIED`,
`status=failed`, `quoteStatus=not_run`, `financeStatus=unavailable` and
`safeErrorClass=PERIOD_UNVERIFIED`: this means full-case evidence verification
has not passed, not that the transport necessarily failed. No financial point or
quote snapshot is inserted. Counts, timing and the stable outcome are persisted;
the normalized observed number is held only in runtime memory and can disappear
after restart. Raw provider payloads, messages and request identifiers are never
persisted or rendered.

All seven verification dimensions remain `unverified`, including identity and
entitlement. Matching a returned code is a structural guard, not independent
issuer verification. A single numeric observation or explicit null is allowed;
ambiguous response shape fails closed. Currency, unit, actual report period,
period type and disclosure scope remain unknown. `BB` does not establish a
currency, `20260331` does not prove an annual or quarterly reporting basis, and
value magnitude does not establish a unit or scale. Missing values are not zero
and are never filled from Mock.

`dataVol` is reported only when the provider supplies a validated nonnegative
integer. Missing usage remains unknown. One requested scalar does not imply
`dataVol=1`, one billable unit, or any known account balance. Household pages and
their APIs remain Mock and do not consume calibration observations.

## Offline acceptance and later release

Tests cover the exact wire body, no retries, administrator/CSRF/origin/body
boundaries, shared quota reservation, response filtering, unknown metadata,
buffer cleanup and the production-runtime-to-HTTP path with a fake transport
and real SQLite. Build allowlists include the new runtime modules; the existing
fresh-process and container runtime load checks exercise their imports.

After the three required PR checks pass, the user merges manually. Image import,
production deployment and the first real calibration remain separate approval
gates. This PR performs none of those operations.

## Report-period evidence follow-up

The [dated report-period evidence record](ifind-report-period-evidence.md)
separates the frozen request selector from actual vendor-period evidence and
public issuer comparisons. Matching a disclosure number cannot fill unknown
metadata or make the observation verified. The quarter and fiscal year ending
on the same date must remain distinct. Parameter `1` denotes consolidated
statements, not Q1; `BB` denotes original currency, not a confirmed currency.

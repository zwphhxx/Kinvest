# Kinvest T10-H iFinD Administrator Diagnostics Design

**Date:** 2026-08-26

**Status:** Approved design

## 1. Purpose

T10-H establishes the first real iFinD production integration behind the
existing administrator boundary. It verifies the production server's ability
to authenticate with iFinD and execute one fixed, low-volume data request. It
does not expose real iFinD data to family devices and does not replace any Mock
dashboard block.

The approved architecture is:

```text
GitHub Production Secret
  -> Production approval
  -> deploy-v5 encrypted SSH stdin
  -> independent /run tmpfs bundle
  -> server-side iFinD diagnostic client
  -> administrator-only API and UI
```

No paid secret-management service is introduced.

## 2. Scope

The fixed two-level diagnostic is:

1. Exchange the configured iFinD `refresh_token` for an in-memory access
   token.
2. After successful authentication, execute one fixed `trade-dates` probe.

The first release does not:

- query Alibaba or any other security;
- query realtime quotes, financial indicators, announcements, or data pools;
- accept a code, indicator, endpoint, date range, or request body from the
  browser;
- populate a family dashboard block with real data;
- mix Mock and real fields;
- claim that the official remaining iFinD quota is known;
- schedule automatic probes;
- rotate or retrieve a refresh token from the iFinD login page.

The exact `trade-dates` request body and response mapping must be verified
against the official iFinD documentation or an official client implementation
before implementation. Field names must not be inferred.

## 3. Alternatives considered

### 3.1 Server-side diagnostic with an independent tmpfs bundle

This is the selected design. It proves the complete production path and forms
the narrowest reusable boundary for later real-data integration.

### 3.2 GitHub Actions one-shot diagnostic

This avoids placing the token on the CVM but does not verify CVM-to-iFinD
connectivity. It also reintroduces the cross-region runner path that has already
been unreliable for release artifacts.

### 3.3 Mac-only diagnostic

This remains useful for local operator checks through the macOS Keychain, but it
does not establish a production integration and cannot support the later server
data adapter.

## 4. Production configuration

Add one GitHub `Production` Environment Secret:

```text
KINVEST_IFIND_REFRESH_TOKEN
```

Add these `Production` Environment Variables:

```text
IFIND_DIAGNOSTIC_MODE
TMPFS_IFIND_REFRESH_TOKEN_VERSION_ID
DEPLOY_V5_ENABLED
```

`IFIND_DIAGNOSTIC_MODE` only accepts:

```text
disabled
admin-diagnostic
```

Version IDs use the existing production format:

```text
vYYYYMMDD-NNN
```

The refresh token is entered by the user directly in the GitHub Environment.
It must not be supplied in chat, an issue, a pull request, a terminal command,
an `.env` file, or a repository file.

## 5. Independent iFinD tmpfs bundle

The existing family-access bundle remains unchanged. iFinD receives a separate
bundle:

```text
/run/secrets/kinvest-ifind/
  manifest.json
  refresh-token
```

Keeping the bundle independent avoids weakening the current access provider's
exact-file contract.

The iFinD provider must:

- require `/run` to be tmpfs;
- mount the directory read-only into the application container;
- use directory ownership `root:10001` and mode `0550`;
- use file ownership `root:10001` and mode `0440`;
- open fixed files with `O_NOFOLLOW`;
- reject symlinks, hard links, extra files, replaced inodes, wrong ownership,
  wrong modes, oversized files, invalid UTF-8, NULs, CR/LF characters, control
  characters, and manifest mismatches;
- verify a canonical manifest containing the VersionId and SHA-256 fingerprint;
- expose only defensive Buffer copies to the iFinD runtime;
- clear owned Buffers during shutdown and failure cleanup.

The refresh token necessarily exists transiently in JavaScript process memory
while constructing the authentication request. The implementation must avoid
logging or persisting it, but it must not claim immediate or guaranteed memory
erasure for immutable runtime strings.

## 6. Application configuration and startup

Add an internal configuration boundary:

```text
KINVEST_IFIND_DIAGNOSTIC_MODE=disabled|admin-diagnostic
KINVEST_IFIND_SECRET_BUNDLE_PATH=/run/secrets/kinvest-ifind
KINVEST_IFIND_REFRESH_TOKEN_VERSION_ID=vYYYYMMDD-NNN
```

Rules:

- `disabled` mode does not read or mount an iFinD bundle.
- `admin-diagnostic` requires a structurally valid bundle before `listen()`.
- A missing or malformed configured bundle fails application startup.
- Application startup does not contact iFinD. A third-party outage must not
  prevent the already-protected Mock dashboard from starting.
- Authentication and probe failures affect only the diagnostic result.
- The public `/api/health` response structure remains unchanged and does not
  reveal iFinD configuration.

## 7. iFinD client boundary

The server client uses only official endpoints:

```text
POST /api/v1/get_access_token
POST /api/v1/get_trade_dates
```

The final trade-date endpoint spelling and payload are an implementation gate
and must be confirmed from official documentation before code is accepted.

The client must:

- use fixed HTTPS origin and endpoint paths;
- send `refresh_token` only in the authentication header required by iFinD;
- hold the access token only in process memory;
- never copy either token into process environment variables;
- enforce bounded connect/request timeouts and response-size limits;
- discard the access token on an authentication error;
- permit at most one authentication recovery retry;
- retain `dataVol` when returned;
- preserve missing fields as missing;
- never return raw authentication responses, request headers, RequestId,
  stack traces, or unsanitized provider errors.

Stable error classes are:

```text
AUTH
PERMISSION
QUOTA
NETWORK
API
CONFIG
BUSY
RATE_LIMITED
```

## 8. Diagnostic service

The diagnostic service exposes no generic iFinD proxy. Each run always follows
the same two-stage sequence and fixed scope.

Controls:

- one in-flight diagnostic globally;
- a 60-second cooldown after every attempt;
- at most 20 attempts per local calendar day;
- failed requests, authentication retries, timeouts, and format failures count
  against the attempt limit;
- no background retry or schedule;
- no browser-supplied provider parameters;
- an injected clock, transport, and repository for deterministic tests.

The service records the route, fixed scope, local timestamp with timezone,
elapsed milliseconds, request count, returned `dataVol`, completeness, and a
safe error class.

The official HTTP documentation does not expose a reliable remaining-quota
endpoint. The result therefore reports:

```text
officialQuotaStatus=unavailable
dataVol=<returned value or unavailable>
localAttemptCount=<local count>
```

It must not represent a local counter as the official quota.

## 9. Administrator API

Add:

```text
GET  /api/admin/ifind/diagnostics
POST /api/admin/ifind/diagnostics/run
```

The read endpoint requires a valid administrator session. The mutation also
requires the established mutation order:

1. same-origin validation;
2. administrator session and CSRF validation;
3. strict JSON parsing and business validation.

The run endpoint accepts only an empty JSON object. An administrator cookie
still does not authorize investment-data APIs without a valid family-device
cookie.

Responses may contain:

- diagnostic mode and configured state;
- non-secret token VersionId;
- start and completion timestamps;
- authentication and trade-date stage status;
- fixed route and scope;
- request count, elapsed time, `dataVol`, completeness, and safe error class;
- cooldown end and local daily attempt count.

Responses must not contain token material, fingerprints, raw requests, raw
responses, provider RequestId values, or third-party error bodies.

## 10. Persistence and audit

Use an expand-only SQLite migration for sanitized diagnostic runs. The table
stores:

```text
diagnosticId
startedAt
completedAt
authStatus
probeStatus
safeErrorClass
route
requestCount
dataVol
elapsedMs
completeness
tokenVersionId
```

It stores no request/response body, request header, refresh token, access token,
or secret fingerprint. Existing images can ignore the additive table, so a
compatible image rollback does not require database restoration.

The security audit records only stable event metadata for diagnostic start,
success, failure, and rate limiting.

## 11. Administrator UI

Add an `iFinD connection diagnostics` section to `/admin` that:

- clearly states that this is administrator-only diagnostics;
- clearly states that the family dashboard is still Mock;
- shows configured state and the non-secret VersionId;
- provides one `Run two-level diagnostic` action;
- displays authentication and trade-date results independently;
- shows returned `dataVol` and `Official remaining quota unavailable`;
- shows cooldown and local daily attempts;
- renders all provider-derived text through text nodes, never `innerHTML`.

No real security, quote, financial, or announcement data appears in this UI.

## 12. deploy-v5 and joint state

The v4 protocol remains immutable. A new deploy-v5 protocol carries the
optional iFinD configuration and material through encrypted SSH stdin.

The deployment implementation must:

- keep all secret values out of command arguments, `ps`, logs, shell history,
  Docker inspect, state files, and persistent Docker configuration;
- build the candidate iFinD bundle under `/run` while holding the existing
  deployment lock;
- run an offline structural preflight before database backup or Compose switch;
- pass only mode, VersionId, and read-only bundle path to Compose;
- remove failed candidate bundles and unreferenced old bundles;
- preserve the current access-control bundle independently;
- verify the exact offline-attested image ID and digest before switching.

Joint deployment state advances to a new schema and adds:

```text
ifindDiagnosticMode
ifindRefreshTokenVersionId
ifindSecretBundleId
ifindSecretMaterialFingerprint
```

The state remains `root:root 0600` and stores only the SHA-256 fingerprint, not
the token.

The same VersionId with a different fingerprint fails with
`SECRET_VERSION_REUSE_CONFLICT`.

`ROLLBACK` uses the currently approved GitHub token material with the previous
compatible image. It does not restore revoked token material. `RESTORE`
reconstructs both current tmpfs bundles without changing image digest, runtime
image ID, commit, schema, release provenance, or database.

## 13. Failure behavior

- Invalid configured bundle: fail before listening.
- Token exchange failure: keep the protected Mock site running and report a
  safe diagnostic failure.
- Trade-date failure: record the authentication success and probe failure
  separately.
- Candidate bundle or preflight failure: do not back up the database, switch
  Compose, or write success state.
- New container failure: apply the existing compatible rollback boundary using
  the current approved secret material.
- CVM restart: tmpfs disappears and the site remains fail-closed until an
  approved `RESTORE` reconstructs both bundles.
- Suspected token disclosure: replace the GitHub Environment Secret with a new
  VersionId, deploy it through Production approval, and do not retain the
  revoked token for compatibility.

## 14. Verification strategy

Automated coverage must include:

- disabled mode never reads or mounts the iFinD bundle;
- strict bundle metadata, exact-file, manifest, size, and anti-symlink checks;
- malformed token material fails before `listen()`;
- official endpoint and fixed payload allowlists;
- authentication success/failure and one bounded recovery retry;
- timeout, oversized response, invalid JSON, permission, quota, and API errors;
- no token or provider raw error in logs, responses, state, database, or Docker
  environment;
- one in-flight run, cooldown, daily attempt cap, and failed-attempt accounting;
- Origin, administrator, CSRF, JSON, and empty-body enforcement;
- anonymous, family-device-only, expired-admin, and cross-origin rejection;
- additive SQLite migration and sanitized persistence;
- deploy-v5 truncation, extra input, invalid mode, VersionId reuse conflict,
  preflight failure, rollback, and restore;
- existing device approval, tmpfs access secrets, deny-all metadata firewall,
  and Mock source contracts remain unchanged;
- `verify`, `security`, and `container-build` PR checks all pass.

Production acceptance must confirm:

- the exact attested image runs in `device-approval` mode;
- family devices continue to receive only Mock investment data;
- only an administrator can run the diagnostic;
- the two stages report independently and retain returned `dataVol`;
- official remaining quota is shown as unavailable;
- no token patterns appear in application, Nginx, Docker, deployment, or audit
  logs;
- `/api/health`, HTTPS, security headers, desktop/mobile family access, J3 timer,
  and metadata deny-all remain healthy;
- `DEPLOY_V5_ENABLED=false` is restored after acceptance.

## 15. Implementation phases and approval gates

| Phase | Work | Gate |
|---|---|---|
| H1 | Commit and review this design | User merges design PR |
| H2 | TDD iFinD bundle provider, official HTTP client, fixed diagnostic service, limits, and SQLite repository | User merges PR |
| H3 | Administrator API and UI | User merges PR |
| H4 | deploy-v5, independent tmpfs bundle, joint state, rollback, and restore | User merges PR |
| H5 | Install assets and deploy the new image with iFinD disabled | Separate server-install and Production approvals |
| H6 | User records the refresh token and VersionId in GitHub Production | User-only console action; no token in chat |
| H7 | Activate `admin-diagnostic` and run the first two-level production diagnostic | Production approval |
| H8 | Complete security acceptance and restore `DEPLOY_V5_ENABLED=false` | User restores deployment gate |

Real securities, financial indicators, family display, scheduled refresh, and
token-expiry reminders require later independently reviewed phases.

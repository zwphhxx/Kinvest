# Kinvest T10-H iFinD Administrator Diagnostics Implementation Plan

> **Required execution skills:** Use `superpowers:executing-plans`,
> `superpowers:subagent-driven-development`,
> `superpowers:test-driven-development`,
> `superpowers:requesting-code-review`,
> `superpowers:verification-before-completion`, and
> `superpowers:finishing-a-development-branch` while implementing this plan.

**Goal:** Add an administrator-only production iFinD diagnostic that exchanges
the approved refresh token and runs one fixed, low-volume trade-date probe while
all family investment data remains Mock.

**Architecture:** Preserve the existing access-control secret bundle and add an
independent iFinD bundle under `/run`. A disabled/administrator-diagnostic
runtime loads the bundle before listen but contacts iFinD only after an
authenticated administrator action. A fixed client and transactional SQLite
repository enforce one in-flight request, cooldown, and daily attempts. A new
deploy-v5 envelope transports the optional token through approved encrypted SSH
stdin and records only VersionId, bundle ID, and SHA-256 fingerprint.

**Tech stack:** Node.js 22 CommonJS, built-in `fetch`, `node:sqlite`, static HTML
and JavaScript, Python deployment contract, Bash deployment executor, Docker
Compose, GitHub Actions, Nginx.

**Approved design:**
`docs/superpowers/specs/2026-08-26-t10h-ifind-admin-diagnostics-design.md`

**Official iFinD references:**

- `https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/example.html`
- `https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/help-center/manual.html`
- `https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/help-center/deploy.html`

## Execution rules

- Keep `/Users/zhuwenpeng/Developer/Kinvest` untouched; it is a dirty, stale
  user workspace.
- Start each implementation PR from a newly fetched `origin/main` in a separate
  worktree.
- Never request or display the iFinD refresh token in chat.
- Never use a real token in local, PR, container-build, or fixture tests.
- Each implementation task starts with a failing test, then the smallest code
  change, then the focused test.
- Each PR receives a specification-compliance review and a code-quality/security
  review before it is offered for merge.
- The user manually merges every PR after `verify`, `security`, and
  `container-build` pass.
- Server assets, offline image import, Production deployment, secret entry, mode
  activation, and rollback/restore remain separate approval gates.
- Do not enable real family data, CAM, SSM, TCR, models, or metadata access.

## PR H2: iFinD secret and diagnostic core

### Task 1: Lock the official wire contract with sanitized fixtures

**Files:**

- Create: `docs/operations/ifind-admin-diagnostic-contract.md`
- Create: `server/tests/fixtures/ifind/access-token-success.json`
- Create: `server/tests/fixtures/ifind/trade-dates-success.json`
- Create: `server/tests/fixtures/ifind/provider-errors.json`
- Create: `server/tests/ifind-http-client.test.js`
- Modify: `server/tests/run-tests.js`

**Step 1: Document the verified request**

Record only the non-secret wire contract from the official iFinD HTTP example:

```json
{
  "marketcode": "212001",
  "functionpara": {
    "dateType": "0",
    "period": "D",
    "offset": "-10",
    "dateFormat": "0",
    "output": "sequencedate"
  },
  "startdate": "<Asia/Shanghai YYYY-MM-DD>"
}
```

The production implementation may substitute only the current Shanghai date.
Every other key and value is fixed. Record the official authentication header
name, access-token header name, success fields, error fields, and `dataVol` only
after verifying them in official documentation. If any of those fields cannot
be verified, stop this task and report the implementation gate rather than
guessing.

**Step 2: Add sanitized official-shaped fixtures**

Fixtures must contain fake token strings and synthetic dates. Do not copy an
account identifier, token, RequestId, or raw production response.

**Step 3: Write the first failing client test**

Assert exact HTTPS origin, exact endpoint path, fixed request body, required
headers, no token in result/error, and retained `dataVol`.

**Step 4: Run the focused test and confirm failure**

```bash
node -e "require('./server/tests/ifind-http-client.test').run()"
```

Expected: failure because `server/adapters/ifind-http-client.js` does not exist.

**Step 5: Commit the contract and red test**

```bash
git add docs/operations/ifind-admin-diagnostic-contract.md server/tests/fixtures/ifind server/tests/ifind-http-client.test.js server/tests/run-tests.js
git commit -m "test: lock iFinD diagnostic wire contract"
```

### Task 2: Implement the independent iFinD tmpfs provider

**Files:**

- Create: `server/security/ifind-secret-contract.js`
- Create: `server/security/ifind-tmpfs-secret-provider.js`
- Create: `server/tests/ifind-secret-contract.test.js`
- Create: `server/tests/ifind-tmpfs-secret-provider.test.js`
- Modify: `server/tests/run-tests.js`
- Modify: `scripts/build.js`

**Step 1: Write failing contract tests**

Cover:

- `disabled` has no VersionId or path;
- `admin-diagnostic` requires `vYYYYMMDD-NNN` and the fixed bundle path;
- unknown mode, extra fields, pointer names, CR/LF, NUL, control characters,
  invalid UTF-8, and oversized token fail with stable codes;
- the manifest is canonical and binds file, VersionId, and SHA-256;
- a valid read returns a defensive Buffer copy;
- `clear()` zeroes every owned Buffer.

**Step 2: Write failing filesystem tests**

Use a temporary fixture with the current process UID/GID overrides. Cover exact
file set, modes, ownership, regular file requirement, `O_NOFOLLOW`, inode
replacement, hard link count, extra file, directory replacement, and digest
mismatch.

**Step 3: Run both focused tests**

```bash
node -e "require('./server/tests/ifind-secret-contract.test').run()"
node -e "require('./server/tests/ifind-tmpfs-secret-provider.test').run()"
```

Expected: both fail before implementation.

**Step 4: Implement the minimum provider**

Use constants:

```text
/run/secrets/kinvest-ifind
manifest.json
refresh-token
root:10001
0550/0440
```

Keep this provider independent from
`server/security/github-tmpfs-secret-provider.js`; do not add a fourth file to
the existing access bundle.

**Step 5: Add runtime files to the build**

Include both new security files in `scripts/build.js` and assert their presence
in the existing build test.

**Step 6: Run focused tests again**

Expected: pass.

**Step 7: Commit**

```bash
git add server/security/ifind-secret-contract.js server/security/ifind-tmpfs-secret-provider.js server/tests/ifind-secret-contract.test.js server/tests/ifind-tmpfs-secret-provider.test.js server/tests/run-tests.js scripts/build.js server/tests/build.test.js
git commit -m "feat: add independent iFinD tmpfs provider"
```

### Task 3: Implement the fixed iFinD HTTP client

**Files:**

- Create: `server/adapters/ifind-http-client.js`
- Modify: `server/tests/ifind-http-client.test.js`
- Modify: `scripts/build.js`

**Step 1: Extend the failing test matrix**

Cover:

- exact token exchange and `get_trade_dates` calls;
- fixed Shanghai market probe and current Shanghai date;
- access token kept inside the client and never returned;
- one authentication recovery retry only;
- no retry for permission, quota, malformed response, or generic API failure;
- connection timeout, total timeout, response-size cap, invalid UTF-8, invalid
  JSON, non-2xx status, nonzero provider error, missing success fields, and
  missing `dataVol`;
- stable error class and code without raw provider text, token, RequestId, URL
  query, or request headers;
- `clear()` discards cached authentication state.

**Step 2: Run the focused test**

Expected: new cases fail.

**Step 3: Implement with injected transport**

Use Node's built-in `fetch` only through a small injected transport boundary.
Do not add an HTTP dependency. Set fixed origin and endpoints in code. Return a
sanitized result containing route, scope, retrieved time, elapsed time, request
count, `dataVol`, completeness, and safe error information.

**Step 4: Run the focused test**

Expected: pass.

**Step 5: Commit**

```bash
git add server/adapters/ifind-http-client.js server/tests/ifind-http-client.test.js scripts/build.js server/tests/build.test.js
git commit -m "feat: add fixed iFinD diagnostic client"
```

### Task 4: Add transactional diagnostic persistence and limits

**Files:**

- Create: `server/db/ifind-diagnostic-repository.js`
- Create: `server/services/ifind-diagnostic-service.js`
- Create: `server/tests/ifind-diagnostic-repository.test.js`
- Create: `server/tests/ifind-diagnostic-service.test.js`
- Modify: `server/tests/run-tests.js`
- Modify: `scripts/build.js`

**Step 1: Write failing repository tests**

Create an expand-only `ifind_diagnostic_runs` table and a singleton
`ifind_diagnostic_control` row. Test one immediate transaction that:

- reserves the only in-flight slot;
- resets daily attempts on the Asia/Shanghai date boundary;
- increments attempts before any network call;
- enforces 20 attempts per day and a 60-second cooldown;
- releases the in-flight slot and records a sanitized result on every terminal
  path;
- recovers a stale in-flight reservation after a bounded lease;
- stores no response body, request header, token, fingerprint, or provider
  RequestId.

**Step 2: Write failing service tests**

Test disabled, busy, cooldown, daily limit, successful two-stage execution,
authentication failure, probe failure after authentication success, timeout,
repository failure, and cleanup. Failed calls and the single authentication
retry must count toward `requestCount` while one diagnostic attempt remains one
daily attempt.

**Step 3: Run focused tests**

```bash
node -e "require('./server/tests/ifind-diagnostic-repository.test').run()"
node -e "require('./server/tests/ifind-diagnostic-service.test').run()"
```

Expected: fail.

**Step 4: Implement repository and service**

Reuse the existing Kinvest application-ID validation before creating tables.
Repositories must not own or close the shared SQLite connection. Store only the
approved sanitized columns from the design.

**Step 5: Run focused tests**

Expected: pass.

**Step 6: Commit**

```bash
git add server/db/ifind-diagnostic-repository.js server/services/ifind-diagnostic-service.js server/tests/ifind-diagnostic-repository.test.js server/tests/ifind-diagnostic-service.test.js server/tests/run-tests.js scripts/build.js server/tests/build.test.js
git commit -m "feat: add bounded iFinD diagnostic service"
```

### Task 5: Integrate the optional runtime before listen

**Files:**

- Create: `server/ifind-diagnostic-runtime.js`
- Create: `server/tests/server-ifind-bootstrap.test.js`
- Modify: `server/pre-listen-preparation.js`
- Modify: `server/server.js`
- Modify: `server/access-preflight.js`
- Modify: `server/tests/access-preflight.test.js`
- Modify: `server/tests/server-secret-bootstrap.test.js`
- Modify: `server/tests/run-tests.js`
- Modify: `scripts/build.js`

**Step 1: Write failing startup tests**

Assert:

- disabled mode never opens the iFinD bundle, creates a client, or contacts the
  network;
- `admin-diagnostic` is rejected unless access mode is `device-approval`;
- malformed configured material prevents `listen()`;
- structurally valid material starts without contacting iFinD;
- access and iFinD runtime cleanup both execute on startup failure, SIGTERM,
  SIGINT, and server close;
- `/api/health` is byte-for-byte unchanged;
- existing access preflight stays valid with iFinD disabled and gains a separate
  offline structural result when diagnostic mode is enabled.

**Step 2: Run focused startup and preflight tests**

Expected: fail.

**Step 3: Implement runtime integration**

Create the iFinD runtime after the access runtime and shared database are ready.
Pass it to the HTTP handler as a dependency, but do not add routes in this PR.
Cleanup in reverse dependency order and keep one owner for closing SQLite.

**Step 4: Run focused tests and the full local check**

```bash
node -e "require('./server/tests/server-ifind-bootstrap.test').run()"
node -e "require('./server/tests/access-preflight.test').run()"
npm run check
```

Expected: all pass.

**Step 5: Request two reviews**

- Specification review: exact design scope, no real family data, no generic
  proxy, no guessed iFinD fields.
- Security/code review: secret lifetime, error sanitization, SQLite transaction,
  startup cleanup, and concurrency.

Fix accepted findings test-first and rerun `npm run check`.

**Step 6: Commit final H2 integration**

```bash
git add server/ifind-diagnostic-runtime.js server/pre-listen-preparation.js server/server.js server/access-preflight.js server/tests scripts/build.js
git commit -m "feat: bootstrap administrator iFinD diagnostics"
```

### Task 6: Open and merge PR H2

Push the H2 branch and open a PR describing the fixed probe, secret boundary,
limits, and absence of live calls in CI. Wait for unique `verify`, `security`,
and `container-build` checks. The user manually merges after review.

## PR H3: Administrator API and UI

### Task 7: Add administrator-only diagnostic HTTP endpoints

**Files:**

- Create: `server/tests/http-ifind-diagnostic.test.js`
- Modify: `server/http/auth-http.js`
- Modify: `server/server.js`
- Modify: `server/tests/http-security-regression.test.js`
- Modify: `server/tests/run-tests.js`

**Step 1: Write failing HTTP tests**

Cover both new routes and prove:

- anonymous, family-device-only, expired administrator, malformed cookie, and
  cross-origin requests cannot read or trigger diagnostics;
- GET requires a valid administrator;
- POST order is Origin, administrator+CSRF, then JSON/body validation;
- POST accepts only `{}` and rejects non-JSON, extra keys, oversized and
  truncated bodies;
- status and result responses contain only approved fields;
- disabled, busy, rate-limited, auth failure, probe failure, and success map to
  stable HTTP statuses without raw provider errors;
- an administrator cookie still cannot read investment APIs.

**Step 2: Run the focused test and confirm failure**

```bash
node -e "require('./server/tests/http-ifind-diagnostic.test').run()"
```

**Step 3: Implement minimal routes**

Add:

```text
GET  /api/admin/ifind/diagnostics
POST /api/admin/ifind/diagnostics/run
```

Keep route authorization inside the existing administrator boundary so it uses
the same cookie, Origin, CSRF, and trusted-proxy rules.

**Step 4: Run focused and regression tests**

Expected: pass.

**Step 5: Commit**

```bash
git add server/http/auth-http.js server/server.js server/tests/http-ifind-diagnostic.test.js server/tests/http-security-regression.test.js server/tests/run-tests.js
git commit -m "feat: expose protected iFinD diagnostics"
```

### Task 8: Add the administrator diagnostic interface

**Files:**

- Modify: `public/admin.html`
- Modify: `public/admin.js`
- Modify: `public/admin-contract.js`
- Modify: `public/auth.css`
- Modify: `server/tests/frontend-auth-contract.test.js`
- Modify: `server/tests/frontend-auth-state.test.js`

**Step 1: Use `frontend-design` and preserve the existing visual language**

Add one focused card to the existing administrator dashboard, not a new design
system. The card must state `管理员诊断` and `家庭看板仍为 Mock` prominently.

**Step 2: Write failing frontend contract tests**

Test text-node rendering, button disabled/running/cooldown states, two-stage
status, `dataVol`, `官方剩余额度不可用`, local attempt count, safe errors, and
no `innerHTML`.

**Step 3: Implement the UI**

Reuse the existing CSRF lifecycle and abortable API helper. Do not poll while
the administrator is logged out. Do not display a raw provider message.

**Step 4: Run focused tests and local visual verification**

```bash
node -e "require('./server/tests/frontend-auth-contract.test').run()"
node -e "require('./server/tests/frontend-auth-state.test').run()"
npm run check
```

Start the local server with fake diagnostic dependencies and verify desktop and
mobile administrator flows. Save only screenshots containing synthetic data.

**Step 5: Request reviews and commit**

```bash
git add public/admin.html public/admin.js public/admin-contract.js public/auth.css server/tests/frontend-auth-contract.test.js server/tests/frontend-auth-state.test.js
git commit -m "feat: add iFinD administrator diagnostic UI"
```

### Task 9: Open and merge PR H3

Push, open the PR, wait for all three required checks, and ask the user to
manually merge. No secret or production change occurs in H3.

## PR H4: deploy-v5 and independent production bundle

### Task 10: Add the deploy-v5 contract and joint state

**Files:**

- Create: `deploy/server/deploy-v5-contract.py`
- Create: `server/tests/deploy-v5-contract.test.js`
- Create: `server/tests/deploy-v5-state.test.js`
- Modify: `server/tests/run-tests.js`

**Step 1: Write failing contract tests**

Define the exact v5 stdin envelope by extending v4 with fixed iFinD lines:

```text
KINVEST_DEPLOY_V5
<intent>
<digest>
<commit>
<release provenance>
<registry metadata>
<access provider>
<admin VersionId>
<HMAC VersionId>
<admin material>
<HMAC material>
<access policy>
<iFinD mode>
<iFinD VersionId or empty>
<iFinD refresh token or empty>
EOF
```

Test strict line count, LF-only input, character and size limits, no trailing
input, disabled/material consistency, VersionId pattern, canonical state,
fingerprints, forward, rollback, restore, and VersionId reuse conflict.

**Step 2: Preserve v4 compatibility tests**

Existing v4 payload and state parsing must remain unchanged. The new contract
may reuse audited helpers, but must not make v4 accept iFinD fields.

**Step 3: Implement the minimum contract**

State adds:

```text
ifindDiagnosticMode
ifindRefreshTokenVersionId
ifindSecretBundleId
ifindSecretMaterialFingerprint
```

State migration from current production initializes iFinD as disabled without
changing access state.

**Step 4: Run v5 and all v4 contract tests**

Expected: pass.

**Step 5: Commit**

```bash
git add deploy/server/deploy-v5-contract.py server/tests/deploy-v5-contract.test.js server/tests/deploy-v5-state.test.js server/tests/run-tests.js
git commit -m "feat: define deploy-v5 iFinD state"
```

### Task 11: Extend the executor, Compose, and offline preflight

**Files:**

- Create: `deploy/server/deploy-kinvest-v5`
- Create: `deploy/server/docker-compose-v5.yml`
- Create: `server/ifind-secret-preflight.js`
- Create: `server/tests/deploy-v5-executor.test.js`
- Create: `server/tests/docker-ifind-secret-bootstrap.test.js`
- Modify: `deploy/server/deploy-kinvest-v3.sh`
- Modify: `server/tests/run-tests.js`
- Modify: `scripts/build.js`
- Modify: `Dockerfile`

**Step 1: Write failing fake Docker/SSH tests**

Cover disabled forward, diagnostic forward, malformed material, preflight
failure before backup, exact runtime image check, Compose mount, successful
state, compatible rollback with current token, incompatible rollback, restore,
cleanup, and interrupted journal reconciliation.

Prove the token is absent from command arguments, fake `ps`, logs, state,
persistent Docker config, environment dump, database backup, and access bundle.

**Step 2: Implement protocol-gated executor support**

Reuse the current generic executor only behind protocol 5 branches. Keep
protocol 4 behavior covered and unchanged. Create the iFinD bundle under a
separate `/run` root and execute `server/ifind-secret-preflight.js` with a
non-root, read-only, capability-free, network-none container before backup.

**Step 3: Add Compose configuration**

Pass only mode, VersionId, and bundle path. Mount the iFinD directory read-only.
Do not put the token or access token in environment variables.

**Step 4: Run focused, v4 regression, container smoke, and build tests**

Expected: pass.

**Step 5: Commit**

```bash
git add deploy/server/deploy-kinvest-v5 deploy/server/docker-compose-v5.yml deploy/server/deploy-kinvest-v3.sh server/ifind-secret-preflight.js server/tests/deploy-v5-executor.test.js server/tests/docker-ifind-secret-bootstrap.test.js server/tests/run-tests.js scripts/build.js Dockerfile
git commit -m "feat: deploy independent iFinD tmpfs bundle"
```

### Task 12: Add workflow, forced command, sudoers, and atomic installer

**Files:**

- Create: `.github/workflows/deploy-production-v5-manual.yml`
- Create: `deploy/server/install-deploy-v5.sh`
- Create: `deploy/server/kinvest-deploy-v5.sudoers.in`
- Create: `deploy/server/deploy-v5-assets.sha256`
- Create: `server/tests/deploy-v5-workflow.test.js`
- Create: `server/tests/deploy-v5-installer.test.js`
- Modify: `deploy/server/kinvest-ssh-command-v3`
- Modify: `server/tests/workflow-contract.test.js`
- Modify: `server/tests/run-tests.js`

**Step 1: Write failing workflow tests**

Assert:

- only `Production` can access the token;
- deployment cannot run unless `DEPLOY_V5_ENABLED=true`;
- disabled mode emits empty iFinD lines and never references the Secret;
- diagnostic mode requires the Secret and VersionId;
- material is not written to `GITHUB_ENV`, command arguments, output, or SSH
  environment;
- the forced command is exactly `deploy-v5`;
- third-party Actions remain pinned to full commit SHAs.

**Step 2: Write failing installer tests**

Cover exact asset hashes, gate identity, sudoers validation, interruption
journal, atomic replacement, re-entry, rollback, and the invariant that install
does not restart containers or trigger a deployment.

**Step 3: Implement workflow and assets**

Reference `KINVEST_IFIND_REFRESH_TOKEN` only inside the approved deploy job and
only for diagnostic mode. Extend the dispatcher with `deploy-v5` after checking
every required v5 asset. Permit only the no-argument root v5 wrapper in sudoers.

**Step 4: Run all deploy tests and `npm run check`**

Expected: pass.

**Step 5: Commit**

```bash
git add .github/workflows/deploy-production-v5-manual.yml deploy/server/install-deploy-v5.sh deploy/server/kinvest-deploy-v5.sudoers.in deploy/server/deploy-v5-assets.sha256 deploy/server/kinvest-ssh-command-v3 server/tests/deploy-v5-workflow.test.js server/tests/deploy-v5-installer.test.js server/tests/workflow-contract.test.js server/tests/run-tests.js
git commit -m "feat: add controlled deploy-v5 workflow"
```

### Task 13: Add the production runbook and finish PR H4

**Files:**

- Create: `docs/operations/deploy-v5-ifind-diagnostics-runbook.md`
- Modify: `docs/operations/production-runbook.md`
- Modify: `docs/specs/2026-07-28-family-investment-dashboard-design.md`

Replace the obsolete paid SSM token procedure with the approved GitHub
Production Secret and tmpfs process. Document disabled baseline, token entry,
activation, probe, rotation, rollback, restore, reboot behavior, log scan, and
emergency disable. Preserve the rule that token acquisition is manual and no
token enters chat or persistent storage.

Run `npm run check`, request specification and security reviews, fix findings
test-first, push the branch, and wait for all required PR checks. The user
manually merges H4.

## H5: Disabled production baseline

### Task 14: Install deploy-v5 assets

**Approval gate:** Present exact merge commit, expected server asset hashes,
current health, current v4 state, rollback backup location, and the statement
that installation does not rebuild containers. Wait for explicit approval.

After approval:

- upload only the reviewed v5 asset bundle;
- verify its checksum as the unprivileged SSH user;
- move it to a root-only staging directory;
- run the atomic installer;
- confirm installed hashes, modes, owners, gate identity, sudoers syntax, and
  that the existing containers are unchanged;
- remove staging files after verification.

### Task 15: Import the exact candidate image offline

**Approval gate:** Present the merge commit, GHCR digest, expected linux/amd64
runtime image ID, local tar path, checksum, and proof-record inputs. Wait for
explicit approval.

After approval, follow the existing offline attestation chain. Do not pull from
GHCR on the CVM. Preserve the proof record and remove only tar archives after a
successful deployment and separate cleanup approval.

### Task 16: Deploy with iFinD disabled

The user sets:

```text
DEPLOY_V5_ENABLED=true
IFIND_DIAGNOSTIC_MODE=disabled
```

**Production gate:** Wait for explicit trigger approval and the user's GitHub
`Approve and deploy` action.

Verify exact image/digest, device approval, existing family sessions, Mock data,
SQLite quick check, HTTPS/security headers, J3 timer, metadata deny-all, empty
iFinD state, and no secret/log regression. The user restores
`DEPLOY_V5_ENABLED=false`.

## H6: User records the iFinD secret

### Task 17: Provide the minimum console checklist

The user obtains a new refresh token from the official iFinD account page and
enters it directly into GitHub `Settings -> Environments -> Production` as:

```text
KINVEST_IFIND_REFRESH_TOKEN
```

The user sets a new non-secret VersionId:

```text
TMPFS_IFIND_REFRESH_TOKEN_VERSION_ID=vYYYYMMDD-NNN
```

Do not ask the user to paste the value or a screenshot containing it. Confirm
only the Secret name and VersionId. Keep `IFIND_DIAGNOSTIC_MODE=disabled` and
`DEPLOY_V5_ENABLED=false` after entry.

## H7: Controlled diagnostic activation

### Task 18: Deploy administrator-diagnostic mode

The user sets:

```text
IFIND_DIAGNOSTIC_MODE=admin-diagnostic
DEPLOY_V5_ENABLED=true
```

Wait for explicit trigger approval and Production approval. Deploy the already
attested exact image. Verify the iFinD bundle structurally, joint state, access
bundle isolation, container health, family Mock data, and zero token patterns in
safe log scans.

### Task 19: Run the first two-level production diagnostic

The user logs into `/admin` and triggers the diagnostic. Verify:

- authentication and trade-date stages are independently visible;
- the fixed route and scope match the official contract;
- request count, elapsed time, completeness, and returned `dataVol` are shown;
- official remaining quota is `unavailable`;
- no securities, quotes, financial data, or raw provider response are shown;
- a second immediate attempt is blocked by cooldown;
- anonymous and family-device-only requests cannot access the endpoints;
- application/Nginx/audit/database/state scans contain no token or access token.

On `PERMISSION`, do not switch to iFinD UI or broaden the probe without a new
user decision. On `AUTH`, replace the Production Secret with a new VersionId and
redeploy; do not reuse a VersionId with different material.

## H8: Final acceptance and closure

### Task 20: Verify persistence, rollback boundaries, and final state

Run one approved Docker restart test. The tmpfs bundle should survive Docker
restart and the protected Mock site plus administrator diagnostic status should
recover. Do not reboot the CVM in T10-H unless separately approved; existing T7
rules already require Production `RESTORE` after an entire CVM reboot.

Confirm:

- exact runtime image and joint state;
- `device-approval` remains active;
- all family investment blocks remain Mock;
- `/api/health` remains unchanged;
- J3 timer is enabled/active;
- metadata is denied to every container;
- SQLite quick check and diagnostic semantic query pass;
- no secret or token appears in logs, state, database, Docker inspect, tar
  archive, or repository diff;
- desktop and mobile administrator pages render correctly;
- `DEPLOY_V5_ENABLED=false` is the final state.

Save only sanitized run IDs, hashes, timestamps, diagnostic statuses,
`dataVol`, health results, and screenshots. Update the plan status and mark
T10-H complete only after fresh verification evidence is collected.

## Deferred work

The following require new designs and approval gates:

- securities and vendor-code validation;
- realtime quote or financial indicator probes;
- cached real data blocks;
- family display authorization;
- scheduled iFinD refresh;
- refresh-token expiry reminders;
- real announcements, news, iFinD data pools, or models.

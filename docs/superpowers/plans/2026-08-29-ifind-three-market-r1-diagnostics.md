# Kinvest R1 Three-Market iFinD Administrator Diagnostics Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Use `superpowers:subagent-driven-development` for independent tasks, `superpowers:test-driven-development` before implementation, and `superpowers:verification-before-completion` before claiming completion.

**Goal:** Add administrator-only, separately triggered real iFinD quote and financial diagnostics for Alibaba `9988.HK`, Apple `AAPL.US`, and Kweichow Moutai `600519.SH`, while keeping all family investment APIs and pages in Mock mode.

**Architecture:** Extend the existing authenticated iFinD diagnostic runtime without adding secrets or a second token path. A fixed case catalog selects a market-specific request template and parser. A dedicated repository reserves quota atomically, stores sanitized run metadata and normalized snapshots, and never stores raw provider responses or credentials. New administrator endpoints expose only fixed cases; three independent admin cards render normalized results. R2 verified-company admission, R3 family reads, and R4 refresh/signals are explicitly out of scope.

**Tech Stack:** CommonJS on Node.js 22, built-in `node:sqlite`, existing static HTML/CSS/JavaScript administrator UI, existing tmpfs iFinD refresh-token provider, Node test runner modules, ESLint, TypeScript check mode, Docker image CI.

---

## Safety and scope gates

- Work from a fresh worktree based on the latest `origin/main`; never modify the dirty original `main` workspace.
- Do not add Environment Secrets, repository secrets, long-term cloud credentials, `.env` files, raw iFinD responses, refresh/access tokens, RequestId values, or sensitive provider errors.
- Do not call real iFinD from PR tests. All automated provider tests use committed, sanitized fixtures.
- Do not guess indicator IDs. Each production indicator must have official iFinD evidence before it can be marked `verified` in the fixed catalog.
- Keep `/api/watchlist`, `/api/search`, `/api/company/*`, refresh endpoints, deep research, and all family UI responses unchanged and Mock-only.
- Do not implement arbitrary browser-supplied security codes, R2 company admission, family real-data reads, background refresh, valuation, signals, announcements, or model analysis.
- Do not trigger Production deployment or a real diagnostic during implementation. Those are separate post-merge approvals.

## Fixed R1 cases

| Case ID | Issuer | Exchange code | Display code | Market template |
|---|---|---|---|---|
| `HK_ALIBABA_9988` | Alibaba Group Holding Limited | `9988` | `9988.HK` | Hong Kong |
| `US_APPLE_AAPL` | Apple Inc. | `AAPL` | `AAPL.US` | United States |
| `CN_MOUTAI_600519` | Kweichow Moutai Co., Ltd. | `600519` | `600519.SH` | Mainland A-share |

## Fixed R1 metrics

- Quote: latest price, previous close, open, high, low, volume, turnover, quote time, trading status, and currency.
- Financial: revenue, gross profit, attributable net profit, operating cash flow, receivables, inventory, and interest-bearing debt.
- Periods: latest two full fiscal years plus the latest disclosed interim period.
- Every real value preserves provider indicator ID, currency, unit, report period, disclosure scope, fetch time, and validation state.
- Missing provider fields remain explicit missing values; Mock values never fill a real block.

## Task 1: Record official indicator evidence and freeze the fixed catalog

**Files:**

- Create: `docs/operations/ifind-three-market-indicator-evidence.md`
- Create: `server/domain/ifind-market-cases.js`
- Create: `server/tests/ifind-market-cases.test.js`
- Modify: `server/tests/run-tests.js`

**Step 1: Query official indicator metadata without running a production diagnostic**

Use the authenticated iFinD indicator-query tool or official help material to verify, separately for HK, US, and A-share templates:

- Exact vendor security code.
- Quote field names accepted by `/api/v1/real_time_quotation`.
- Financial indicator IDs accepted by `/api/v1/basic_data_service`.
- Required date/report-period parameters.
- Returned currency, unit, report-period, and disclosure-scope fields.

Record only non-secret metadata, source location, verification date, and a redacted evidence summary. If any metric cannot be verified, mark it `unverified`; do not invent an ID and do not enable it in the live request manifest.

**Step 2: Write the failing catalog tests**

Test that:

- Exactly the three approved `caseId` values exist in stable display order.
- Issuer identity, exchange, exchange code, display code, format aliases, and vendor codes are distinct fields.
- `09988.HK` is only an Alibaba format alias; `09888.HK` is never an Alibaba alias.
- Browser input cannot alter vendor code, endpoints, fields, indicator IDs, periods, or parser selection.
- A live request manifest rejects any indicator without `verified` evidence.
- The returned catalog and nested arrays are immutable defensive copies.

Run:

```bash
node -e "Promise.resolve(require('./server/tests/ifind-market-cases.test').run()).catch((error)=>{console.error(error);process.exit(1)})"
```

Expected: FAIL because the catalog module does not exist.

**Step 3: Implement the minimal fixed catalog**

Export lookup and list functions, not a mutable object. Validate the catalog during module initialization and fail closed on duplicate case IDs, duplicate issuer/listing identities, invalid display codes, unverified live indicators, or unsupported endpoint names.

**Step 4: Run the focused test and register it in the suite**

Run the focused command again, then add the test to `server/tests/run-tests.js`.

Expected: PASS.

**Step 5: Commit**

```bash
git add docs/operations/ifind-three-market-indicator-evidence.md server/domain/ifind-market-cases.js server/tests/ifind-market-cases.test.js server/tests/run-tests.js
git commit -m "feat: freeze verified iFinD market cases"
```

## Task 2: Extend the iFinD client with fixed quote and financial operations

**Files:**

- Modify: `server/adapters/ifind-http-client.js`
- Modify: `server/contracts/ifind-diagnostic-errors.js`
- Modify: `server/tests/ifind-http-client.test.js`
- Create: `server/tests/fixtures/ifind/hk-quote-success.json`
- Create: `server/tests/fixtures/ifind/us-quote-success.json`
- Create: `server/tests/fixtures/ifind/cn-quote-success.json`
- Create: `server/tests/fixtures/ifind/hk-financial-success.json`
- Create: `server/tests/fixtures/ifind/us-financial-success.json`
- Create: `server/tests/fixtures/ifind/cn-financial-success.json`

**Step 1: Add failing client tests**

Test exact calls to:

- `/api/v1/get_access_token`
- `/api/v1/real_time_quotation`
- `/api/v1/basic_data_service`

Assert fixed host, fixed endpoint allowlist, 5-second request timeout, 256 KiB response cap, one response callback, defensive JSON snapshots, and no URL or indicator override from caller-controlled data. Cover auth, permission, quota, timeout, malformed JSON, oversized body, duplicate completion, provider rejection, and unknown error mapping.

Run:

```bash
node -e "Promise.resolve(require('./server/tests/ifind-http-client.test').run()).catch((error)=>{console.error(error);process.exit(1)})"
```

Expected: FAIL on the missing quote and financial methods.

**Step 2: Add safe error contracts**

Add stable stages `quote` and `financial` to the existing allowlisted failure rules. Persist only stable Kinvest error code, safe class, stage, and numeric vendor error code when allowed. Never expose provider messages, headers, RequestId, access token, refresh token, or raw response.

**Step 3: Implement the two minimal client methods**

Accept only frozen request objects created by the case catalog. Return defensive snapshots suitable for market parsers. Keep the existing dual-level trade-date probe behavior unchanged.

**Step 4: Run the focused client test**

Expected: PASS with all existing probe tests still passing.

**Step 5: Commit**

```bash
git add server/adapters/ifind-http-client.js server/contracts/ifind-diagnostic-errors.js server/tests/ifind-http-client.test.js server/tests/fixtures/ifind
git commit -m "feat: add fixed iFinD market data operations"
```

## Task 3: Normalize three-market quote responses without erasing market differences

**Files:**

- Create: `server/domain/ifind-market-quote-parser.js`
- Create: `server/tests/ifind-market-quote-parser.test.js`
- Modify: `server/tests/run-tests.js`

**Step 1: Write failing parser tests**

For each sanitized market fixture, assert normalized output contains:

```text
caseId
listingId
displayCode
latestPrice
previousClose
open
high
low
volume
turnover
quoteTime
tradingStatus
currency
source
verification
missingFields
```

Test that HKD, USD, and CNY are not inferred from display code when the provider currency is absent. Test market-specific trading states, timestamp formats, zero values, missing fields, invalid numbers, duplicate securities, wrong vendor code, and mixed-source payloads.

Run:

```bash
node -e "Promise.resolve(require('./server/tests/ifind-market-quote-parser.test').run()).catch((error)=>{console.error(error);process.exit(1)})"
```

Expected: FAIL because the parser module does not exist.

**Step 2: Implement explicit market parsers**

Use three parser profiles selected only by fixed `caseId`. Share primitive validators, but keep market-specific field mapping and trading-status mapping explicit. Return a pure `real` block only when issuer, vendor code, entitlement, currency, unit, report period, and scope statuses satisfy the approved quote contract; otherwise return a sanitized unavailable result with failed or unverified statuses.

**Step 3: Run and register the focused test**

Expected: PASS.

**Step 4: Commit**

```bash
git add server/domain/ifind-market-quote-parser.js server/tests/ifind-market-quote-parser.test.js server/tests/run-tests.js
git commit -m "feat: normalize market-specific iFinD quotes"
```

## Task 4: Normalize market-specific financial periods and units

**Files:**

- Create: `server/domain/ifind-market-financial-parser.js`
- Create: `server/tests/ifind-market-financial-parser.test.js`
- Modify: `server/tests/run-tests.js`

**Step 1: Write failing financial parser tests**

Assert seven metrics across latest two full fiscal years and latest interim period. Every point must preserve:

```text
metricKey
indicatorId
value
currency
unit
reportPeriod
reportDate
periodType
disclosureScope
sourceTime
fetchTime
verification
availability
```

Cover HK annual/interim disclosure, US fiscal-year boundaries and interim filing periods, and A-share annual/interim reporting. Test provider nulls, absent gross profit, incompatible units, currency mismatch, period mismatch, duplicate indicators, consolidated versus issuer-only scope, and non-finite values.

Run:

```bash
node -e "Promise.resolve(require('./server/tests/ifind-market-financial-parser.test').run()).catch((error)=>{console.error(error);process.exit(1)})"
```

Expected: FAIL because the parser module does not exist.

**Step 2: Implement three explicit financial profiles**

Do not calculate missing financial values from unrelated fields. Do not coerce currencies or units. A missing metric remains `availability: missing`. A block cannot become `real` by combining fixture or Mock values with provider values.

**Step 3: Run and register the focused test**

Expected: PASS.

**Step 4: Commit**

```bash
git add server/domain/ifind-market-financial-parser.js server/tests/ifind-market-financial-parser.test.js server/tests/run-tests.js
git commit -m "feat: normalize market-specific iFinD financials"
```

## Task 5: Add expand-only diagnostic reservation and snapshot storage

**Files:**

- Create: `server/db/ifind-market-diagnostic-repository.js`
- Create: `server/tests/ifind-market-diagnostic-repository.test.js`
- Modify: `server/tests/run-tests.js`

**Step 1: Write failing repository tests**

Test idempotent expand-only creation of:

```text
ifind_market_case_runs
ifind_market_quote_snapshots
ifind_market_financial_points
```

Test exact columns, constraints, foreign keys, indexes, application identity, and compatibility with existing authentication and dual-level diagnostic tables.

Test atomic reservation using `BEGIN IMMEDIATE`:

- Global in-flight limit: 1.
- Per-case cooldown: 5 minutes.
- Per-case daily attempt limit: 5 Shanghai-calendar-day attempts.
- Global daily attempt limit: 12 Shanghai-calendar-day attempts.
- Stale lease recovery without overwriting a completed run.

Test terminal writes, latest-run lookup, per-case history, quote snapshot replacement rules, financial point uniqueness, explicit null/missing storage, rollback on partial write, and rejection of raw response/provider-message fields.

Run:

```bash
node -e "Promise.resolve(require('./server/tests/ifind-market-diagnostic-repository.test').run()).catch((error)=>{console.error(error);process.exit(1)})"
```

Expected: FAIL because the repository does not exist.

**Step 2: Implement strict schema and repository methods**

Store only normalized, bounded fields. Keep run identity, case ID, timestamps, safe status, request count, token VersionId, quote snapshot, and financial points. Do not store access/refresh tokens, request headers, complete provider payloads, provider messages, RequestId, or full IP data.

**Step 3: Run and register the focused test**

Expected: PASS, including two-connection concurrency tests on a temporary SQLite file.

**Step 4: Commit**

```bash
git add server/db/ifind-market-diagnostic-repository.js server/tests/ifind-market-diagnostic-repository.test.js server/tests/run-tests.js
git commit -m "feat: persist bounded iFinD market diagnostics"
```

## Task 6: Orchestrate one fixed case per administrator action

**Files:**

- Create: `server/services/ifind-market-diagnostic-service.js`
- Create: `server/tests/ifind-market-diagnostic-service.test.js`
- Modify: `server/tests/run-tests.js`

**Step 1: Write failing service tests**

Test this order:

1. Resolve fixed case ID.
2. Reserve SQLite quota and lease.
3. Load the existing in-memory iFinD refresh-token provider reference.
4. Authenticate once.
5. Request quote once.
6. Request financial data with no more than three bounded calls.
7. Parse by fixed market profile.
8. Persist sanitized terminal state and snapshots atomically.
9. Clear all access-token and raw-response buffers in `finally`.

Cover successful HK, US, and A-share runs; partial financial availability; quote failure; financial failure; auth failure; quota rejection; lease conflict; parser mismatch; repository failure; timeout; and cleanup after every failure. Enforce a maximum of five iFinD HTTP requests per run.

Run:

```bash
node -e "Promise.resolve(require('./server/tests/ifind-market-diagnostic-service.test').run()).catch((error)=>{console.error(error);process.exit(1)})"
```

Expected: FAIL because the service does not exist.

**Step 2: Implement the minimal orchestration service**

Dependency-inject clock, ID generator, catalog, client, parsers, repository, and secret provider. Never accept a security code, endpoint, field, indicator, period, or parser from HTTP input.

**Step 3: Run and register the focused test**

Expected: PASS.

**Step 4: Commit**

```bash
git add server/services/ifind-market-diagnostic-service.js server/tests/ifind-market-diagnostic-service.test.js server/tests/run-tests.js
git commit -m "feat: orchestrate fixed iFinD market cases"
```

## Task 7: Wire R1 into startup without creating a new secret path

**Files:**

- Modify: `server/ifind-diagnostic-runtime.js`
- Modify: `server/pre-listen-preparation.js`
- Modify: `server/server.js`
- Create: `server/tests/server-ifind-market-diagnostic.test.js`
- Modify: `server/tests/run-tests.js`

**Step 1: Write failing startup tests**

Test that:

- `disabled` iFinD mode never initializes the R1 live service.
- Enabled mode reuses the existing tmpfs refresh token and VersionId; no new environment variable or secret file is introduced.
- Missing secret, invalid catalog, incompatible SQLite schema, or repository initialization failure prevents the R1 service from becoming callable.
- Existing `/api/health`, dual-level diagnostic, access-control startup, and family Mock runtime remain unchanged.
- SIGTERM/SIGINT cleanup clears provider/client buffers.

Run:

```bash
node -e "Promise.resolve(require('./server/tests/server-ifind-market-diagnostic.test').run()).catch((error)=>{console.error(error);process.exit(1)})"
```

Expected: FAIL before runtime wiring exists.

**Step 2: Add runtime wiring**

Initialize the fixed catalog and repository during pre-listen preparation, then inject the service into HTTP routing. Do not add a public feature flag that enables arbitrary companies.

**Step 3: Run and register the focused test**

Expected: PASS.

**Step 4: Commit**

```bash
git add server/ifind-diagnostic-runtime.js server/pre-listen-preparation.js server/server.js server/tests/server-ifind-market-diagnostic.test.js server/tests/run-tests.js
git commit -m "feat: bootstrap iFinD market diagnostics"
```

## Task 8: Add administrator-only fixed-case HTTP endpoints

**Files:**

- Create: `server/http/ifind-market-diagnostic-http.js`
- Create: `server/tests/http-ifind-market-diagnostic.test.js`
- Modify: `server/server.js`
- Modify: `server/tests/http-security-regression.test.js`
- Modify: `server/tests/run-tests.js`

**Step 1: Write failing HTTP integration tests**

Cover:

```text
GET  /api/admin/ifind/market-cases
GET  /api/admin/ifind/market-cases/:caseId
POST /api/admin/ifind/market-cases/:caseId/run
```

Assert valid administrator session for every endpoint, and same-origin plus CSRF for POST. Accept no request body for run. Reject unknown case IDs, extra path segments, non-JSON mutation requests, oversized bodies, forged proxy identity, administrator Cookie absence/expiry, and device-only sessions.

Assert responses contain only fixed catalog metadata, sanitized run status, normalized quote/financial blocks, quota metadata, and stable error codes. Verify no raw provider body, message, RequestId, access token, refresh token, headers, VersionId beyond approved non-secret metadata, or family data appears.

Assert all family investment routes remain `401 AUTH_REQUIRED` without a device Cookie and remain Mock after device authorization.

Run:

```bash
node -e "Promise.resolve(require('./server/tests/http-ifind-market-diagnostic.test').run()).catch((error)=>{console.error(error);process.exit(1)})"
```

Expected: FAIL because the routes do not exist.

**Step 2: Implement the route module**

Reuse the existing administrator session, trusted-client, Origin, CSRF, JSON, and audit helpers. Map only stable service errors to HTTP status. Keep `/api/health` unchanged.

**Step 3: Run focused HTTP and security regression tests**

```bash
node -e "Promise.resolve(require('./server/tests/http-ifind-market-diagnostic.test').run()).catch((error)=>{console.error(error);process.exit(1)})"
node -e "Promise.resolve(require('./server/tests/http-security-regression.test').run()).catch((error)=>{console.error(error);process.exit(1)})"
```

Expected: PASS.

**Step 4: Commit**

```bash
git add server/http/ifind-market-diagnostic-http.js server/server.js server/tests/http-ifind-market-diagnostic.test.js server/tests/http-security-regression.test.js server/tests/run-tests.js
git commit -m "feat: expose admin-only iFinD market diagnostics"
```

## Task 9: Build three separate administrator diagnostic cards

**Files:**

- Modify: `public/admin-contract.js`
- Modify: `public/admin.html`
- Modify: `public/admin.js`
- Modify: `public/auth.css`
- Modify: `scripts/build.js`
- Create: `server/tests/frontend-ifind-market-diagnostic.test.js`
- Modify: `server/tests/frontend-auth-contract.test.js`
- Modify: `server/tests/build.test.js`
- Modify: `server/tests/run-tests.js`

**Step 1: Write failing front-end contract tests**

Assert:

- Three cards exist in HK, US, A-share order.
- Each card displays fixed issuer/code/market and has its own run button.
- No run-all button, arbitrary security-code input, endpoint input, or indicator input exists.
- Cards render last run, cooldown, daily allowance, quote time, trading state, currency, units, periods, validation statuses, missing fields, and safe errors.
- Running one card disables only unsafe conflicting actions while global concurrency is occupied, then refreshes all quota labels.
- Rendering uses `textContent`/DOM nodes and never passes provider or device text to `innerHTML`.
- Existing administrator login, device approval, revoke, audit, and dual-level diagnostic controls remain functional.

Run:

```bash
node -e "Promise.resolve(require('./server/tests/frontend-ifind-market-diagnostic.test').run()).catch((error)=>{console.error(error);process.exit(1)})"
```

Expected: FAIL because the cards do not exist.

**Step 2: Implement the cards in the existing visual language**

Use the established administrator typography, colors, spacing, and responsive layout. Make missing and unverified values visually distinct from zero. Show an explicit administrator-diagnostic-only notice and retain the global Mock-family notice.

**Step 3: Run focused front-end and build tests**

```bash
node -e "Promise.resolve(require('./server/tests/frontend-ifind-market-diagnostic.test').run()).catch((error)=>{console.error(error);process.exit(1)})"
node -e "Promise.resolve(require('./server/tests/frontend-auth-contract.test').run()).catch((error)=>{console.error(error);process.exit(1)})"
node -e "Promise.resolve(require('./server/tests/build.test').run()).catch((error)=>{console.error(error);process.exit(1)})"
```

Expected: PASS.

**Step 4: Commit**

```bash
git add public/admin-contract.js public/admin.html public/admin.js public/auth.css scripts/build.js server/tests/frontend-ifind-market-diagnostic.test.js server/tests/frontend-auth-contract.test.js server/tests/build.test.js server/tests/run-tests.js
git commit -m "feat: add three-market admin diagnostic cards"
```

## Task 10: Document operation, quotas, data semantics, and rollback

**Files:**

- Create: `docs/operations/ifind-three-market-admin-diagnostics.md`
- Modify: `docs/operations/ifind-admin-diagnostic-contract.md`
- Modify: `README.md`
- Create: `server/tests/ifind-market-diagnostic-docs.test.js`
- Modify: `server/tests/run-tests.js`

**Step 1: Write the failing documentation contract test**

Require documentation for fixed cases, endpoints, exact quotas, safe errors, indicator evidence, market/accounting differences, missing-value behavior, no-Mock-mixing rule, administrator-only boundary, audit fields, real-call approval, and rollback.

**Step 2: Write the runbook**

Include a two-gate rollout:

1. Deploy the image with R1 routes/cards present but perform no real calls.
2. After production health and UI validation, obtain explicit approval separately for each real market-case run.

State that one successful case does not verify another market, another issuer, or family-display authorization.

**Step 3: Run and register the docs test**

Expected: PASS.

**Step 4: Commit**

```bash
git add docs/operations/ifind-three-market-admin-diagnostics.md docs/operations/ifind-admin-diagnostic-contract.md README.md server/tests/ifind-market-diagnostic-docs.test.js server/tests/run-tests.js
git commit -m "docs: add iFinD market diagnostic runbook"
```

## Task 11: Full verification, visual QA, security review, and PR

**Files:**

- Create: `docs/verification/2026-08-29-ifind-three-market-r1.md`
- Add only non-secret desktop/mobile screenshots if browser verification produces useful artifacts.

**Step 1: Run the complete automated suite**

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: all commands exit 0.

**Step 2: Build the production container without pushing**

```bash
docker build --platform linux/amd64 -t kinvest:r1-local .
```

Expected: image builds and the existing container smoke checks pass. Do not log in to a registry and do not push.

**Step 3: Verify desktop and mobile behavior with fixture-backed local runtime**

Check administrator login, existing dual-level diagnostic, each of the three separate cards, loading/success/partial/error states, missing values, long units/period labels, narrow mobile layout, and absence of console errors. Confirm family pages and investment APIs remain Mock-only.

**Step 4: Perform security and data-boundary review**

Check:

- No PR workflow references Production Environment or Secrets.
- No `pull_request_target`, image push, or writable token is added.
- No browser-controlled security code, endpoint, field, indicator, or period reaches the provider client.
- No secret, token, raw response, RequestId, provider message, `.env`, or sensitive log enters the diff.
- No real block contains Mock values.
- `09888.HK` is never mapped to Alibaba.
- All administrator mutations enforce session, same-origin, CSRF, body limit, and quota.

**Step 5: Request independent reviews**

Use `superpowers:requesting-code-review` for correctness and security review. Treat subagent findings as auxiliary; resolve material findings with TDD before proceeding.

**Step 6: Record evidence**

Write exact commands, results, visual viewport sizes, screenshot paths, known limitations, and confirmation that no real iFinD call or production change occurred.

**Step 7: Final diff and sensitive-data check**

```bash
git diff --check origin/main...HEAD
git status --short
git log --oneline origin/main..HEAD
```

Inspect every changed path and scan the complete commit range for secrets before push.

**Step 8: Push and create the implementation PR**

```bash
git push -u origin feat/ifind-three-market-r1-diagnostics
gh pr create --base main --head feat/ifind-three-market-r1-diagnostics
```

Wait for unique `verify`, `security`, and `container-build` checks. User performs the final review and manual merge.

## Post-merge production gates

These gates are not authorized by implementation-plan approval or PR merge:

1. Install any changed server/deployment assets only if the R1 image requires them and after a separate approval.
2. Offline-download, attest, upload, and import the exact merged image after a separate approval.
3. Run a disabled/no-real-call production baseline after enabling the deployment gate and approving Production.
4. Restore the deployment gate to `false`.
5. Request a separate explicit approval for each real case run: HK, US, and A-share.
6. Keep all family pages and APIs in Mock mode regardless of administrator diagnostic success.
7. R2 verified-company admission requires a new approved design and implementation plan.

## R1 acceptance criteria

- Exactly three fixed cases exist and each has a separate administrator action.
- All production indicator IDs have official evidence; unverified metrics cannot be called live.
- HK, US, and A-share responses use separate, tested mappings and preserve currency, unit, period, and disclosure differences.
- Quote and financial snapshots are pure real blocks or explicit unavailable/missing data; Mock values never fill them.
- Global concurrency, per-case cooldown, per-case daily quota, global daily quota, and request-count caps are atomic.
- Raw provider payloads and secrets are absent from HTTP responses, logs, SQLite, state files, screenshots, and commits.
- Family investment APIs remain protected and Mock-only.
- Existing authentication, device approval, tmpfs secrets, deny-all metadata firewall, dual-level diagnostic, health endpoint, and deployment contracts have no regression.
- Full local verification and all three PR checks pass before user merge.

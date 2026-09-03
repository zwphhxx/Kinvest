# T11 HK Fixed Probe Admin Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the merged `HK_ALIBABA_9988_V1` fixed probe through a separate, administrator-only HTTP and UI entry without calling real iFinD during development or publishing any result to the family dashboard.

**Architecture:** Extend the existing iFinD diagnostic runtime with a dedicated probe client and `createIfindMarketProbeService`, route one immutable proposal through the established administrator session/Origin/CSRF boundary, and render the strict in-memory DTO through a separate browser controller. Reuse the existing tmpfs provider and shared market diagnostic repository; do not add configuration, database schema, persistence, family routes, or automatic execution.

**Tech Stack:** Node.js CommonJS, built-in HTTP server, SQLite shared diagnostic repository, browser JavaScript, HTML/CSS, `node:test`-style project harness, ESLint, TypeScript `checkJs`, Docker build CI.

---

## File map

**Runtime ownership**

- Modify `server/ifind-diagnostic-runtime.js`: create and clear one dedicated fixed-probe client/service while preserving existing diagnostic clients.
- Modify `server/tests/server-ifind-market-diagnostic.test.js`: prove disabled behavior, capability gating, unique client ownership, dependency injection, and cleanup.

**HTTP boundary**

- Modify `server/http/ifind-market-diagnostic-http.js`: add two exact administrator routes for the single proposal and copy service output without exposing provider errors.
- Modify `server/tests/http-ifind-market-diagnostic.test.js`: prove authentication, mutation protection, exact request shape, offline GET, and sanitized failures.

**Browser boundary**

- Create `public/admin-market-probe-contract.js`: own strict response validation, labels, failure classification, reset, refresh, confirmation, and one-shot run behavior.
- Modify `public/admin.html`: add the independent T11 HK card and load the new contract before `admin.js`.
- Modify `public/admin.js`: instantiate, refresh, and reset the independent controller without changing existing three-market behavior.
- Modify `public/auth.css`: style the new card by reusing existing administrator tokens and responsive grid rules.
- Create `server/tests/frontend-ifind-market-probe.test.js`: exercise the controller against hostile DTOs, duplicate clicks, stale sessions, and text-only rendering.
- Modify `server/tests/frontend-ifind-http-integration.test.js`: prove the browser controller uses only the two fixed endpoints.

**Build and suite registration**

- Modify `scripts/build.js`: include `public/admin-market-probe-contract.js` and the fixed probe runtime files in the production artifact manifest.
- Modify `server/tests/build.test.js`: assert all new runtime/browser files are copied.
- Modify `server/tests/run-tests.js`: register the new focused frontend suite.

## Fixed contract

```js
const PROPOSAL_ID = 'HK_ALIBABA_9988_V1'
const STATUS_PATH = `/api/admin/ifind/market-probes/${PROPOSAL_ID}`
const RUN_PATH = `${STATUS_PATH}/run`
```

The HTTP response body for both successful routes is exactly:

```js
Object.freeze({ data: marketProbeService.describe() })
```

For `POST`, the returned `data` is the defensive result of:

```js
await marketProbeService.run()
```

The browser accepts only the strict DTO already enforced by `copyIfindMarketProbeResult`. It never promotes any of the seven statuses and never stores the result outside controller memory.

---

### Task 1: Wire a separately owned probe service into the diagnostic runtime

**Files:**

- Modify: `server/tests/server-ifind-market-diagnostic.test.js`
- Modify: `server/ifind-diagnostic-runtime.js`

- [ ] **Step 1: Write failing runtime tests**

Add focused cases that inject `createMarketProbeService` and four distinct clients: legacy, market, report-period, and probe. The expected runtime shape is:

```js
assert.equal(runtime.marketProbeService, probeService)
assert.deepEqual(probeFactoryInput, {
  repository: marketRepository,
  client: probeClient,
  secretProvider,
  tokenVersionId: 'v20260826-001',
  clock,
  idGenerator
})
```

Also assert:

```js
assert.notEqual(probeClient, legacyClient)
assert.notEqual(probeClient, marketClient)
assert.notEqual(probeClient, reportPeriodClient)
runtime.clear()
assert.equal(probeServiceClearCalls, 1)
assert.equal(probeClientClearCalls, 0)
```

Add a separate fallback test where `probeService.clear()` throws; only then must the runtime call `probeClient.clear()` exactly once.

The disabled runtime must expose `marketProbeService: null` and must not call `createClient`, `loadSecrets`, or `createMarketProbeService`.

- [ ] **Step 2: Run the focused runtime suite and verify RED**

Run:

```bash
node -e "Promise.resolve(require('./server/tests/server-ifind-market-diagnostic.test').run()).catch(error => { console.error(error); process.exit(1) })"
```

Expected: FAIL because `marketProbeService` is absent and the probe factory is never called.

- [ ] **Step 3: Implement the minimal runtime wiring**

Import the merged service:

```js
const {
  createIfindMarketProbeService
} = require('./services/ifind-market-probe-service')
```

Extend the strict option allowlist with `createMarketProbeService`. Default it to `createIfindMarketProbeService`, create a dedicated client only when `probeFixed` is present, and reject aliasing with any existing client:

```js
const candidate = createClient()
if (candidate === legacyClient || candidate === marketClient ||
    candidate === reportPeriodClient) {
  fail('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
}
if (!readMethod(candidate, 'authenticate') ||
    !readMethod(candidate, 'probeFixed') ||
    !readMethod(candidate, 'clear')) {
  fail('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
}
probeClient = candidate
marketProbeService = createMarketProbeService({
  repository: marketRepository,
  client: probeClient,
  secretProvider: provider,
  tokenVersionId: contract.versionId,
  clock,
  idGenerator: marketIdGenerator
})
```

Validate the returned service has `describe`, `run`, and `clear`. Return it as `marketProbeService`; add `clearServiceClient(marketProbeService, probeClient)` to best-effort cleanup so direct client cleanup is only a fallback when service cleanup fails.

- [ ] **Step 4: Run the focused runtime suite and verify GREEN**

Run the command from Step 2.

Expected: PASS with no real network access and exactly one cleanup per owned resource.

- [ ] **Step 5: Commit Task 1**

```bash
git add server/ifind-diagnostic-runtime.js server/tests/server-ifind-market-diagnostic.test.js
git commit -m "feat(ifind): wire fixed probe runtime"
```

---

### Task 2: Add exact administrator HTTP routes

**Files:**

- Modify: `server/tests/http-ifind-market-diagnostic.test.js`
- Modify: `server/http/ifind-market-diagnostic-http.js`

- [ ] **Step 1: Write failing HTTP security tests**

Create a runtime stub with a probe service:

```js
const probeService = {
  describeCalls: 0,
  runCalls: 0,
  describe() {
    this.describeCalls += 1
    return fixedProbeResult
  },
  async run() {
    this.runCalls += 1
    return fixedProbeResult
  }
}
```

Assert that authenticated `GET` returns `{ data: fixedProbeResult }`, calls only `describe`, and never calls `run`. Assert authenticated `POST` succeeds only with the existing CSRF token, exact public Origin, JSON content type, and body `{}`.

Add rejection cases for:

```text
unauthenticated administrator
device Cookie in place of administrator Cookie
missing or foreign Origin
missing or invalid CSRF
non-JSON content type
empty body, array body, duplicate JSON keys, or extra object field
query string, trailing slash, encoded slash, extra path segment, or unknown proposal
GET against /run and POST against the status endpoint
```

For every rejected request, assert `describeCalls === 0` and `runCalls === 0` where applicable.

- [ ] **Step 2: Run the HTTP suite and verify RED**

Run:

```bash
node -e "Promise.resolve(require('./server/tests/http-ifind-market-diagnostic.test').run()).catch(error => { console.error(error); process.exit(1) })"
```

Expected: FAIL with the fixed probe endpoint returning not found.

- [ ] **Step 3: Implement the exact routes**

Add constants inside the HTTP module:

```js
const FIXED_PROBE_ID = 'HK_ALIBABA_9988_V1'
const FIXED_PROBE_PATH = `/api/admin/ifind/market-probes/${FIXED_PROBE_ID}`
const FIXED_PROBE_RUN_PATH = `${FIXED_PROBE_PATH}/run`
```

Route before the generic `market-cases` branch. For status:

```js
requireExactTarget(req, FIXED_PROBE_PATH)
authenticateAdmin(req, res)
const service = requiredProbeService(ifindDiagnosticRuntime)
writeJson(res, 200, { data: service.describe() })
```

For execution:

```js
requireExactTarget(req, FIXED_PROBE_RUN_PATH)
authenticateMutation(req, res)
requireJsonMutation(req)
await requireExactEmptyJsonBody(req)
const service = requiredProbeService(ifindDiagnosticRuntime)
writeJson(res, 200, { data: await service.run() })
```

Use the module's existing strict property/method readers and boundary-error sanitizer. Map any probe service exception to one stable public code, `IFIND_MARKET_PROBE_FAILED`, without copying its message, stack, cause, RequestId, or arbitrary properties.

- [ ] **Step 4: Run the HTTP suite and verify GREEN**

Run the command from Step 2.

Expected: PASS; test counters prove GET is offline and rejected POST requests never reach the service.

- [ ] **Step 5: Commit Task 2**

```bash
git add server/http/ifind-market-diagnostic-http.js server/tests/http-ifind-market-diagnostic.test.js
git commit -m "feat(admin): expose fixed HK probe boundary"
```

---

### Task 3: Add a separate browser controller and card

**Files:**

- Create: `public/admin-market-probe-contract.js`
- Create: `server/tests/frontend-ifind-market-probe.test.js`
- Modify: `public/admin.html`
- Modify: `public/admin.js`
- Modify: `public/auth.css`
- Modify: `server/tests/frontend-ifind-http-integration.test.js`
- Modify: `server/tests/run-tests.js`

- [ ] **Step 1: Write failing browser contract tests**

Define the expected global module:

```js
window.KinvestAdminMarketProbe = Object.freeze({
  createController,
  apiFailure,
  errorMessage
})
```

The controller interface is:

```js
const controller = createController({
  document,
  sessionLifecycle,
  request,
  dateText,
  confirm,
  setLive,
  onError
})
controller.bind()
await controller.refresh()
controller.reset()
```

Tests must assert that `refresh()` performs one GET to the fixed status path, never POSTs, and renders all values with `textContent`. Clicking Run must show a confirmation containing `1 次认证 + 3 次业务请求` and `0 次重试`; accepting sends exactly one protected POST and then one GET. A second click while the first request is pending must send nothing.

Reject DTOs containing proxies, accessors, extra keys, unknown statuses, non-null verified claims, unsafe text, or any of these forbidden keys:

```text
refreshToken
accessToken
RequestId
rawResponse
```

Assert reset and stale-session completion cannot repaint old data and that no code path accesses `localStorage`, `sessionStorage`, or `innerHTML`.

- [ ] **Step 2: Run the frontend suite and verify RED**

After registering the new test in `server/tests/run-tests.js`, run:

```bash
node -e "Promise.resolve(require('./server/tests/frontend-ifind-market-probe.test').run()).catch(error => { console.error(error); process.exit(1) })"
```

Expected: FAIL because `public/admin-market-probe-contract.js` does not exist.

- [ ] **Step 3: Implement the strict controller**

Create a small IIFE module. Freeze fixed paths and require the exact proposal:

```js
const PROPOSAL_ID = 'HK_ALIBABA_9988_V1'
const STATUS_PATH = `/api/admin/ifind/market-probes/${PROPOSAL_ID}`
const RUN_PATH = `${STATUS_PATH}/run`
```

`refresh()` calls only `request(STATUS_PATH)`. The run listener checks a local `running` flag, confirms the fixed cost, then calls:

```js
request(RUN_PATH, {
  method: 'POST',
  body: {},
  csrf: true,
  signal: ticket.signal
})
```

Validate the response through a strict local copy function before rendering. Render missing observations as `—`, safe stable errors as Chinese labels, and each verification field as `未验证`. Do not derive currency, unit, issuer, code, scope, or period from fixed request parameters.

- [ ] **Step 4: Add the card and lifecycle integration**

Load the module before `admin.js`:

```html
<script src="/admin-market-probe-contract.js" defer></script>
```

Add a separate card headed `T11 港股模板验证`, containing fixed labels for Alibaba `9988.HK`, proposal ID, Mock boundary, costs, last attempt, request counts, three observations, seven `未验证` fields, conservative `ready/cooldown/limit` status text, and a disabled Run button. Do not invent an exact remaining quota because the #70 DTO does not expose one.

In `public/admin.js`, create a no-op fallback when the module is missing, then include the controller in `bind`, `refreshLists`, and `clearAdminSensitiveState`:

```js
const ifindMarketProbeController = marketProbeContracts
  ? marketProbeContracts.createController({
      document, sessionLifecycle, request: api, dateText,
      confirm: message => window.confirm(message), setLive,
      onError: handleError
    })
  : { bind() {}, refresh() {}, reset() {} }
```

Update `api()` failure dispatch so only `/api/admin/ifind/market-probes/` uses `marketProbeContracts.apiFailure`.

Use existing CSS variables and panel/card breakpoints. Add no new font, color system, animation library, or general layout redesign.

- [ ] **Step 5: Run focused frontend tests and verify GREEN**

Run:

```bash
node -e "Promise.resolve(require('./server/tests/frontend-ifind-market-probe.test').run()).catch(error => { console.error(error); process.exit(1) })"
node -e "Promise.resolve(require('./server/tests/frontend-ifind-http-integration.test').run()).catch(error => { console.error(error); process.exit(1) })"
```

Expected: PASS; request history contains only the fixed GET/POST paths and one run per accepted confirmation.

- [ ] **Step 6: Commit Task 3**

```bash
git add public/admin-market-probe-contract.js public/admin.html public/admin.js public/auth.css server/tests/frontend-ifind-market-probe.test.js server/tests/frontend-ifind-http-integration.test.js server/tests/run-tests.js
git commit -m "feat(admin): add HK probe verification card"
```

---

### Task 4: Complete build coverage, visual QA, and PR verification

**Files:**

- Modify: `scripts/build.js`
- Modify: `server/tests/build.test.js`
- Verify: all files changed in Tasks 1-3

- [ ] **Step 1: Write the failing build-artifact assertions**

Require the production artifact to contain:

```text
server/domain/ifind-market-probe-proposals.js
server/domain/ifind-market-probe-result.js
server/services/ifind-market-probe-service.js
public/admin-market-probe-contract.js
```

Run:

```bash
node -e "Promise.resolve(require('./server/tests/build.test').run()).catch(error => { console.error(error); process.exit(1) })"
```

Expected: FAIL because the new browser contract is not yet in the build manifest.

- [ ] **Step 2: Add the exact build manifest entries**

Add only the four files above to the appropriate server/public arrays in `scripts/build.js`. Do not add tests, fixtures, `.env`, tmpfs material, or development dependencies.

- [ ] **Step 3: Run focused build and artifact tests**

Run:

```bash
npm run build
node -e "Promise.resolve(require('./server/tests/build.test').run()).catch(error => { console.error(error); process.exit(1) })"
```

Expected: PASS and no runtime `require()` failure for the fixed probe service or browser module.

- [ ] **Step 4: Perform desktop and mobile visual QA**

Open the built `public/admin.html` through the existing local browser harness. Inspect at one desktop width and one mobile width. Confirm:

```text
the new card is visually separate from the old three-market panel
the Mock/admin-only boundary is visible without scrolling inside the card
the fixed cost and disabled/default state are readable
the card does not overflow horizontally
existing login, device, calibration, and report-period panels remain aligned
```

Save only non-secret screenshots if the repository's existing visual evidence convention requires them; otherwise record the viewport sizes and result in the PR description.

- [ ] **Step 5: Run the complete verification command**

Run:

```bash
npm run check
```

Expected: build succeeds, all tests pass, ESLint reports no errors, and `tsc -p jsconfig.json` exits zero. Linux-only deployment tests may report their existing explicit macOS skips.

- [ ] **Step 6: Review and scan the final diff**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Scan every changed file for actual token values, API keys, refresh tokens, private keys, `.env` references containing values, RequestId samples, and raw provider payloads. Test sentinel names are allowed only when visibly synthetic and non-secret.

- [ ] **Step 7: Commit build coverage**

```bash
git add scripts/build.js server/tests/build.test.js
git commit -m "build: package HK probe admin entry"
```

- [ ] **Step 8: Request two-stage review**

Use `superpowers:requesting-code-review` for specification compliance and code quality. Resolve only confirmed findings through a new RED-GREEN cycle; do not silently broaden scope.

- [ ] **Step 9: Push and open the PR**

Push the feature branch and create a PR targeting `main`. The PR description must state:

```text
no real iFinD call
no production deployment
no family data publication
no verification promotion
no SQLite schema or secret/config change
```

Wait for unique `verify`, `security`, and `container-build` checks. The user performs the merge manually.

---

## Post-merge gates outside this implementation plan

Do not cross these gates while implementing the code PR:

1. Preparing or importing a production image requires separate approval.
2. Installing server assets or changing the running container requires separate approval.
3. Enabling a deploy gate and approving Production deployment require separate approval.
4. Logging in as administrator and confirming the new card is a separate user action.
5. Executing `HK_ALIBABA_9988_V1` against real iFinD requires a new, explicit approval for that single run.
6. Any status promotion, evidence persistence, family visibility, US/CN template work, or automatic calling requires a later plan and PR.

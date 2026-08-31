# Fixed Report-Period Diagnostic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved administrator-only three-indicator diagnostic without executing a real query or deploying.

**Architecture:** Keep the single-indicator calibration unchanged. Add a fixed request, strict server/browser DTO, shared-ledger service, authenticated routes and a separate administrator panel. Date observations remain unlinked to revenue and never promote verification.

**Tech Stack:** Existing CommonJS Node.js, SQLite, vanilla browser JavaScript and the existing offline test runner. No new dependency.

---

## Authority and work split

The user approved the written design on 2026-08-31. Work only in
`/Users/zhuwenpeng/Developer/Kinvest/.worktrees/ifind-report-period-diagnostic`.
No live iFinD requests, production access, deployment, secrets or main-branch writes.
Backend implementer owns server runtime/transport/HTTP and its new focused tests.
Parent owns public files, frontend tests, build allowlists, runner and docs.
Reviewers make no edits. Report implementation defects before any corrective
patch, following the workspace's one-implementation-phase requirement.

## Frozen cross-component contract

```js
const diagnosticId = 'HK_ALIBABA_REPORT_PERIOD_20260331_SINGLE_QUARTER_V1'
const indicators = [
  { indicator: 'revenue_oas', parameters: ['20260331', '1', 'BB'] },
  { indicator: 'report_sd', parameters: ['20260331', '1'] },
  { indicator: 'report_ed', parameters: ['20260331', '1'] }
]
const initial = {
  diagnosticId, caseId: 'HK_ALIBABA_9988', displayCode: '9988.HK',
  requestedSelector: '20260331', indicators, status: 'ready',
  verification: {
    issuerIdentityStatus: 'unverified', vendorCodeStatus: 'unverified',
    entitlementStatus: 'unverified', currencyStatus: 'unverified',
    unitStatus: 'unverified', reportPeriodStatus: 'unverified',
    scopeStatus: 'unverified'
  },
  observation: null, requestCount: 0, businessRequestCount: 0,
  dataVol: null, attemptedAt: null, errorCode: null
}
const observation = {
  returnedCode: '9988.HK',
  revenue: { value: 247652000000, availability: 'present' },
  dateEvidence: {
    requestedDataType: 'single-quarter', start: '2025-04-01', end: '2025-06-30',
    availability: 'present', revenuePeriodLink: 'unverified'
  }
}
```

Allowed statuses: `ready`, `busy`, `cooldown`, `daily-limit`,
`observed-unverified`, `failed`, `unavailable`.
Error codes are respectively null for the four idle statuses,
`IFIND_REPORT_PERIOD_DIAGNOSTIC_OBSERVED_UNVERIFIED`,
`IFIND_REPORT_PERIOD_DIAGNOSTIC_FAILED`,
`IFIND_REPORT_PERIOD_DIAGNOSTIC_UNAVAILABLE`.
Request count is 0..2; business count is exactly 1 iff total count is 2.
Date availability is `present` for two dates, `partial` for one, `missing`
for neither. Revenue availability is `present` for a finite number, otherwise
`missing` with null. Only observed-unverified can carry an observation and it
requires two attempted requests and a canonical UTC attempted timestamp.
All structural keys are exact. No actual revenue period or verified claim is
accepted. Missing date fields are not zero or inferred from the selector.

## Task 1: Backend fixed contract and guarded execution

Files: create `server/domain/ifind-report-period-diagnostic.js`,
`server/services/ifind-report-period-diagnostic-service.js`,
`server/tests/ifind-report-period-diagnostic.test.js`,
`server/tests/ifind-report-period-diagnostic-integration.test.js`.
Modify `server/adapters/ifind-http-client.js`,
`server/ifind-diagnostic-runtime.js`,
`server/http/ifind-market-diagnostic-http.js`.

- [ ] Read each required existing file once and identify exact integration edits.
- [ ] Add focused tests and demonstrate RED with offline fake transport and temporary SQLite.
- [ ] Export `REPORT_PERIOD_DIAGNOSTIC_ID`, `REPORT_PERIOD_DIAGNOSTIC_REQUEST`,
  `createInitialReportPeriodDiagnosticResult`, `copyReportPeriodDiagnosticResult`
  and `parseReportPeriodDiagnosticObservation` from the domain module.
- [ ] Add `client.diagnoseReportPeriod(accessToken)` sending only the design's
  frozen `codes/indipara` body to existing `basic_data_service`.
- [ ] Add `createIfindReportPeriodDiagnosticService` with `describe/run/clear`.
  Reserve the existing Alibaba ledger before secrets; count before awaiting;
  never retry; settle as unverified, never write financial points. Protect
  client cleanup ownership and late results. Expose `runtime.reportPeriodService`.
- [ ] Add exact GET `/api/admin/ifind/report-period-diagnostic` and POST suffix
  `/run`, reusing administrator session, CSRF, Origin, proxy and empty-body gates.
- [ ] Run both new suites and relevant original calibration/runtime/HTTP suites.

Focused offline command:

```sh
node -e "(async()=>{await require('./server/tests/ifind-report-period-diagnostic.test').run();await require('./server/tests/ifind-report-period-diagnostic-integration.test').run()})().catch(e=>{console.error(e);process.exitCode=1})"
```

Expected: missing module/export assertion in RED, exit 0 with all cases in GREEN.
Cover wrong codes, dates, shapes, extra fields, accessors/proxies, shared quota,
lease expiry, settlement failure, buffer clearing, exact body, no retries and
all unauthorized HTTP paths. A same-calendar-end quarter and cumulative report
cannot become equivalent. No expected data may come from a live query.

## Task 2: Browser contract, panel and lifecycle

Files: create `public/admin-report-period-contract.js`,
`server/tests/frontend-ifind-report-period-diagnostic.test.js`.
Modify `public/admin.html`, `public/admin.js`.

- [ ] Add failing strict DTO and controller tests before browser implementation.
- [ ] Expose `window.KinvestReportPeriod` and CommonJS exports with
  `copyResult`, `apiFailure`, `errorMessage`, `createController`.
- [ ] The controller accepts `document`, `sessionLifecycle`, `request`,
  `dateText`, `confirm`, `setLive`, `onError`; exposes `bind/refresh/reset`.
- [ ] Render a separate existing-style panel showing the three parameter lists,
  raw revenue, date-indicator start/end, missing status, request counts and
  all-unverified evidence. Never display date fields as verified revenue dates.
- [ ] Integrate GET-only refresh and lifecycle reset; only explicit confirmed
  button action may POST `{}` with CSRF. No polling or automatic retry.
- [ ] Validate exact DTO keys, canonical timestamps/dates, finite numbers,
  correct availability and permanently unverified states before text rendering.
- [ ] Test cancellation, double-click, malformed result, session expiry,
  stale completion, missing data and no local storage or raw HTML rendering.

```sh
node -e "require('./server/tests/frontend-ifind-report-period-diagnostic.test').run().catch(e=>{console.error(e);process.exitCode=1})"
```

Expected: missing browser module assertion in RED, exit 0 in GREEN.

## Task 3: Runtime artifacts and operational record

Files: modify `scripts/build.js`, `server/tests/build.test.js`,
`server/tests/run-tests.js`; create
`docs/operations/ifind-report-period-diagnostic.md`.

- [ ] Add new server/browser runtime files to both explicit build allowlists.
- [ ] Register all three focused suites in the test runner.
- [ ] Fresh-process runtime loading must reach the new modules; HTML references
  must resolve in dist, and existing container runtime smoke remains applicable.
- [ ] Document fixed body, status meanings, unknown quota, no-retry behavior and
  separate merge/import/deployment/live-call approval gates.

## Task 4: Offline verification and PR

- [ ] Run `npm run check`; report exact evidence rather than assuming success.
- [ ] Run local desktop/mobile fixture UI checks and offline container build.
- [ ] Obtain spec-compliance review, then code-quality review; reviewers do not
  approve production or substitute for the user's manual merge.
- [ ] Check final diff and sensitive-file/value boundaries; stage only owned
  files and commit small coherent changes.
- [ ] Push only `feat/ifind-report-period-diagnostic`, create a PR to `main`,
  and observe `verify`, `security`, `container-build`. Never merge automatically.

```sh
npm run check
git diff --check
git push -u origin feat/ifind-report-period-diagnostic
```

Any code defect discovered after the implementation phase pauses correction for
user approval. Environmental test blockers are reported without claiming code
failure or silently reducing the acceptance criteria.

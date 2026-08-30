# iFinD Report-Period Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Preserve the original dirty main worktree. The user approved this narrow implementation after reviewing the period-evidence findings.

**Goal:** Prevent the fixed Alibaba calibration from treating request syntax or a numerical disclosure match as a verified actual reporting period.

**Architecture:** A focused domain contract owns curated public-disclosure comparisons and fail-closed period decisions. The existing calibration service and strict DTO use that contract; the administrator panel separates request selector, actual period and comparison evidence. No provider query, schema change or production change is needed.

**Tech Stack:** Existing CommonJS JavaScript, Node.js assertions, SQLite integration fixtures, static administrator HTML and JavaScript.

## Scope and evidence

The evidence record is `docs/operations/ifind-report-period-evidence.md`.
The exact wire request remains `9988.HK / revenue_oas / 20260331,1,BB`.
Do not infer that `1` means Q1 or `BB` means CNY. Do not promote any of the
seven verification dimensions, activate a full-market live manifest, introduce
automatic retries, or persist a raw provider payload.

## Task 1: Backend evidence and period guard

Files: a focused new module under `server/domain/`, its focused test under
`server/tests/`, `server/domain/ifind-calibration.js`,
`server/services/ifind-calibration-service.js`, existing calibration unit and
integration tests, and the build/test allowlists if a new module requires them.

- Add failing fixtures for raw-selector/actual-period separation, numerical
  match without promotion, unknown evidence, differing known periods, and a
  quarter versus fiscal year sharing an end date.
- Add curated source IDs, URLs, publication dates, disclosed periods and units.
  Source evidence is application-owned, not accepted from the vendor or browser.
- Wire the guard into the existing service/DTO path. Unknown remains unverified;
  contradictory known claims cannot leave the boundary as financial evidence.
- Exercise the runtime-to-HTTP path with the existing fake transport and quota
  repository. Preserve the one-authentication/one-business-request ceiling.
- Register any new module in `scripts/build.js` and `server/tests/run-tests.js`;
  include fresh-process production-artifact import coverage.

## Task 2: Administrator presentation

Files: `public/admin-contract.js`, `public/admin.html`, and
`server/tests/frontend-ifind-calibration.test.js`.

- Extend fixtures before implementation. Missing or tampered period evidence
  must make the view unavailable rather than display an inferred period.
- Display the raw request selector separately from the unknown actual period.
- Present the three official disclosure comparisons with their period basis,
  publication dates and sources. Explicitly label a number match as comparison
  only; disclosure currency/units must not become observation metadata.
- Use existing layout classes and text-node rendering. Keep deliberate per-call
  confirmation, no automatic requests, and session invalidation behavior.

## Task 3: Documentation, acceptance and PR

Files: this plan, `docs/operations/ifind-report-period-evidence.md`, and dated
follow-ups in the existing calibration and three-market evidence documents.

Commands from the isolated worktree:

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: zero test failures and successful type/lint/build exit codes. Run
focused RED/GREEN tests before the full suite. Review the change for spec
compliance, then code quality. An agent review is auxiliary, not human approval.
Inspect the final diff for unintended scope and secret material before creating
a feature-branch PR. Required GitHub checks are `verify`, `security` and
`container-build`; user merges manually.

Local browser acceptance uses fixtures only, not a logged-in production session
or a live iFinD call. Check desktop/mobile evidence presentation and unchanged
confirmation behavior. Report any unavailable validation explicitly.

## External gates remain closed

No server access, image download, Registry operation, production deployment,
GitHub Environment change or paid/live data call is included. All existing
deployment switches and household Mock data remain unchanged by this task.

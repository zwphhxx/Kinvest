# R1 three-market diagnostics: verification in progress

Recorded: 2026-08-30. This is an incomplete acceptance record, not a release
approval or a claim that R1 is ready to merge.

## Baseline and scope

- Worktree: `Kinvest/.worktrees/ifind-three-market-r1-diagnostics`.
- Branch: `feat/ifind-three-market-r1-diagnostics`.
- Approved plan baseline: `3ea078b` (PR #58).
- Latest verified implementation/type-fix commit: `bb3dc52`.
- Original dirty main workspace remains untouched.
- No production deployment, production database change, real iFinD call,
  registry push, secret creation, or cloud permission change occurred.
- Production indicator evidence remains unverified and fail-closed.

## Completed checks

| Check | Observed result |
| --- | --- |
| `npm run typecheck` | Exit 0 after `bb3dc52` |
| `npm run lint` | Exit 0 after `bb3dc52` |
| `npm run build` | Exit 0 after `bb3dc52` |
| Focused `server-ifind-bootstrap.test` | Exit 0 after updating the incomplete service fixture |
| Focused `access-preflight.test` | Exit 0 after updating the incomplete client fixture |
| `ifind-three-market-admin-docs.test` | Exit 0 |
| `deploy-v5-ifind-docs.test` | Exit 0 |
| `docker build --platform linux/amd64 -t kinvest:r1-local .` | Exit 0 |
| `scripts/docker-access-preflight-runtime-smoke.sh kinvest:r1-local` | Exit 0; `KINVEST_ACCESS_PREFLIGHT_RUNTIME_SMOKE_OK` |
| `npm audit --audit-level=high` | Exit 0; two moderate findings remain in the retained Tencent SDK / uuid dependency chain |
| Commit-range common secret/private-key pattern scan | No matches in added lines; no forbidden paths; no workflow files changed |

The initial full test run encountered sandbox listener restrictions and was
stopped. The escalated full run started before the fixture repair was committed;
it reported those two fixture failures. Their independent post-fix reruns passed.
That old full run cannot establish that the final branch is all-green. A fresh
complete run is still required after all accepted repairs.

The macOS full run explicitly skips the Linux tmpfs crash integration and Linux
sudoers integration. Container build/runtime smoke results do not substitute for
the GitHub Linux CI checks. No implementation PR has been created yet.

## Browser evidence

See [fixture QA report](r1-browser-fixture-qa.md) for exact interactions,
asset hashes, synthetic responses, viewport sizes, screenshots, limitations,
and fixture-server teardown.

- Desktop: 1440 x 1000 CSS pixels.
- Mobile viewport: 390 x 844 CSS pixels.
- Separate case actions, cooldown recovery, quota/error states, text-only
  rendering, and narrow layouts were exercised with synthetic responses.
- No observed console error in the recorded checkpoints.
- This is not real authentication E2E or evidence of provider integration.

## Open integration findings

Independent review requested changes. The controller/consumer mismatches below
were spot-checked by the primary agent. None is waived by green focused tests.

1. HTTP emits runtime status `available`, while the UI expects
   `admin-diagnostic`; genuine HTTP DTOs must drive frontend contract tests.
2. Numeric vendor error codes from the client/repository are rejected as
   non-string values by HTTP projection. Keep safe integer/null metadata
   internal; do not expose raw provider errors.
3. HTTP compares financial reporting currency to trading currency. Preserve
   issuer-verified reporting currency independently of quote currency.
4. A rejected/busy invocation unconditionally clears the shared market client,
   potentially invalidating the owning invocation. Cleanup must follow execution
   ownership, with overlapping real-client fixture coverage.
5. The default manifest factory returns a bare manifest, while the service
   expects an evidence bundle. Production factory/parser wiring must agree;
   test-only mappings must not become a live configuration path.
6. Parsers produce `suspended`, while downstream contracts accept `halted`.
   Use one canonical internal state through parser, service, storage, and HTTP.
7. The runbook says latest periods are ordered by disclosure time; the parser
   selects by report-period end after disclosure/time validity checks. Correct
   the wording without silently changing the approved period-selection logic.

Browser QA separately found:

- Financial currency is not displayed separately from quote currency.
- Partial and failed runs share a generic completion message.
- A successful restored admin session leaves a stale checking-session message.

The user approved repairing the above findings and adding cross-component tests.
The documentation correction was committed as `49bc22e`; the frontend repairs
were committed as `3bacd49` and passed focused tests and independent review.
The new frontend integration test consumes the real HTTP controller's serialized
DTO rather than inventing a runtime-status response.

Backend ownership, evidence-bundle/parser mapping, and canonical halted-state
repairs are implemented but not committed. Five existing focused suites and the
new repository integration checks passed, but HTTP integration is not yet green.
The new tests are registered in the full suite.

Additional correction approval was requested after validation caught these
implementation/test mistakes:

- The primary-agent currency patch matched the quote validator instead of the
  financial validator. Restore the quote's exact trading-currency check and apply
  the independent reporting-currency check to the correct financial function.
  This edit is uncommitted and not deployed.
- The backend integration response fixture needs a success/error union type.
- Its real HTTP handler fixture needs the required `deviceApproval` dependency.

No merge-ready PR or completed-acceptance claim is made while these corrections
and the final green test run remain outstanding.

## Remaining gates

1. Obtain approval for the three newly identified correction points above and
   complete the genuine cross-component regression tests.
2. Re-review those repairs and repeat affected browser checks.
3. Run the full automated suite, typecheck, lint, build, container smoke, and
   final commit-range sensitive-data scan on the final code.
4. Record exact final results, push the feature branch, and create the PR.
5. Require unique green `verify`, `security`, and `container-build` checks and
   user manual merge. Production and each real case call remain separate gates.

## 2026-08-30 approved correction checkpoint

The user approved correcting the HTTP currency patch location and the two new
integration-fixture wiring errors. Those three corrections are now applied.
No production changes, image push, or live iFinD requests were performed.

Passed in this checkpoint:

- HTTP diagnostic regression suite, including internal numeric provider codes
  and HKD quote / CNY financial projection.
- Frontend real-HTTP-contract integration and the admin runbook documentation suite.
- Five backend focused suites and repository-chain checks (implementer report).
- Type checking and lint (implementer report); local application build.
- Local linux/amd64 image build and access-preflight runtime smoke.
- Previously recorded repaired desktop/mobile fixture QA remains applicable.

The full npm test run is still in progress at this checkpoint. Its new service
integration suite fails with CLIENT_IDENTITY_INVALID because the fixture request
omits X-Forwarded-For. Do not interpret other passing suites as a full-suite pass.

The independent review requests changes for two further issues:

- The new integration fixture incorrectly expects internal vendorErrorCode in
  the HTTP response; storage must retain it while HTTP must omit it.
- Manifest/client, repository, and HTTP disagree on vendor indicator ID case and
  maximum length. The contract must be unified without changing provider ID case,
  and unsupported IDs must be rejected before consuming request quota.

The missing proxy-header fixture correction and these two further changes have
been submitted for explicit user approval. No additional correction has yet been
made, and this branch is not ready for PR completion or merge.

## 2026-08-30 final-source and packaging checkpoint

This checkpoint supersedes the earlier pending-fix entries. The user approved
all three integration corrections and the subsequent runtime packaging fix.

Implemented and independently reviewed:

- The fixture supplies matching single-IP X-Real-IP and X-Forwarded-For headers.
- Negative provider error codes remain internal; HTTP omits provider codes and IDs.
- Manifest, client, repository, and HTTP share the indicator ID contract:
  1-80 ASCII letters, digits, or underscore; original case is preserved. Security
  codes use their separate contract. SQL limits and schema are unchanged.
- Invalid declarations/templates are rejected before reservation, secret reads,
  or transport. This supported syntax is not a claim about all iFinD indicators.
- The shared validator is included in the explicit runtime build allowlist.
- A fresh Node process loads the built helper and application from dist, avoiding
  require-cache effects. The final Docker runtime stage also loads both modules.

Passed on the final source:

- Eight focused backend/HTTP/frontend integration suites, including legal case
  variants and length boundaries, invalid-ID early rejection, independent quote
  and reporting currencies, halted quotes, and internal-only error codes.
- The build artifact regression, type checking, lint, and application build.
- Local linux/amd64 Docker build: KINVEST_IMAGE_RUNTIME_LOAD_OK.
- Local complete access-preflight runtime smoke:
  KINVEST_ACCESS_PREFLIGHT_RUNTIME_SMOKE_OK.
- Incremental independent reviews: approved; not an external security audit.
- Repaired desktop/mobile fixture QA remains in the linked evidence files; no UI
  changes were made during the final indicator/build corrections.

The full local run started before the packaging correction remains in progress
at this checkpoint. It recorded the now-corrected missing-helper build failure;
that historic nonzero result must not be described as a green final run. The
focused corrected build/runtime checks above passed. A draft PR will run the
complete Linux CI against the final commit. Merge readiness still requires
verify, security, and container-build to pass.

All data and credentials used by these tests are synthetic fixtures. No live
market query, production change, registry image push, or secret update occurred.

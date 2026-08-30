# Local report-period presentation acceptance

Review date: 2026-08-30. These images contain local fixture data, not a new
production observation or a captured authenticated production session.

## Captures

- `desktop.png`: the report-period decision and three public-disclosure comparisons in the existing desktop administrator layout.
- `mobile-390px.png`: the raw request selector remains separate from the unknown actual period at a 390px iframe viewport.
- `mobile-evidence-390px.png`: the same viewport scrolled to the three disclosures, comparison-only warnings, source links and manual run button.

The fixture served the actual `public/admin.html`, `admin-contract.js`,
`admin.js` and styles on localhost. It returned inert administrator list and
calibration responses. Only the mock CSRF restoration POST was accepted; all
business POSTs were rejected. No provider request, production authentication,
source-link navigation or secret access was performed. The temporary fixture
server was stopped after capture.

## Observed behavior

- Request selector `20260331` is explicitly not a verified actual period.
- Actual period, currency, unit, period type and scope remain unknown.
- All seven verification dimensions remain unverified.
- The June 2025 numerical match is comparison-only, not an automatic metadata assignment.
- Quarter and fiscal-year disclosures sharing the March 2026 end date are separately identified.
- The disclosure list, warnings and button remain readable in the narrow viewport.
- Rendering evidence did not run calibration, retry a request or fetch a disclosure source.

The 390px check exercises responsive layout in a desktop browser iframe, not a
physical phone or mobile Safari. Browser-console logs were not independently
collected. These captures do not replace HTTP authorization or quota tests.

## Automated checks and known dependency risk

Typecheck, lint, build and the tracked-file sensitive-pattern scan passed.
The frontend suite passed all 15 tests. Full regression status is recorded
separately in the PR and its required checks, not inferred from these images.

`npm audit --audit-level=high` exited successfully with no high-severity issue,
but reported two existing moderate package findings involving `uuid` and its
Tencent common-SDK dependency path (GHSA-w5hq-g745-h8pq). Dependencies and the
lockfile are unchanged by this PR. No forced audit fix or SDK downgrade was
performed; resolving that dependency risk needs a separately scoped change.

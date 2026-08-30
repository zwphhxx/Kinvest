# R1 Task 11: local browser fixture QA

Date: 2026-08-30. Browser exercise: approximately 02:53-02:58 UTC.

## Verdict and boundary

Local fixture UI exercise completed, with three presentation findings below.
This is NOT real authentication E2E, a production acceptance, an iFinD API
integration test, or approval to release. No real credentials, cookies, database,
production site, or real iFinD endpoints were accessed.

Only a disposable HTTP harness and this report/screenshots were created. No
production code, tests, README, runner, Git state, or another agent's files were
modified. No commit was made.

## Findings

### P2: financial currency is not distinguished from quote currency

The HK fixture supplies quote.currency=HKD and financial[].currency=CNY.
The visible HK card shows only HKD under its currency field, adjacent to the
financial unit and report-period fields. CNY is absent from the card. This is
an observable display omission, not a claim that the backend changed currency.
If actual data uses distinct trading and reporting currencies, administrators
cannot identify the financial reporting currency from this UI.

Suggested follow-up: display separate trading and financial currencies, keeping
financial unit/scope/period associated with each financial block. Relevant UI:
public/admin-contract.js, createIfindMarketCardView, and public/admin.html.
No fix was applied.

### P3: partial and failed runs share the same generic completion alert

The US POST returns status=partial and the CN POST returns status=failed with
safeErrorClass=NETWORK. Both show the same generic safe-result-recorded alert.
The card does retain missing fields or the safe network error, but there is no
explicit persistent partial/failed run-status label. Complete uses a distinct
completion message.

Suggested follow-up: preserve a distinct complete/partial/failed summary while
retaining safe per-card error detail. Relevant UI: public/admin-contract.js.
No fix was applied.

### P3: initial session-check message remains after the desk is ready

On fixture session restoration, the complete administration desk and all three
cards render, but the bottom live region still says that the administrator
session is being checked. A later action replaces it. Explicit fixture login
correctly changes the message to session established.

Suggested follow-up: clear or replace the pending message after successful
bootstrap. Relevant UI: public/admin.js, bootstrap/showDesk/setLive.
No fix was applied.

## Harness and isolation

- Harness: /tmp/kinvest-r1-fixture-qa/server.cjs.
- Bound only to 127.0.0.1, dynamically selected port 59548 for this run.
- Browser entry: http://127.0.0.1:59548/admin.
- Current public assets were served, cached on first request, without a build.
- A fixture-only banner and scenario buttons were injected into the HTML response;
  source HTML was not changed.
- CSP restricted resources/connections/forms to self, with local inline styles
  for the fixture banner. The server contains no outbound API transport.
- API responses are synthetic. CSRF/login responses are simulated; no Set-Cookie
  is issued, and browser cookie/session stores were not inspected.
- Company values, prices, financial points, quotas, names, and times are fixture
  data, not assertions about the companies or current market conditions.
- HK, US, CN input order was deliberately CN/HK/US; the UI must reorder it.
- Live-ready is simulated solely in the harness, not changed in the real catalog.
- Runs take two seconds; post-run cooldown is ten seconds for bounded UI testing,
  not the production five-minute interval.
- Requests are recorded as method/path/scenario only; the fixture-run marker
  additionally confirms the submitted body was exactly an empty JSON object.
- The server caches static resources so concurrent documentation/type work does
  not replace already-loaded assets during this exercise.

## Exact browser flow and results

| Step | Action | Observation |
| --- | --- | --- |
| 1 | Open /admin at 1440 x 1000 with ready fixtures | Restored simulated administrator desk; legacy diagnostic, device, revoke, audit areas remain present. Both administrator-only and family-Mock notices are visible. |
| 2 | Inspect three cards | Visual/DOM order HK Alibaba, US Apple, CN Moutai despite shuffled API order. Three equal-width columns, about 319 CSS px each. |
| 3 | Click HK run | Only HK run POST; all three buttons disabled while pending. HK says running; other cards say wait. Completion message, case remaining 4/5 and global 11/12, followed by cooldown. |
| 4 | Click US run | Only US POST; partial result, gross_profit missing for all three fixture periods, no mock value substitution. Case/global counters refresh. |
| 5 | Click CN run | Only CN POST; failed result, no quote, no financial block, safe network message. No raw provider error shown. |
| 6 | Observe cooldown expiration | Browser automatically rereads list and restores buttons without page reload. Recorded expiry GETs include 02:54:25.319, 02:54:33.899, and 02:55:04.835 UTC. |
| 7 | Switch disabled fixture | Three buttons disabled with not-enabled labels; header/note identify disabled state. |
| 8 | Switch unavailable fixture | Three buttons disabled with status-unavailable labels, distinct from disabled. |
| 9 | Switch quota fixture | Zero case remaining prevents all runs and shows daily limit reached. |
| 10 | Switch unverified fixture | liveReady=false prevents all runs and shows indicators not verified. |
| 11 | Switch api-error, click HK | Synthetic HTTP 429 IFIND_MARKET_CASE_DAILY_LIMIT displays the precise case-daily-limit message, not a generic unknown error. |
| 12 | Switch hostile fixture | Company/device names containing img/onerror markup display literally. DOM contains zero img[src=x] nodes and zero onerror attributes; no JavaScript dialog appeared. |
| 13 | Return ready; set 390 x 844 | Three cards become one column in HK/US/CN order. Card width 301 CSS px, x=37; document scrollWidth=375, less than viewport width 390. No horizontal overflow. |
| 14 | Capture each mobile card | Long timestamps and missing-field text wrap inside the card; action buttons remain accessible. |
| 15 | Run HK, US, CN individually on mobile | Each POST occurs independently with an empty object; pending/cooldown/results and counters update. No run-all control or arbitrary indicator/code input exists. |
| 16 | Click administrator logout | Desk disappears and login form is shown; successful fixture logout message. |
| 17 | Type a dummy, non-secret fixture password and log in | Simulated login returns to desk and sets the successful-login message. No real verifier, cookie, or password validation is exercised. |
| 18 | Switch expired fixture | Market-list response 401 ADMIN_AUTH_REQUIRED returns to login, hides administrator data, and displays session-ended message. |
| 19 | Inspect browser developer logs | Error/warning queries returned empty arrays at baseline, run/error, logout, expiration, and final checkpoints. No observed uncaught browser error. |

Seven total synthetic market-run POSTs were observed: desktop HK/US/CN, one
HK 429 scenario, and mobile HK/US/CN. Every recorded run body was exactly {}.
No automatic market-run POST occurred on bootstrap or cooldown refresh.

## Screenshots

All screenshots show synthetic data. They are genuine browser viewport captures,
not edited renderings. The viewport sizes are CSS pixels; browser screenshot
encoding/scrollbar handling may affect the raster dimensions.

- r1-desktop.png: three-column diagnostic section, complete/partial/failed fixture
  presentation and administrator-only family-Mock notice; viewport 1440 x 1000.
- r1-mobile.png: section notice plus HK card; viewport 390 x 844.
- r1-mobile-us.png: US card with missing fields and the start of CN card.
- r1-mobile-cn.png: CN safe failure card and following pending-device section.
- r1-mobile-login.png: fixture banner and login UI after simulated logout.

The browser fullPage capture initially produced duplicated stitching and a blank
right-side canvas. It was not used as evidence; r1-desktop.png was replaced with
a normal viewport capture. This was a capture-tool limitation, not a claimed
application rendering defect.

## Asset identity

SHA-256 recorded by the harness when each source asset was first loaded. These
identify the tested bytes; this QA did not read Git or claim a commit identifier.

| Public asset | SHA-256 |
| --- | --- |
| admin.html | 8629b7e3fb5604a408d1057facc24ccbc5059c1725b3cdab0c40f339c46bf18e |
| app.css | def3603ba9d6424266c3d2cb4b7838879451159fdedfad99f35af462273337bb |
| auth.css | 2c721e8d20db3bb342875f93015a0a4373c5eb76369cbc259dd30a710536d3b5 |
| admin-contract.js | 509d614dba5951dac87645b9268824c2638fc4a2754ecf18c443ef3ae29912ba |
| auth-contract.js | c156cb17c528e2900c5ed3dc92c0d154ceb7f8a04b622ffec33ec0d2e6e2fe97 |
| admin.js | b1514b9586544b9db25259aee9e7084c121e2ba9ed1d2b4c57d1485661393f13 |

## Limitations and teardown

- No backend middleware, genuine CSRF/session checks, scrypt, SQLite, provider
  parsing, security redaction, quota transactions, or real-data entitlement was
  validated. Those require the independent unit/integration/security work.
- Legacy administrator sections were checked for visible preservation; no actual
  device approval/revoke mutation or legacy diagnostic was executed.
- This is viewport-responsive testing, not physical-device or touch emulation.
- The hidden/unused hostile financial metric was not rendered by this UI; the
  positive text-only DOM checks cover company and device names, not every field.
- Browser automation encountered transient selector errors across fixture form
  navigations; fresh DOM snapshots/new locators recovered without code changes.
- A temporary local-server sandbox denial was handled with the approved escalation.
- Only this test tab was closed; the viewport override was reset.
- The owned fixture server (PID 4519, execution session 48624) was sent SIGTERM
  and its execution session exited successfully. No persistent QA service remains.
- The disposable harness and non-secret browser-result JSON remain under
  /tmp/kinvest-r1-fixture-qa for reproducibility; no secret material exists there.

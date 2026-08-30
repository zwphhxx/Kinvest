# R1 browser repair QA: three UI findings

Date: 2026-08-30. Browser exercise: approximately 03:31-03:34 UTC.
User-supplied repair identifier: 3bacd49. This task did not inspect Git; the
source-byte hashes below are the authoritative identity of the tested assets.

## Verdict

PASS within the explicitly limited local fixture UI scope. The three previously
reported presentation defects were not reproduced after the repair. No regression
was observed in the exercised cooldown, expired-session, or text-rendering paths.

This is simulated administrator HTTP data, NOT genuine authentication E2E or
real iFinD integration. It does not close the coordinator's outstanding backend
HTTP currency-location issue. No backend code was changed or tested here.
The real HTTP-to-UI composition belongs to the separate integration test; this
task neither ran that test nor claims its result.

## Corrected fixture contract

- Reused /tmp/kinvest-r1-fixture-qa/server.cjs, bound only to 127.0.0.1:55075.
- Market-list runtimeStatus is now available, matching the instructed HTTP enum.
  It is not admin-diagnostic. The earlier fixture report must not be used as
  evidence of an actual HTTP contract match.
- Current public resources were cached on first request. No product assets were
  edited, rebuilt, or replaced by the QA task.
- HK quote.currency is HKD; HK financial[].currency is CNY.
- The three synthetic latest.status values are complete, partial, and failed.
- Shuffled API case order remains CN/HK/US to exercise UI ordering.
- Dummy authentication responses do not validate a password or issue a cookie.
  No real cookie, secret, tmpfs bundle, database, or provider was read.
- Each simulated run takes two seconds, followed by a ten-second fixture
  cooldown. Production cooldown/quotas are not exercised.
- The hostile scenario now marks its malicious metric name as missing so the
  string is actually rendered in the missing-field list, unlike the first pass.
- The disposable banner/scenario controls are injected into the response only.
  CSP remains self-only for network connections and script resources.

## Repair results

| Finding | Observed after repair | Result |
| --- | --- | --- |
| Trading and reporting currencies conflated | HK card separately labels trading currency HKD and financial reporting currency CNY. US shows USD/USD; unavailable CN data shows unavailable rather than an inferred currency. | Pass |
| Partial and failed share one generic result | Each card has its own persistent run-result status: complete, partial, failed. They remain distinct after running another card, cooldown refresh, and page reload. Completion, partial, and failure announcements are also distinct. | Pass |
| Session-check message remains after restoration | After the mock session restores and lists render, the page-level live region is empty, while the three result status regions remain populated. No checking message remains on desktop or mobile. | Pass |

Here persistent means maintained in the rendered UI across the observed
refresh/rerender operations. It does not claim database/session persistence.

## Exact flow and regression observations

1. Opened http://127.0.0.1:55075/admin at 1440 x 1000. Waited for the asynchronously
   loaded market fixtures, rather than treating the initial empty cards as a
   final disabled state. Confirmed the ready state, HK/US/CN order, currency
   separation, three independent result labels, and empty page-level live region.
2. Clicked HK, US, and CN run independently. Each action disabled all three
   buttons during the pending request, with the selected card marked running.
   Each completed with its intended result, refreshed quota, and cooldown.
3. Confirmed all three result labels stayed distinct after every run. US retained
   missing gross_profit fields; CN retained a safe network error and absent data.
4. Observed automatic list rereads at cooldown expiry without a manual reload.
   Desktop expiry GETs occurred at 03:32:02.467, 03:32:04.562, and 03:32:06.656 UTC.
   All buttons returned to ready while the three result labels remained intact.
5. Saved r1-repaired-desktop.png as a normal 1440 x 1000 viewport screenshot of
   the complete three-column diagnostic section.
6. Reloaded the page, confirmed the three result labels remained distinct and no
   checking message remained, then changed the viewport to 390 x 844.
7. Confirmed the mobile cards form a single column in HK/US/CN order. Card width
   was 301 CSS px at x=37; document scrollWidth was 375 versus viewport width 390.
   The HK card showed both HKD and CNY without clipping or horizontal overflow.
8. Saved r1-repaired-mobile.png as a normal viewport screenshot of the HK card,
   its complete-result status, separate currency fields, and accessible button.
9. Ran HK, US, and CN individually on mobile. Complete used a success announcement;
   partial explicitly announced partial completion and missing/error details;
   failed explicitly announced failure. All three per-card result labels persisted.
10. Observed mobile cooldown expiry GETs at 03:33:26.036, 03:33:28.206, and
    03:33:30.323 UTC. All buttons returned to enabled without reload, with result
    labels unchanged.
11. Switched to hostile fixtures. Company name, device name, and missing metric
    names containing img/onerror markup appeared literally. DOM checks found
    zero img[src=x] elements and zero onerror attributes. No dialog appeared and
    the harness recorded no /x request. Repeated at both viewport sizes.
12. Switched to expired fixtures. A synthetic market-list 401 ADMIN_AUTH_REQUIRED
    returned the page to the administrator login form, hid the administration
    desk, and displayed the session-ended message. Confirmed at both sizes.
13. Restored another simulated session for the desktop hostile check and again
    observed an empty page-level live region, not a stale checking message.
14. Error/warning queries returned empty arrays at baseline, cooldown, hostile,
    and final checkpoints. No uncaught browser error was observed.

Six market-run POSTs were recorded, one per case per viewport. Every submitted
run body was exactly {}. No automatic run POST occurred on bootstrap, refresh,
or cooldown expiry. Existing administrator sections and administrator-only /
family-Mock notices remained visible in the restored desk.

## New evidence and preservation

- docs/verification/r1-repaired-desktop.png
- docs/verification/r1-repaired-mobile.png
- /tmp/kinvest-r1-fixture-qa/repair-browser-results.json

The new screenshots were created with exclusive writes. Earlier r1-desktop.png,
r1-mobile.png, other original screenshots, and r1-browser-fixture-qa.md were not
overwritten. All screenshot values are synthetic. Screenshots are direct browser
viewport captures, not edited images or full-page stitched captures.

## Tested asset SHA-256

Hashes were recorded from source bytes at first load by the fixture server,
before its banner was added to the HTML response.

| Public asset | SHA-256 |
| --- | --- |
| admin.html | be106db4774aa39578c19806e2f15a49bbd0656f3555f66462663f1d79797098 |
| app.css | def3603ba9d6424266c3d2cb4b7838879451159fdedfad99f35af462273337bb |
| auth.css | 2c721e8d20db3bb342875f93015a0a4373c5eb76369cbc259dd30a710536d3b5 |
| auth-contract.js | c156cb17c528e2900c5ed3dc92c0d154ceb7f8a04b622ffec33ec0d2e6e2fe97 |
| admin-contract.js | 94d1312c511f13d54787e0b1ab503942dc63f305fb0add0686b444bede18d6bf |
| admin.js | e83ace4f420b1af814623d9b687e77e02dd5f675da3c328870da434a7c31cc36 |

## Limitations and teardown

- Available is the corrected fixture runtime enum; this does not prove every
  field in the synthetic response matches the real HTTP DTO. In particular,
  the outstanding backend currency issue remains outside this pass.
- No real authentication, CSRF security, secret loading, SQLite transactions,
  provider parsing, financial correctness, entitlement, or real-data call was
  exercised. No Production action, backend mutation, test edit, or commit occurred.
- XSS checks demonstrate literal rendering for the supplied strings, not a full
  security audit. Viewport testing is not physical-device/touch testing.
- The prior browser execution context was no longer present, so a fresh local
  QA browser connection/tab was created. No existing real-user tab was used.
- One browser wait returned a selector deadline before the ten-second fixture
  cooldown ended. A subsequent live DOM read and server timestamps confirmed
  successful automatic recovery; no code was altered to bypass that wait.
- The QA tab was closed and the viewport override reset.
- The owned fixture server (PID 36128, execution session 48435) was terminated
  with SIGTERM and its session exited with code 0. The harness remains in /tmp
  for reproducibility, but no QA server remains running.

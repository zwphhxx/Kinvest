# iFinD Report-Period Double-Click Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the most recent completed report-period diagnostic when a rapid follow-up is rejected by the existing server busy, cooldown, or daily-limit gate.

**Architecture:** Keep the existing `activeRun` single-flight guard and server quota behavior unchanged. Narrow the browser controller's destructive error rendering so only the three known pre-vendor gate failures retain the completed DOM result; authentication, CSRF, transport, malformed response, and unknown failures continue to clear the panel and fail closed.

**Tech Stack:** Browser JavaScript, Node.js `assert`, VM-based frontend controller tests, npm checks.

---

### Task 1: Preserve completed results across pre-vendor gate failures

**Files:**
- Modify: `public/admin-report-period-contract.js`
- Test: `server/tests/frontend-ifind-report-period-diagnostic.test.js`

- [ ] **Step 1: Write the failing sequential-cooldown regression test**

Add a controller test after the existing busy-guard test. The harness must return `ready()` for `GET`, a completed `failed('financial')` DTO for the first `POST`, and throw a safe error with code `IFIND_REPORT_PERIOD_DIAGNOSTIC_COOLDOWN` for the second `POST`:

```js
await test('cooldown after a completed run preserves the redacted result', async () => {
  const completed = failed('financial')
  let posts = 0
  const h = harness(contract, {
    request(url) {
      if (url !== POST) return { data: ready() }
      posts += 1
      if (posts === 1) return { data: completed }
      throw Object.assign(new Error('ADMIN_REQUEST_FAILED'), {
        code: `${PREFIX}COOLDOWN`, retryable: false
      })
    }
  })
  h.controller.bind()
  await h.controller.refresh()
  const button = h.nodes.get('ifind-report-period-run')
  await button.click()
  const failureBefore = h.nodes.get('ifind-report-period-failure').textContent
  const shapeBefore = h.nodes.get('ifind-report-period-response-shape').textContent
  assert.match(failureBefore, /IFIND_RESPONSE_SHAPE/)
  assert.match(shapeBefore, /返回结构摘要/)

  await button.click()

  assert.equal(posts, 2)
  assert.equal(h.nodes.get('ifind-report-period-failure').textContent, failureBefore)
  assert.equal(h.nodes.get('ifind-report-period-response-shape').textContent, shapeBefore)
  assert.equal(h.nodes.get('ifind-report-period-request-count').textContent, '2 次')
  assert.equal(h.nodes.get('ifind-report-period-business-request-count').textContent, '1 次')
  assert.equal(button.disabled, false)
})
```

- [ ] **Step 2: Run the focused test suite and verify RED**

Run:

```bash
node server/tests/frontend-ifind-report-period-diagnostic.test.js
```

Expected: FAIL because the cooldown path currently calls `render(null)` and clears the failure evidence and request counts.

- [ ] **Step 3: Implement the minimal non-destructive gate classification**

In `public/admin-report-period-contract.js`, define the exact non-destructive gate codes next to the controller state:

```js
const PRESERVE_RESULT_ERRORS = new Set([
  `${PREFIX}BUSY`,
  `${PREFIX}COOLDOWN`,
  `${PREFIX}DAILY_LIMIT`
])
```

Update `showError` so these three codes preserve the rendered DTO while still displaying the safe error message. All other failures retain the existing `render(null)` behavior:

```js
async function showError(error) {
  const code = codeOf(error)
  if (!PRESERVE_RESULT_ERRORS.has(code)) render(null)
  put('error', errorMessage(code))
  if (code === 'ADMIN_AUTH_REQUIRED' || code === 'ADMIN_CSRF_INVALID') await onError({ code })
  else setLive(errorMessage(code), 'error')
}
```

Do not add timers, retries, persistence, new API fields, or changes to `activeRun`.

- [ ] **Step 4: Verify GREEN and existing single-flight behavior**

Run:

```bash
node server/tests/frontend-ifind-report-period-diagnostic.test.js
```

Expected: all frontend report-period tests pass, including the existing test that proves two concurrent activations produce one POST.

- [ ] **Step 5: Run repository checks**

Run:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: all commands exit `0` without warnings that indicate missing artifacts or unsafe browser behavior.

- [ ] **Step 6: Inspect the scoped diff and commit**

Confirm only the plan, design, contract, and focused frontend test changed; scan the staged diff for secret patterns. Then commit:

```bash
git add public/admin-report-period-contract.js server/tests/frontend-ifind-report-period-diagnostic.test.js \
  docs/superpowers/specs/2026-09-01-ifind-report-period-double-click-design.md \
  docs/superpowers/plans/2026-09-01-ifind-report-period-double-click.md
git commit -m "fix: preserve report-period diagnostic result"
```

- [ ] **Step 7: Two-stage review and PR**

Dispatch a specification reviewer against the approved design, then a code-quality reviewer against `origin/main..HEAD`. Resolve all Critical or Important findings, rerun the focused and repository checks, push `fix/report-period-double-click`, and create a PR targeting `main`. Do not deploy or invoke iFinD.

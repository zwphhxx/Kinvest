# iFinD Report-Period Double-Click Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the most recent completed report-period diagnostic when a rapid follow-up is rejected by the existing server busy, cooldown, or daily-limit gate.

**Architecture:** Keep the existing `activeRun` single-flight guard and server quota behavior unchanged. Narrow the browser controller's destructive error rendering so only the three known pre-vendor gate failures retain the completed DOM result; authentication, CSRF, transport, malformed response, and unknown failures continue to clear the panel and fail closed.

**Tech Stack:** Browser JavaScript, Node.js `assert`, VM-based frontend controller tests, npm checks.

---

### Task 1: Preserve completed results across successful pre-vendor gate DTOs

**Files:**
- Modify: `public/admin-report-period-contract.js`
- Test: `server/tests/frontend-ifind-report-period-diagnostic.test.js`

- [ ] **Step 1: Write failing successful-gate DTO regression tests**

Add a controller test after the existing busy-guard test. For each `busy`, `cooldown`, and `daily-limit` status, the harness must return `ready()` for `GET`, a completed `failed('financial')` DTO for the first `POST`, and a successful `{ data: gateDto }` response for the second `POST`:

```js
await test('successful gate DTOs preserve the completed redacted result', async () => {
  const gateMessages = {
    busy: '已有报告期间诊断正在运行，本次不重试。',
    cooldown: '报告期间诊断正在冷却，本次不重试。',
    'daily-limit': '今日报告期间诊断次数已达上限，本次不重试。'
  }
  for (const status of ['busy', 'cooldown', 'daily-limit']) {
    const completed = failed('financial')
    const gateDto = { ...ready(), status }
    let posts = 0
    const h = harness(contract, {
      request(url) {
        if (url !== POST) return { data: ready() }
        posts += 1
        return { data: posts === 1 ? completed : gateDto }
      }
    })
    h.controller.bind()
    await h.controller.refresh()
    const button = h.nodes.get('ifind-report-period-run')
    await button.click()
    const failureBefore = h.nodes.get('ifind-report-period-failure').textContent
    const shapeBefore = h.nodes.get('ifind-report-period-response-shape').textContent

    await button.click()

    assert.equal(posts, 2)
    assert.equal(h.nodes.get('ifind-report-period-failure').textContent, failureBefore)
    assert.equal(h.nodes.get('ifind-report-period-response-shape').textContent, shapeBefore)
    assert.equal(h.nodes.get('ifind-report-period-request-count').textContent, '2 次')
    assert.equal(h.nodes.get('ifind-report-period-business-request-count').textContent, '1 次')
    assert.equal(h.nodes.get('ifind-report-period-error').textContent, gateMessages[status])
    assert.equal(button.disabled, false)
  }
})
```

- [ ] **Step 2: Run the focused test suite and verify RED**

Run:

```bash
node server/tests/frontend-ifind-report-period-diagnostic.test.js
```

Expected: FAIL because the successful gate DTO path currently calls `render(dto)` and replaces the completed failure evidence and request counts.

- [ ] **Step 3: Implement minimal successful gate DTO handling**

In `public/admin-report-period-contract.js`, map the three successful gate DTO statuses to their exact safe message codes next to the controller state:

```js
const GATE_RESULT_CODES = new Map([
  ['busy', `${PREFIX}BUSY`],
  ['cooldown', `${PREFIX}COOLDOWN`],
  ['daily-limit', `${PREFIX}DAILY_LIMIT`]
])
```

In the successful `run()` commit path, preserve the rendered DTO for those three statuses while displaying the exact safe gate message. All other successful DTOs continue through `render(dto)`:

```js
const gateCode = GATE_RESULT_CODES.get(dto.status)
if (gateCode) {
  const message = errorMessage(gateCode)
  put('error', message)
  setLive(message, 'error')
} else {
  render(dto)
  setLive(dto.status === 'observed-unverified' ? '已取得诊断旁证，收入报告期仍未验证。' : '诊断状态已更新；未自动重试。', '')
}
```

Keep `showError` destructive for auth, CSRF, network, malformed, and unknown failures. Do not add timers, retries, persistence, new API fields, or changes to `activeRun`.

- [ ] **Step 4: Verify GREEN and existing single-flight behavior**

Run:

```bash
node server/tests/frontend-ifind-report-period-diagnostic.test.js
```

Expected: all frontend report-period tests pass, including the three successful gate DTO cases and the existing test that proves two concurrent activations produce one POST.

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

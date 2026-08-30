'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const admin = require('../../public/admin-contract')

const ROOT = path.resolve(__dirname, '../..')
const GET = '/api/admin/ifind/calibration'
const POST = `${GET}/run`
const EVIDENCE = [
  'issuerIdentityStatus', 'vendorCodeStatus', 'entitlementStatus', 'currencyStatus',
  'unitStatus', 'reportPeriodStatus', 'scopeStatus'
]
const SOURCES = Object.fromEntries(['admin.html', 'admin.js', 'admin-contract.js']
  .map((name) => [name, fs.readFileSync(path.join(ROOT, 'public', name), 'utf8')]))

function dto(overrides = {}) {
  const result = {
    periodEvidence: periodEvidence(),
    calibrationId: 'HK_ALIBABA_REVENUE_OAS_20260331_V1',
    caseId: 'HK_ALIBABA_9988', displayCode: '9988.HK', indicator: 'revenue_oas',
    parameters: ['20260331', '1', 'BB'], status: 'ready',
    verification: Object.fromEntries(EVIDENCE.map((key) => [key, 'unverified'])),
    observation: null, requestCount: 0, businessRequestCount: 0, dataVol: null,
    attemptedAt: null, errorCode: null, ...overrides
  }
  if (!Object.hasOwn(overrides, 'periodEvidence')) {
    result.periodEvidence = periodEvidence(result.observation && result.observation.value)
  }
  return result
}

function periodEvidence(value = null) {
  const references = [
    {
      id: 'ALIBABA_REVENUE_20250630_QUARTER',
      url: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2025/0829/2025082901541_c.pdf',
      publishedAt: '2025-08-29', pdfPages: [5, 6],
      period: { type: 'quarter', start: '2025-04-01', end: '2025-06-30' },
      currency: 'CNY', unit: 'million', revenue: 247652
    },
    {
      id: 'ALIBABA_REVENUE_20260331_QUARTER',
      url: 'https://www.alibabagroup.com/zh-HK/document-1991237455038119936',
      publishedAt: '2026-05-13', pdfPages: [],
      period: { type: 'quarter', start: '2026-01-01', end: '2026-03-31' },
      currency: 'CNY', unit: 'million', revenue: 243380
    },
    {
      id: 'ALIBABA_REVENUE_20260331_YEAR',
      url: 'https://www.alibabagroup.com/zh-HK/document-1991237455038119936',
      publishedAt: '2026-05-13', pdfPages: [],
      period: { type: 'fiscal-year', start: '2025-04-01', end: '2026-03-31' },
      currency: 'CNY', unit: 'million', revenue: 1023670
    }
  ]
  return {
    requestedSelector: '20260331', actualPeriod: null, decision: 'unverified',
    reasonCode: 'IFIND_REPORT_PERIOD_UNPROVEN', references,
    comparisonOnly: references.filter((item) => value === item.revenue * 1000000)
      .map((item) => ({ sourceId: item.id, signal: 'numerical-match-only' })),
    parameterEvidence: {
      source: 'ifind-supercommand-ui', observedAt: '2026-08-30',
      statementScope: { raw: '1', meaning: 'consolidated-statements' },
      currencyBasis: { raw: 'BB', meaning: 'original-currency' },
      currentMrqSelector: '8', frozenSelectorMapping: 'unproven'
    }
  }
}

function observed(overrides = {}) {
  return dto({
    status: 'observed-unverified', requestCount: 2, businessRequestCount: 1,
    attemptedAt: '2026-08-30T08:00:00.000Z',
    observation: {
      value: 0, availability: 'present', returnedCode: '9988.HK', currency: null,
      unit: null, reportPeriod: null, periodType: null, disclosureScope: null
    }, ...overrides
  })
}

class Element {
  constructor(id = '') {
    this.id = id
    this.textContent = ''
    this.value = ''
    this.disabled = false
    this.dataset = {}
    this.attributes = new Map()
    this.listeners = new Map()
    this.children = []
    this.parentElement = { dataset: {} }
    const classes = new Set(id === 'admin-desk' ? ['hidden'] : [])
    this.classList = {
      add: (value) => classes.add(value), remove: (value) => classes.delete(value),
      contains: (value) => classes.has(value)
    }
  }

  set innerHTML(_value) { throw new Error('HTML_INJECTION_FORBIDDEN') }
  setAttribute(key, value) { this.attributes.set(key, String(value)) }
  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) || []
    handlers.push(handler)
    this.listeners.set(name, handlers)
  }
  append(...nodes) { this.children.push(...nodes) }
  appendChild(node) { this.children.push(node) }
  replaceChildren(...nodes) { this.children = nodes }
  focus() {}
  async click() {
    for (const handler of this.listeners.get('click') || []) await handler({ preventDefault() {} })
  }
}

function dom() {
  const elements = new Map([...SOURCES['admin.html'].matchAll(/\bid="([^"]+)"/g)]
    .map((match) => [match[1], new Element(match[1])]))
  return {
    elements, get: (id) => elements.get(id),
    document: {
      getElementById: (id) => elements.get(id) || null,
      createElement: () => new Element(), querySelectorAll: () => []
    }
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return {
    promise,
    resolve(value = undefined) {
      if (typeof resolve !== 'function') throw new Error('DEFERRED_NOT_INITIALIZED')
      resolve(value)
    },
    reject(reason = undefined) {
      if (typeof reject !== 'function') throw new Error('DEFERRED_NOT_INITIALIZED')
      reject(reason)
    }
  }
}

function harness(options = {}) {
  assert.equal(typeof admin.createIfindCalibrationController, 'function', 'calibration controller is missing')
  const nodes = dom()
  const lifecycle = admin.createAdminSessionLifecycle()
  lifecycle.activate()
  const calls = []
  const confirmations = []
  const messages = []
  const errors = []
  const controller = admin.createIfindCalibrationController({
    document: nodes.document, sessionLifecycle: lifecycle,
    dateText: (value) => `date:${value}`,
    confirm(message) { confirmations.push(message); return options.confirm !== false },
    setLive(message, tone) { messages.push([message, tone]) },
    async onError(error) { errors.push(error.code); lifecycle.invalidate() },
    async request(url, requestOptions = {}) {
      calls.push([url, requestOptions])
      if (options.request) return options.request(url, requestOptions)
      return { data: url === POST ? observed() : dto() }
    }
  })
  return { controller, nodes, lifecycle, calls, confirmations, messages, errors }
}

function viewTest() {
  assert.equal(typeof admin.createIfindCalibrationView, 'function', 'calibration view is missing')
  const view = admin.createIfindCalibrationView(observed())
  assert.equal(view.value, '0', 'zero is a present observation, not missing')
  assert.equal(view.dataVol, '未提供', 'dataVol must not be inferred from one business call')
  assert.equal(view.requestCount, '2 次')
  assert.equal(view.businessRequestCount, '1 次')
  for (const key of EVIDENCE) assert.equal(view.verification[key], 'unverified')
  for (const key of ['currency', 'unit', 'reportPeriod', 'periodType', 'disclosureScope']) {
    assert.equal(view[key], '未知 / 未验证')
  }
  assert.match(view.statusLabel, /未验证/)
  assert.equal(view.run.disabled, false, 'another call requires a new confirmation, not an automatic retry')
  assert.equal(admin.createIfindCalibrationView(observed({ dataVol: 0 })).dataVol, '0')
  const missing = observed({ observation: { ...observed().observation, value: null, availability: 'missing' } })
  assert.equal(admin.createIfindCalibrationView(missing).value, '—')
  assert.match(admin.createIfindCalibrationView(missing).availability, /缺失/)
}

function failClosedViewTest() {
  assert.equal(typeof admin.createIfindCalibrationView, 'function', 'calibration view is missing')
  const invalid = [
    null, dto({ calibrationId: 'OTHER' }), dto({ caseId: 'US_APPLE_AAPL' }),
    dto({ displayCode: 'AAPL.US' }), dto({ indicator: 'other' }),
    dto({ parameters: ['20260330', '1', 'BB'] }), dto({ requestCount: 3 }),
    dto({ businessRequestCount: 2 }), dto({ dataVol: -1 }), dto({ status: 'verified' }),
    dto({ verification: { ...dto().verification, unitStatus: 'verified' } }),
    observed({ observation: { ...observed().observation, currency: 'HKD' } }),
    observed({ observation: { ...observed().observation, value: Infinity } })
  ]
  for (const input of invalid) {
    const view = admin.createIfindCalibrationView(input)
    assert.equal(view.run.disabled, true)
    assert.equal(view.value, '—')
    for (const key of EVIDENCE) assert.equal(view.verification[key], 'unverified')
  }
  for (const status of ['busy', 'cooldown', 'daily-limit', 'unavailable']) {
    assert.equal(admin.createIfindCalibrationView(dto({ status })).run.disabled, true)
  }
  assert.equal(admin.createIfindCalibrationView(dto({ status: 'failed' })).run.disabled, false)
}

function periodEvidenceViewTest() {
  const input = observed({ observation: { ...observed().observation, value: 247652000000 } })
  const view = admin.createIfindCalibrationView(input)
  assert.match(view.requestSelector, /20260331.*请求参数/)
  assert.equal(view.reportPeriod, '未知 / 未验证')
  assert.match(view.periodDecision, /未证实/)
  assert.match(view.parameterMeanings, /1 = 合并报表.*BB = 原始币种/)
  assert.equal(view.periodComparisons.length, 3)
  assert.match(view.periodComparisons[0].summary, /2025-04-01.*2025-06-30.*单季度.*247,652.*2025-08-29/)
  assert.match(view.periodComparisons[0].signal, /数值相同.*仅供比对/)
  assert.match(view.periodComparisons[1].summary, /2026-03-31.*单季度/)
  assert.match(view.periodComparisons[2].summary, /2026-03-31.*财政年度/)
  assert.match(view.periodComparisons[1].signal, /不代表接口错误/)
  for (const key of EVIDENCE) assert.equal(view.verification[key], 'unverified')
  for (const key of ['currency', 'unit', 'reportPeriod', 'periodType', 'disclosureScope']) {
    assert.equal(view[key], '未知 / 未验证')
  }
  const wrong = [
    undefined,
    { ...input.periodEvidence, actualPeriod: { type: 'quarter', start: '2025-04-01', end: '2025-06-30' } },
    { ...input.periodEvidence, decision: 'verified' },
    { ...input.periodEvidence, comparisonOnly: [] },
    { ...input.periodEvidence, unexpected: true },
    { ...input.periodEvidence, requestedSelector: '8' },
    { ...input.periodEvidence, references: input.periodEvidence.references.map((ref, index) =>
      index === 0 ? { ...ref, url: 'javascript:alert(1)' } : ref) }
  ]
  let getterReads = 0
  wrong.push(Object.defineProperty({ ...input.periodEvidence }, 'actualPeriod', {
    get() { getterReads += 1; return null }
  }))
  for (const evidence of wrong) {
    const rejected = admin.createIfindCalibrationView({ ...input, periodEvidence: evidence })
    assert.equal(rejected.run.disabled, true)
    assert.equal(rejected.value, '—')
    assert.deepEqual(rejected.periodComparisons, [])
  }
  assert.equal(getterReads, 0, 'evidence accessors must not execute')
}

async function periodEvidenceRenderingTest() {
  const h = harness()
  h.controller.bind()
  await h.controller.refresh()
  assert.match(h.nodes.get('ifind-calibration-request-selector').textContent, /请求参数/)
  assert.match(h.nodes.get('ifind-calibration-period-decision').textContent, /未证实/)
  const list = h.nodes.get('ifind-calibration-period-comparisons')
  assert.equal(list.children.length, 3)
  const link = list.children[0].children[1]
  assert.equal(link.attributes.get('href'), periodEvidence().references[0].url)
  assert.equal(link.attributes.get('rel'), 'noopener noreferrer')
  assert.equal(h.calls.length, 1, 'source rendering must not fetch any source or run iFinD')
  h.lifecycle.invalidate()
  assert.equal(list.children.length, 0, 'session invalidation clears evidence together with observations')
}

async function confirmationAndSingleCallTest() {
  const pending = deferred()
  const h = harness({ request: async (url) => url === POST ? pending.promise : { data: dto() } })
  h.controller.bind()
  h.controller.bind()
  assert.equal(h.calls.length, 0, 'binding never fetches or runs')
  await h.controller.refresh()
  assert.equal(h.calls.length, 1)
  const button = h.nodes.get('ifind-calibration-run')
  assert.equal(button.listeners.get('click').length, 1)
  const first = button.click()
  await button.click()
  assert.equal(h.confirmations.length, 1)
  assert.match(h.confirmations[0], /9988\.HK/)
  assert.match(h.confirmations[0], /revenue_oas/)
  assert.match(h.confirmations[0], /20260331/)
  assert.match(h.confirmations[0], /1 次认证/)
  assert.match(h.confirmations[0], /1 次业务/)
  assert.match(h.confirmations[0], /0 次重试/)
  assert.match(h.confirmations[0], /额度/)
  assert.match(h.confirmations[0], /Mock/)
  assert.equal(button.disabled, true)
  assert.equal(button.attributes.get('aria-busy'), 'true')
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1][0], POST)
  assert.equal(h.calls[1][1].method, 'POST')
  assert.deepEqual(h.calls[1][1].body, {})
  assert.equal(h.calls[1][1].csrf, true)
  assert.ok(h.calls[1][1].signal instanceof AbortSignal)
  pending.resolve({ data: observed() })
  await first
  assert.equal(h.calls.length, 2, 'POST must not trigger a status GET')
  assert.equal(h.nodes.get('ifind-calibration-value').textContent, '0')
  assert.equal(button.attributes.get('aria-busy'), 'false')
  await h.controller.refresh()
  assert.equal(h.calls.length, 2, 'ordinary admin refresh must retain the transient observation')
  await button.click()
  assert.equal(h.confirmations.length, 2, 'each separate call needs fresh authorization')
  assert.equal(h.calls.length, 3)
}

async function cancelledTest() {
  const h = harness({ confirm: false })
  h.controller.bind()
  await h.controller.refresh()
  await h.nodes.get('ifind-calibration-run').click()
  assert.equal(h.calls.length, 1)
  assert.equal(h.confirmations.length, 1)
  assert.equal(h.nodes.get('ifind-calibration-run').disabled, false)
}

async function failureNeverRetriesTest() {
  const h = harness({ request: async (url) => {
    if (url === POST) throw Object.assign(new Error('sensitive transport detail'), { code: 'UNKNOWN' })
    return { data: dto() }
  } })
  h.controller.bind()
  await h.controller.refresh()
  await h.nodes.get('ifind-calibration-run').click()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.calls.length, 2)
  assert.equal(h.nodes.get('ifind-calibration-run').disabled, true)
  assert.doesNotMatch(h.messages.flat().join(' '), /sensitive transport detail/)
  assert.match(h.messages.at(-1)[0], /重试|未完成|不可用/)
}

async function sessionInvalidationTest() {
  const pending = deferred()
  const h = harness({ request: async (url) => url === POST ? pending.promise : { data: dto() } })
  h.controller.bind()
  await h.controller.refresh()
  const running = h.nodes.get('ifind-calibration-run').click()
  h.lifecycle.invalidate()
  assert.equal(h.calls[1][1].signal.aborted, true)
  pending.resolve({ data: observed() })
  await running
  assert.equal(h.nodes.get('ifind-calibration-value').textContent, '—')
  assert.equal(h.nodes.get('ifind-calibration-run').disabled, true)
  assert.equal(h.messages.length, 0, 'late results cannot announce or repaint')
  await h.controller.run()
  assert.equal(h.calls.length, 2)
}

async function staleRefreshTest() {
  const older = deferred()
  let reads = 0
  const h = harness({ request: async () => ++reads === 1 ? older.promise : { data: dto() } })
  const first = h.controller.refresh()
  await h.controller.refresh()
  older.resolve({ data: dto({ status: 'unavailable' }) })
  await first
  assert.equal(h.nodes.get('ifind-calibration-run').disabled, false)
}

function safeErrorsTest() {
  assert.equal(typeof admin.ifindCalibrationApiFailure, 'function', 'calibration API classification is missing')
  for (const code of ['IFIND_CALIBRATION_BUSY', 'IFIND_CALIBRATION_COOLDOWN', 'ADMIN_CSRF_INVALID']) {
    const failure = admin.ifindCalibrationApiFailure(503, { error: code })
    assert.equal(failure.code, code)
    assert.equal(failure.retryable, false)
  }
  const unavailable = admin.ifindCalibrationApiFailure(503, {
    data: dto({ status: 'unavailable', errorCode: 'IFIND_CALIBRATION_UNAVAILABLE' })
  })
  assert.equal(unavailable.code, 'IFIND_CALIBRATION_UNAVAILABLE')
  assert.equal(unavailable.calibration.status, 'unavailable')
  const unsafe = admin.ifindCalibrationApiFailure(500, { error: '<script>private detail</script>' })
  assert.equal(unsafe.code, 'UNKNOWN')
  assert.equal(unsafe.retryable, false)
  assert.doesNotMatch(unsafe.message, /private detail|<script>/)
}

async function bootstrapFixture({ unavailable = false, failureCode = null } = {}) {
  const nodes = dom()
  const calls = []
  const confirmations = []
  const window = {
    KinvestAdmin: admin,
    KinvestAuth: {
      authErrorMessage: () => '管理员会话不可用。',
      classifyApiFailure: (_status, payload) => ({ code: payload.error || 'UNKNOWN' })
    },
    confirm(message) { confirmations.push(message); return true },
    addEventListener() {}
  }
  vm.runInNewContext(SOURCES['admin.js'], {
    window, document: nodes.document,
    async fetch(url, options = {}) {
      calls.push([url, options])
      const replies = {
        '/api/admin/csrf': { csrfToken: 'fixture-csrf' },
        '/api/admin/device-requests': { data: [] },
        '/api/admin/devices': { data: [] },
        '/api/admin/audit': { data: { admin: [], device: [] } },
        '/api/admin/ifind/diagnostics': { data: null },
        '/api/admin/ifind/market-cases': { data: { runtimeStatus: 'disabled', cases: [] } },
        [GET]: { data: dto({ status: unavailable ? 'unavailable' : 'ready' }) },
        [POST]: failureCode ? { error: failureCode } : { data: observed() }
      }
      assert.ok(Object.hasOwn(replies, url), `unexpected endpoint: ${url}`)
      const status = url === GET && unavailable ? 503 : (url === POST && failureCode ? 403 : 200)
      return { ok: status === 200, status, json: async () => replies[url] }
    }
  })
  await new Promise((resolve) => setImmediate(resolve))
  return { nodes, calls, confirmations }
}

async function bootstrapUnavailableTest() {
  assert.match(SOURCES['admin.js'], /createIfindCalibrationController/)
  const h = await bootstrapFixture({ unavailable: true })
  assert.equal(h.nodes.get('admin-desk').classList.contains('hidden'), false)
  assert.equal(h.nodes.get('pending-requests').children.length, 1)
  assert.equal(h.nodes.get('approved-devices').children.length, 1)
  assert.equal(h.nodes.get('ifind-calibration-run').disabled, true)
  assert.equal(h.calls.filter(([url]) => url === GET).length, 1)
  assert.equal(h.calls.filter(([url]) => url === POST).length, 0)
  assert.equal(h.nodes.get('admin-live').textContent, '')
  assert.equal(h.confirmations.length, 0)
}

async function adminTransportTest() {
  assert.match(SOURCES['admin.js'], /createIfindCalibrationController/)
  const h = await bootstrapFixture()
  await h.nodes.get('ifind-calibration-run').click()
  const writes = h.calls.filter(([url]) => url === POST)
  assert.equal(writes.length, 1)
  assert.equal(writes[0][1].headers['x-kinvest-csrf'], 'fixture-csrf')
  assert.equal(writes[0][1].credentials, 'same-origin')
  assert.deepEqual(JSON.parse(writes[0][1].body), {})
  assert.equal(h.calls.filter(([url]) => url === GET).length, 1)
  assert.equal(h.confirmations.length, 1)
  assert.equal(h.nodes.get('ifind-calibration-value').textContent, '0')
  const reloaded = await bootstrapFixture()
  assert.equal(reloaded.nodes.get('ifind-calibration-value').textContent, '—')
}

async function adminAuthNoReplayTest() {
  assert.match(SOURCES['admin.js'], /createIfindCalibrationController/)
  for (const failureCode of ['ADMIN_AUTH_REQUIRED', 'ADMIN_CSRF_INVALID']) {
    const h = await bootstrapFixture({ failureCode })
    await h.nodes.get('ifind-calibration-run').click()
    assert.equal(h.calls.filter(([url]) => url === POST).length, 1)
    assert.equal(h.calls.filter(([url]) => url === '/api/admin/csrf').length, 1)
    assert.equal(h.calls.filter(([url]) => url === GET).length, 1)
    assert.equal(h.nodes.get('admin-desk').classList.contains('hidden'), true)
    assert.equal(h.nodes.get('ifind-calibration-value').textContent, '—')
  }
}

function markupTest() {
  const html = SOURCES['admin.html']
  assert.match(html, /id="ifind-calibration"/)
  const panel = html.slice(html.indexOf('<section id="ifind-calibration"'), html.indexOf('</section>', html.indexOf('<section id="ifind-calibration"')))
  assert.ok(html.indexOf('id="admin-desk"') < html.indexOf('id="ifind-calibration"'))
  assert.equal((panel.match(/<button\b/g) || []).length, 1)
  assert.doesNotMatch(panel, /<input|<select|<textarea|<form|<pre/i)
  for (const value of ['HK_ALIBABA_REVENUE_OAS_20260331_V1', 'HK_ALIBABA_9988', '9988.HK', 'revenue_oas', '20260331', "'BB'"]) {
    assert.ok(panel.includes(value), `fixed config missing: ${value}`)
  }
  for (const word of ['Mock', '逐次', '认证', '业务', '0 次重试', 'dataVol', '刷新', '未验证', '未知']) {
    assert.ok(panel.includes(word), `safety explanation missing: ${word}`)
  }
  assert.equal((panel.match(/data-evidence-status="unverified"/g) || []).length, 7)
  assert.match(panel, /aria-live="polite"/)
  assert.match(panel, /aria-describedby=/)
  assert.doesNotMatch(html, /<style\b|<script(?![^>]*\bsrc=)|\son[a-z]+\s*=/i)
  assert.equal((html.match(/class="ifind-market-card"/g) || []).length, 3)
  const script = SOURCES['admin.js'] + SOURCES['admin-contract.js']
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage/)
}

async function cleanupPreservesOriginalErrorTest() {
  const nodes = dom()
  const original = new Error('ORIGINAL_SESSION_FAILURE')
  const cleanup = new Error('CLEANUP_FAILURE')
  let commits = 0
  let finished = 0
  const controller = admin.createIfindCalibrationController({
    document: nodes.document,
    sessionLifecycle: {
      beginRequest() { return { signal: undefined } },
      commit(_ticket, operation) {
        commits += 1
        if (commits === 3) throw cleanup
        operation()
      },
      finishRequest() { finished += 1 },
      onInvalidate() {}
    },
    confirm: () => true,
    setLive() {},
    async onError() { throw original },
    async request(url) {
      if (url === GET) return { data: dto() }
      throw Object.assign(new Error('SESSION_REJECTED'), { code: 'ADMIN_AUTH_REQUIRED' })
    }
  })
  controller.bind()
  await controller.refresh()
  await assert.rejects(controller.run(), (error) => error === original)
  assert.equal(finished, 2, 'both requests still receive cleanup')
}

async function run() {
  const tests = {
    viewTest, failClosedViewTest, periodEvidenceViewTest, periodEvidenceRenderingTest,
    confirmationAndSingleCallTest, cancelledTest,
    failureNeverRetriesTest, sessionInvalidationTest, staleRefreshTest, safeErrorsTest,
    bootstrapUnavailableTest, adminTransportTest, adminAuthNoReplayTest, markupTest,
    cleanupPreservesOriginalErrorTest
  }
  const failures = []
  for (const [name, test] of Object.entries(tests)) {
    try { await test() } catch (error) {
      error.message = `${name}: ${error.message}`
      failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, 'frontend calibration regressions')
  return { passed: Object.keys(tests).length }
}

module.exports = { run }

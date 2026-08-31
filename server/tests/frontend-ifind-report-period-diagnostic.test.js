'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const admin = require('../../public/admin-contract')

const ROOT = path.resolve(__dirname, '../..')
const CONTRACT = path.join(ROOT, 'public/admin-report-period-contract.js')
const GET = '/api/admin/ifind/report-period-diagnostic'
const POST = `${GET}/run`
const PREFIX = 'IFIND_REPORT_PERIOD_DIAGNOSTIC_'
const KEYS = ['issuerIdentityStatus', 'vendorCodeStatus', 'entitlementStatus',
  'currencyStatus', 'unitStatus', 'reportPeriodStatus', 'scopeStatus']

function ready() {
  return {
    diagnosticId: 'HK_ALIBABA_REPORT_PERIOD_20260331_SINGLE_QUARTER_V1',
    caseId: 'HK_ALIBABA_9988', displayCode: '9988.HK', requestedSelector: '20260331',
    indicators: [
      { indicator: 'revenue_oas', parameters: ['20260331', '1', 'BB'] },
      { indicator: 'report_sd', parameters: ['20260331', '1'] },
      { indicator: 'report_ed', parameters: ['20260331', '1'] }
    ],
    status: 'ready', verification: Object.fromEntries(KEYS.map((key) => [key, 'unverified'])),
    observation: null, requestCount: 0, businessRequestCount: 0, dataVol: null,
    attemptedAt: null, errorCode: null
  }
}

function observed() {
  return {
    ...ready(), status: 'observed-unverified', requestCount: 2, businessRequestCount: 1,
    attemptedAt: '2026-08-31T04:00:00.000Z', errorCode: `${PREFIX}OBSERVED_UNVERIFIED`,
    observation: {
      returnedCode: '9988.HK', revenue: { value: 0, availability: 'present' },
      dateEvidence: { requestedDataType: 'single-quarter', start: '2025-04-01',
        end: '2025-06-30', availability: 'present', revenuePeriodLink: 'unverified' }
    }
  }
}

class Element {
  constructor(id = '') {
    this.textContent = ''
    this.value = ''
    this.disabled = false
    this.dataset = {}
    this.attributes = new Map()
    this.listeners = new Map()
    this.children = []
    this.parentElement = { dataset: {} }
    const classes = new Set(id === 'admin-desk' ? ['hidden'] : [])
    this.classList = { add: (v) => classes.add(v), remove: (v) => classes.delete(v), contains: (v) => classes.has(v) }
  }
  set innerHTML(_value) { throw new Error('HTML_WRITE_FORBIDDEN') }
  setAttribute(key, value) { this.attributes.set(key, String(value)) }
  addEventListener(event, fn) {
    const handlers = this.listeners.get(event) || []
    handlers.push(fn)
    this.listeners.set(event, handlers)
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
  const html = fs.readFileSync(path.join(ROOT, 'public/admin.html'), 'utf8')
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => [m[1], new Element(m[1])]))
  return { html, get: (id) => elements.get(id), document: {
    getElementById: (id) => elements.get(id) || null,
    createElement: () => new Element(), querySelectorAll: () => []
  } }
}

function deferred() {
  let resolve
  const promise = new Promise((yes) => { resolve = yes })
  return { promise, resolve: (value) => resolve(value) }
}

/** @param {any} contract @param {any} options */
function harness(contract, options = {}) {
  const nodes = dom()
  const lifecycle = admin.createAdminSessionLifecycle()
  lifecycle.activate()
  const calls = []
  const confirmations = []
  const errors = []
  const messages = []
  const controller = contract.createController({
    document: nodes.document, sessionLifecycle: lifecycle, dateText: (value) => `date:${value}`,
    confirm(message) { confirmations.push(message); return options.confirm !== false },
    setLive(message, tone) { messages.push([message, tone]) },
    async onError(error) { errors.push(error.code); lifecycle.invalidate() },
    async request(url, requestOptions = {}) {
      calls.push([url, requestOptions])
      return options.request ? options.request(url, requestOptions) : { data: url === POST ? observed() : ready() }
    }
  })
  return { nodes, lifecycle, calls, confirmations, errors, messages, controller }
}

async function run() {
  assert.ok(fs.existsSync(CONTRACT), 'fixed report-period browser contract is missing')
  const contract = require('../../public/admin-report-period-contract')
  let count = 0
  const failures = []
  async function test(name, fn) {
    try { await fn(); count += 1 } catch (error) { failures.push(Object.assign(error, { testName: name })) }
  }

  await test('strict detached DTO and zero/missing distinction', () => {
    assert.deepEqual(contract.copyResult(ready()), ready())
    const input = observed()
    const copied = contract.copyResult(input)
    assert.deepEqual(copied, input)
    input.observation.revenue.value = 42
    input.indicators[0].parameters[0] = '8'
    assert.equal(copied.observation.revenue.value, 0)
    assert.equal(copied.indicators[0].parameters[0], '20260331')
    for (const key of KEYS) assert.equal(copied.verification[key], 'unverified')
    for (const dateState of ['partial', 'missing']) {
      const partial = observed()
      partial.observation.revenue = { value: null, availability: 'missing' }
      partial.observation.dateEvidence.end = null
      if (dateState === 'missing') partial.observation.dateEvidence.start = null
      partial.observation.dateEvidence.availability = dateState
      assert.deepEqual(contract.copyResult(partial), partial)
    }
  })

  await test('invalid metadata cannot turn into verification', () => {
    const variants = [null, { ...ready(), extra: true }, { ...ready(), status: 'verified' },
      { ...ready(), requestedSelector: '8' }, { ...ready(), requestCount: 1 },
      { ...observed(), requestCount: 3 }, { ...observed(), dataVol: -1 },
      { ...observed(), attemptedAt: '2026-02-30T00:00:00.000Z' }]
    for (const key of KEYS) variants.push({ ...observed(), verification: { ...ready().verification, [key]: 'verified' } })
    for (const changes of [
      { start: '2025-02-30' }, { start: '20250701' }, { start: '2025-07-01' },
      { availability: 'missing' }, { revenuePeriodLink: 'verified' }, { requestedDataType: 'cumulative' },
      { end: '<script>fixture</script>' }, { actualPeriod: '2025Q2' }
    ]) {
      const dto = observed()
      Object.assign(dto.observation.dateEvidence, changes)
      variants.push(dto)
    }
    const infinity = observed(); infinity.observation.revenue.value = Infinity; variants.push(infinity)
    let reads = 0
    variants.push(Object.defineProperty(ready(), 'observation', { enumerable: true, get() { reads += 1; return null } }))
    for (const dto of variants) assert.throws(() => contract.copyResult(dto), { code: `${PREFIX}RESULT_INVALID` })
    assert.equal(reads, 0)
  })

  await test('separate fixed panel and safe integration', () => {
    const h = dom()
    const start = h.html.indexOf('<section id="ifind-report-period"')
    assert.ok(start > h.html.indexOf('id="admin-desk"'))
    const panel = h.html.slice(start, h.html.indexOf('</section>', start))
    for (const label of ['9988.HK', 'revenue_oas', 'report_sd', 'report_ed', '20260331', '单季报', '合并报表', 'Mock', '未验证']) {
      assert.ok(panel.includes(label), label)
    }
    assert.equal((panel.match(/<button\b/g) || []).length, 1)
    assert.doesNotMatch(panel, /<input|<select|<textarea|<form|<pre/i)
    assert.ok(h.html.indexOf('src="/admin-report-period-contract.js"') < h.html.indexOf('src="/admin.js"'))
    const source = fs.readFileSync(CONTRACT, 'utf8')
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|setInterval/)
  })

  await test('GET only, cancel, confirmed single POST and busy guard', async () => {
    const pending = deferred()
    const h = harness(contract, { request: (url) => url === POST ? pending.promise : { data: ready() } })
    h.controller.bind(); h.controller.bind()
    assert.equal(h.calls.length, 0)
    await h.controller.refresh()
    assert.equal(h.calls.length, 1)
    const button = h.nodes.get('ifind-report-period-run')
    assert.equal(button.listeners.get('click').length, 1)
    const first = button.click()
    await button.click()
    assert.equal(h.confirmations.length, 1)
    for (const word of ['9988.HK', 'revenue_oas', 'report_sd', 'report_ed', '20260331', '1 次认证', '1 次业务', '0 次重试', '额度', 'Mock']) {
      assert.ok(h.confirmations[0].includes(word), word)
    }
    assert.equal(h.calls.length, 2)
    assert.equal(h.calls[1][0], POST)
    assert.equal(h.calls[1][1].method, 'POST')
    assert.deepEqual(h.calls[1][1].body, {})
    assert.equal(h.calls[1][1].csrf, true)
    assert.ok(h.calls[1][1].signal instanceof AbortSignal)
    assert.equal(button.disabled, true)
    pending.resolve({ data: observed() }); await first
    assert.equal(h.calls.length, 2)
    assert.equal(h.nodes.get('ifind-report-period-value').textContent, '0')
    assert.equal(h.nodes.get('ifind-report-period-start').textContent, '2025-04-01')
    assert.equal(h.nodes.get('ifind-report-period-end').textContent, '2025-06-30')
    assert.match(h.nodes.get('ifind-report-period-link').textContent, /未验证/)
    assert.ok(h.messages.every((item) => item[1] !== 'success'))
    const cancelled = harness(contract, { confirm: false })
    cancelled.controller.bind(); await cancelled.controller.refresh()
    await cancelled.nodes.get('ifind-report-period-run').click()
    assert.equal(cancelled.calls.length, 1)
  })

  await test('missing is never zero or requested date', async () => {
    const dto = observed()
    dto.observation.revenue = { value: null, availability: 'missing' }
    dto.observation.dateEvidence = { ...dto.observation.dateEvidence, start: null, end: null, availability: 'missing' }
    const h = harness(contract, { request: () => ({ data: dto }) })
    await h.controller.refresh()
    assert.equal(h.nodes.get('ifind-report-period-value').textContent, '—')
    assert.equal(h.nodes.get('ifind-report-period-start').textContent, '未提供')
    assert.equal(h.nodes.get('ifind-report-period-end').textContent, '未提供')
    assert.equal(h.nodes.get('ifind-report-period-data-vol').textContent, '未提供')
  })

  await test('invalid result and arbitrary transport error clear and never retry', async () => {
    for (const malformed of [true, false]) {
      const h = harness(contract, { request: (url) => {
        if (url === GET) return { data: ready() }
        if (malformed) return { data: { ...observed(), unsafe: 'fixture-private-detail' } }
        throw Object.assign(new Error('fixture-private-detail'), { code: 'UNKNOWN' })
      } })
      h.controller.bind(); await h.controller.refresh(); await h.nodes.get('ifind-report-period-run').click()
      assert.equal(h.calls.length, 2)
      assert.equal(h.nodes.get('ifind-report-period-value').textContent, '—')
      assert.equal(h.nodes.get('ifind-report-period-run').disabled, true)
      assert.doesNotMatch(h.messages.flat().join(' '), /fixture-private-detail/)
    }
  })

  await test('session invalidation discards late result', async () => {
    const pending = deferred()
    const h = harness(contract, { request: (url) => url === POST ? pending.promise : { data: ready() } })
    h.controller.bind(); await h.controller.refresh()
    const running = h.nodes.get('ifind-report-period-run').click()
    h.lifecycle.invalidate()
    assert.equal(h.calls[1][1].signal.aborted, true)
    pending.resolve({ data: observed() }); await running
    assert.equal(h.nodes.get('ifind-report-period-run').disabled, true)
    assert.equal(h.nodes.get('ifind-report-period-value').textContent, '—')
    assert.equal(h.messages.length, 0)
  })

  await test('stale GET cannot overwrite newer status', async () => {
    const older = deferred(); let reads = 0
    const h = harness(contract, { request: () => ++reads === 1 ? older.promise : { data: ready() } })
    const first = h.controller.refresh(); await h.controller.refresh()
    older.resolve({ data: { ...ready(), status: 'unavailable', errorCode: `${PREFIX}UNAVAILABLE` } })
    await first
    assert.equal(h.nodes.get('ifind-report-period-run').disabled, false)
  })

  await test('safe API errors and session/CSRF do not replay', async () => {
    const unsafe = contract.apiFailure(500, { error: '<script>fixture-private-detail</script>' })
    assert.equal(unsafe.retryable, false)
    assert.doesNotMatch(contract.errorMessage(unsafe.code), /fixture-private-detail/)
    for (const code of ['ADMIN_AUTH_REQUIRED', 'ADMIN_CSRF_INVALID']) {
      const h = harness(contract, { request: (url) => {
        if (url === POST) throw Object.assign(new Error('fixture-private-detail'), { code })
        return { data: ready() }
      } })
      h.controller.bind(); await h.controller.refresh(); await h.nodes.get('ifind-report-period-run').click()
      assert.deepEqual(h.errors, [code]); assert.equal(h.calls.length, 2)
      assert.equal(h.nodes.get('ifind-report-period-value').textContent, '—')
    }
  })

  await test('real admin bootstrap sends same-origin CSRF only after confirmation', async () => {
    const nodes = dom(); const calls = []; const confirmations = []
    const calibration = require('../domain/ifind-calibration').createInitialCalibrationResult()
    const window = { KinvestAdmin: admin, KinvestReportPeriod: contract,
      KinvestAuth: { authErrorMessage: () => '会话不可用', classifyApiFailure: () => ({ code: 'UNKNOWN' }) },
      confirm: (m) => { confirmations.push(m); return true }, addEventListener() {} }
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/admin.js'), 'utf8'), {
      window, document: nodes.document,
      async fetch(url, options = {}) {
        calls.push([url, options])
        const replies = {
          '/api/admin/csrf': { csrfToken: 'fixture-csrf' },
          '/api/admin/device-requests': { data: [] }, '/api/admin/devices': { data: [] },
          '/api/admin/audit': { data: { admin: [], device: [] } },
          '/api/admin/ifind/diagnostics': { data: null },
          '/api/admin/ifind/market-cases': { data: { runtimeStatus: 'disabled', cases: [] } },
          '/api/admin/ifind/calibration': { data: calibration }, [GET]: { data: ready() }, [POST]: { data: observed() }
        }
        assert.ok(Object.hasOwn(replies, url), url)
        return { ok: true, status: 200, json: async () => replies[url] }
      }
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls.filter(([url]) => url === GET).length, 1)
    assert.equal(calls.filter(([url]) => url === POST).length, 0)
    await nodes.get('ifind-report-period-run').click()
    const writes = calls.filter(([url]) => url === POST)
    assert.equal(writes.length, 1)
    assert.equal(writes[0][1].headers['x-kinvest-csrf'], 'fixture-csrf')
    assert.equal(writes[0][1].credentials, 'same-origin')
    assert.deepEqual(JSON.parse(writes[0][1].body), {})
    assert.equal(confirmations.length, 1)
    assert.equal(nodes.get('ifind-report-period-value').textContent, '0')
  })

  await test('server and browser agree on strict DTO', () => {
    const backend = require('../domain/ifind-report-period-diagnostic')
    assert.deepEqual(contract.copyResult(backend.createInitialReportPeriodDiagnosticResult()), ready())
    assert.deepEqual(contract.copyResult(backend.copyReportPeriodDiagnosticResult(observed())), observed())
  })

  if (failures.length) throw new AggregateError(failures, failures.map((e) => `${e.testName}: ${e.message}`).join('\n'))
  return { passed: count }
}

module.exports = { run }

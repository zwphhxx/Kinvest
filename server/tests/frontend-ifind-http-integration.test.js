'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Readable } = require('node:stream')
const vm = require('node:vm')

const admin = require('../../public/admin-contract')
const auth = require('../../public/auth-contract')
const { listIfindMarketCases } = require('../domain/ifind-market-cases')
const { createIfindMarketDiagnosticHttpController } = require('../http/ifind-market-diagnostic-http')

const ROOT = path.resolve(__dirname, '../..')
const NOW = Date.UTC(2026, 7, 30, 8)
const US_CASE = 'US_APPLE_AAPL'
const ADMIN_TOKEN = 'A'.repeat(43)
const CSRF_TOKEN = 'C'.repeat(43)
const LIST_URL = '/api/admin/ifind/market-cases'
const FIXTURE_CASE = listIfindMarketCases().find((item) => item.caseId === US_CASE)

function financialPoint(overrides = {}) {
  return {
    indicatorId: 'FIXTURE_REVENUE', metricKey: 'revenue', reportPeriod: '2025FY',
    periodEnd: '2025-09-27', periodType: 'annual', value: 100, availability: 'available',
    currency: 'USD', unit: 'million', disclosureScope: 'consolidated',
    sourceTime: '2025-11-01T12:00:00Z', fetchTime: '2026-08-30T08:00:00Z',
    ...overrides
  }
}

function storedRun(status) {
  const failed = status === 'failed'
  const complete = status === 'complete'
  return {
    runId: `market_run_${'1'.repeat(32)}`, caseId: US_CASE, status,
    quoteStatus: failed ? 'not_run' : 'available',
    financeStatus: complete ? 'available' : (failed ? 'not_run' : 'unavailable'),
    requestCount: failed ? 1 : 3, dataVol: complete ? 2 : null, elapsedMs: 50,
    safeErrorClass: complete ? null : 'API', failureCode: complete ? null : 'IFIND_CLIENT_FAILED',
    vendorErrorCode: null, tokenVersionId: 'v20260830-001', createdAt: NOW - 50,
    leaseExpiresAt: NOW + 30_000, completedAt: NOW,
    quoteSnapshot: failed ? null : {
      listingId: FIXTURE_CASE.listingId, displayCode: FIXTURE_CASE.displayCode,
      latestPrice: 100, previousClose: 99, open: 99, high: 101, low: 98,
      volume: 1000, turnover: 100000, quoteTime: '2026-08-28T16:00:00-04:00',
      tradingStatus: 'closed', currency: 'USD'
    },
    financialPoints: complete ? [financialPoint()] : []
  }
}

// Only the repository/service and authenticated-session dependencies are fixtures.
// Routing, runtime projection, DTO validation and serialization are the real HTTP controller.
function httpFixture({ mode = 'available', outcome = 'complete', initial = null } = {}) {
  let latest = initial
  let runCount = 0
  const service = {
    latest: ({ caseId }) => caseId === US_CASE ? latest : null,
    history: ({ caseId }) => caseId === US_CASE && latest ? [latest] : [],
    quotaStatus: ({ caseId }) => ({
      localDayKey: '2026-08-30', caseAttemptCount: caseId === US_CASE ? runCount : 0,
      globalAttemptCount: runCount, caseRemaining: 5 - (caseId === US_CASE ? runCount : 0),
      globalRemaining: 12 - runCount, cooldownUntil: null, inFlight: false,
      inFlightCaseId: null, inFlightExpiresAt: null
    }),
    async run({ caseId }) {
      assert.equal(caseId, US_CASE)
      runCount += 1
      latest = storedRun(outcome)
      if (outcome === 'failed') return {
        status: 'failed', failureCode: 'IFIND_CLIENT_FAILED', safeErrorClass: 'API',
        stage: 'authentication', vendorErrorCode: null
      }
      return {
        status: outcome, caseId, runId: latest.runId, quoteStatus: latest.quoteStatus,
        financeStatus: latest.financeStatus, requestCount: latest.requestCount,
        ...(outcome === 'partial' ? {
          failureCode: 'IFIND_CLIENT_FAILED', safeErrorClass: 'API',
          stage: 'financial', vendorErrorCode: null
        } : {})
      }
    }
  }
  const controller = createIfindMarketDiagnosticHttpController({
    publicOrigin: 'https://dearmina.cn', trustedProxyAddresses: ['127.0.0.1'],
    now: () => NOW,
    accessRuntime: {
      status: { mode: 'device-approval' },
      adminAuth: {
        authenticate(token) {
          assert.equal(token, ADMIN_TOKEN)
          return { sessionId: 'fixture-session', idleExpiresAt: NOW + 10000, absoluteExpiresAt: NOW + 20000 }
        },
        authenticateMutation(token, csrf) {
          assert.equal(token, ADMIN_TOKEN)
          assert.equal(csrf, CSRF_TOKEN)
          return {
            status: 'authenticated', sessionId: 'fixture-session',
            idleExpiresAt: NOW + 10000, absoluteExpiresAt: NOW + 20000
          }
        }
      }
    },
    ifindDiagnosticRuntime: mode === 'disabled' ? { status: { mode: 'disabled' } } : {
      status: { mode: 'admin-diagnostic', configured: true, versionId: 'v20260830-001' },
      ...(mode === 'available' ? { marketService: service } : {})
    }
  })
  return {
    runCount: () => runCount,
    async request(url, options = {}) {
      const method = options.method || 'GET'
      const body = options.body === undefined ? '' : JSON.stringify(options.body)
      const headers = {
        cookie: `__Host-kinvest-admin=${ADMIN_TOKEN}`,
        origin: 'https://dearmina.cn', 'x-real-ip': '203.0.113.20',
        'x-forwarded-for': '203.0.113.20',
        ...(method === 'POST' ? {
          'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)),
          'x-kinvest-csrf': CSRF_TOKEN
        } : {})
      }
      const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
        method, url, headers, rawHeaders: Object.entries(headers).flat(),
        socket: { remoteAddress: '127.0.0.1' }
      })
      let statusCode = 0
      /** @type {any} JSON decoded at the real HTTP serialization boundary. */
      let payload
      const responseHeaders = new Map()
      const res = {
        getHeader: (name) => responseHeaders.get(name),
        setHeader: (name, value) => responseHeaders.set(name, value),
        writeHead(status) { statusCode = status },
        end(text) { payload = JSON.parse(text) }
      }
      assert.equal(await controller.handle(req, res, url.split('/').filter(Boolean)), true)
      assert.equal(statusCode, 200, `real HTTP response: ${JSON.stringify(payload)}`)
      return payload
    }
  }
}

class Element {
  constructor(id = '') {
    this.id = id
    this.textContent = ''
    this.disabled = false
    this.value = ''
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
  addEventListener(name, handler) { this.listeners.set(name, handler) }
  append(...nodes) { this.children.push(...nodes) }
  appendChild(node) { this.children.push(node) }
  replaceChildren(...nodes) { this.children = nodes }
  focus() {}
}

function dom() {
  const html = fs.readFileSync(path.join(ROOT, 'public/admin.html'), 'utf8')
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)]
    .map((match) => [match[1], new Element(match[1])]))
  return {
    get: (id) => elements.get(id),
    document: {
      getElementById: (id) => elements.get(id) || null,
      createElement: () => new Element(), querySelectorAll: () => []
    }
  }
}

/** @param {(message: string, tone: string) => void} [setLive] */
function uiController(document, request, setLive = () => {}) {
  const lifecycle = admin.createAdminSessionLifecycle()
  lifecycle.activate()
  return admin.createIfindMarketDiagnosticController({
    document, request, sessionLifecycle: lifecycle, dateText: String, now: () => NOW,
    setLive, onError: async (error) => { throw error }
  })
}

async function runtimeDtoTest() {
  for (const [mode, label] of [
    ['available', '固定案例已就绪'], ['disabled', '三市场诊断未启用'],
    ['unavailable', '三市场诊断状态不可用']
  ]) {
    const fixture = httpFixture({ mode })
    const nodes = dom()
    const controller = uiController(nodes.document, fixture.request)
    const response = await fixture.request(LIST_URL)
    assert.equal(response.data.runtimeStatus, mode)
    await controller.refresh()
    assert.equal(nodes.get('ifind-market-status').textContent, label)
    assert.equal(fixture.runCount(), 0, 'reads never cause a provider call')
    if (mode === 'available') {
      assert.equal(nodes.get('ifind-market-us-run').textContent, '指标尚未核验')
      assert.equal(nodes.get('ifind-market-us-run').disabled, true)
    }
  }
}

async function currencyDtoTest() {
  const fixture = httpFixture({ initial: storedRun('complete') })
  const response = await fixture.request(LIST_URL)
  const nodes = dom()
  const controller = uiController(nodes.document, fixture.request)
  await controller.refresh()
  assert.equal(nodes.get('ifind-market-us-trading-currency')?.textContent, 'USD')
  assert.equal(nodes.get('ifind-market-us-reporting-currency')?.textContent, 'USD')
  assert.equal(nodes.get('ifind-market-hk-trading-currency').textContent, '—',
    'an expected market currency is not observed quote evidence')
  assert.equal(nodes.get('ifind-market-hk-reporting-currency').textContent, '—')

  // View-only edge case: a HKD quote and CNY disclosures must stay distinct.
  // This does not fabricate a successful provider call or override the HTTP contract.
  const cases = response.data.cases.map((entry) => entry.case.caseId === 'HK_ALIBABA_9988'
    ? {
        ...entry,
        latest: {
          ...response.data.cases.find((item) => item.case.caseId === US_CASE).latest,
          quote: { currency: 'HKD' },
          financial: [{ currency: 'CNY' }, {}]
        }
      }
    : entry)
  controller.render({ ...response.data, cases })
  assert.equal(nodes.get('ifind-market-hk-trading-currency').textContent, 'HKD')
  assert.equal(nodes.get('ifind-market-hk-reporting-currency').textContent, 'CNY · 未提供')
}

async function outcomeDtoTest() {
  for (const [status, label, message, tone] of [
    ['complete', '完整完成', '固定市场案例诊断已完成。', 'success'],
    ['partial', '部分完成', '固定市场案例诊断部分完成，请查看缺失字段与安全错误。', 'warning'],
    ['failed', '执行失败', '固定市场案例诊断失败，请查看安全错误后重试。', 'error']
  ]) {
    const fixture = httpFixture({ outcome: status })
    const nodes = dom()
    const messages = []
    const controller = uiController(nodes.document, fixture.request,
      (text, nextTone) => messages.push([text, nextTone]))
    const response = await fixture.request(LIST_URL)
    // Seed only frontend readiness to exercise a future verified catalog's button.
    // Every network response is produced by the real controller, unchanged. The
    // production catalog stays unverified and the runtime is entirely local fixtures.
    controller.render({ ...response.data, cases: response.data.cases.map((entry) => ({
      ...entry, case: { ...entry.case, liveReady: true }
    })) })
    const pending = controller.run(US_CASE)
    assert.equal(nodes.get('ifind-market-us-run-status')?.textContent, '正在运行')
    await pending
    assert.equal(fixture.runCount(), 1)
    assert.deepEqual(messages.at(-1), [message, tone])
    assert.equal(nodes.get('ifind-market-us-run-status').textContent, label)
    assert.equal(nodes.get('ifind-market-us-run-status').dataset.tone, tone)
    await controller.refresh()
    assert.equal(nodes.get('ifind-market-us-run-status').textContent, label)
    const restoredNodes = dom()
    await uiController(restoredNodes.document, fixture.request).refresh()
    assert.equal(restoredNodes.get('ifind-market-us-run-status').textContent, label,
      'run status survives a new controller/session view')
  }
}

async function bootstrapTest() {
  const script = fs.readFileSync(path.join(ROOT, 'public/admin.js'), 'utf8')
  for (const failLists of [false, true]) {
    const nodes = dom()
    let finishRestore = () => {}
    const restoration = new Promise((resolve) => { finishRestore = () => resolve(undefined) })
    const window = { KinvestAdmin: admin, KinvestAuth: auth, addEventListener() {} }
    vm.runInNewContext(script, {
      window, document: nodes.document,
      async fetch(url) {
        if (url === '/api/admin/csrf') await restoration
        if (failLists && url === '/api/admin/devices') return {
          ok: false, status: 503, json: async () => ({ error: 'UNKNOWN' })
        }
        const replies = {
          '/api/admin/csrf': { csrfToken: 'local-bootstrap-fixture' },
          '/api/admin/device-requests': { data: [] },
          '/api/admin/devices': { data: [] },
          '/api/admin/audit': { data: { admin: [], device: [] } },
          '/api/admin/ifind/diagnostics': { data: null },
          [LIST_URL]: { data: { runtimeStatus: 'disabled', cases: [] } }
        }
        assert.ok(Object.hasOwn(replies, url), 'no unexpected or real endpoint')
        return { ok: true, status: 200, json: async () => replies[url] }
      }
    })
    assert.equal(nodes.get('admin-live').textContent, '正在检查管理员会话，请稍候。')
    finishRestore()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(nodes.get('admin-desk').classList.contains('hidden'), false)
    if (failLists) {
      assert.notEqual(nodes.get('admin-live').textContent, '')
      assert.equal(nodes.get('admin-live').dataset.tone, 'error')
    } else {
      assert.equal(nodes.get('admin-live').textContent, '')
      assert.equal(nodes.get('admin-live').dataset.tone, '')
    }
    assert.doesNotMatch(nodes.get('admin-live').textContent, /正在检查/)
  }
}

async function run() {
  const failures = []
  for (const [name, test] of Object.entries({ runtimeDtoTest, currencyDtoTest, outcomeDtoTest, bootstrapTest })) {
    try { await test() } catch (error) {
      error.message = `${name}: ${error.message}`
      failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, 'frontend HTTP and bootstrap regressions')
}

module.exports = { run }

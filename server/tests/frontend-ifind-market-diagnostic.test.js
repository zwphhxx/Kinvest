'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const adminContract = require('../../public/admin-contract')

const ROOT = path.resolve(__dirname, '..', '..')
const NOW = Date.parse('2026-08-30T08:00:00Z')

const PRESENTATIONS = Object.freeze({
  HK_ALIBABA_9988: Object.freeze({
    caseId: 'HK_ALIBABA_9988', companyName: 'Alibaba Group',
    issuerLegalName: 'Alibaba Group Holding Limited', exchange: 'HKEX',
    displayCode: '9988.HK', expectedTradingCurrency: 'HKD',
    marketTimeZone: 'Asia/Hong_Kong', liveReady: true
  }),
  US_APPLE_AAPL: Object.freeze({
    caseId: 'US_APPLE_AAPL', companyName: 'Apple',
    issuerLegalName: 'Apple Inc.', exchange: 'NASDAQ',
    displayCode: 'AAPL.US', expectedTradingCurrency: 'USD',
    marketTimeZone: 'America/New_York', liveReady: true
  }),
  CN_MOUTAI_600519: Object.freeze({
    caseId: 'CN_MOUTAI_600519', companyName: 'Kweichow Moutai',
    issuerLegalName: 'Kweichow Moutai Co., Ltd.', exchange: 'SSE',
    displayCode: '600519.SH', expectedTradingCurrency: 'CNY',
    marketTimeZone: 'Asia/Shanghai', liveReady: true
  })
})

function marketCase(caseId, overrides = {}) {
  const currency = PRESENTATIONS[caseId].expectedTradingCurrency
  return {
    case: PRESENTATIONS[caseId],
    latest: {
      status: 'complete', quoteStatus: 'available', financeStatus: 'available',
      requestCount: 3, dataVol: 42, elapsedMs: 75, safeErrorClass: null,
      createdAt: NOW - 75, completedAt: NOW,
      quote: {
        displayCode: PRESENTATIONS[caseId].displayCode, latestPrice: 100.25,
        previousClose: 99.5, open: 99.75, high: 101, low: 98.5,
        volume: 123456, turnover: 987654.5,
        quoteTime: '2026-08-30T15:59:00+08:00', tradingStatus: 'trading', currency
      },
      financial: [
        {
          metricKey: 'revenue', reportPeriod: '2025FY', periodEnd: '2025-12-31',
          periodType: 'annual', value: 1234.5, availability: 'available', currency,
          unit: 'million', disclosureScope: 'consolidated',
          sourceTime: '2026-03-01T08:00:00+08:00',
          fetchTime: '2026-08-30T16:00:00+08:00'
        },
        {
          metricKey: 'gross_profit', reportPeriod: '2026H1', periodEnd: '2026-06-30',
          periodType: 'interim', value: null, availability: 'missing', currency,
          unit: 'million', disclosureScope: 'consolidated',
          sourceTime: '2026-08-20T08:00:00+08:00',
          fetchTime: '2026-08-30T16:00:00+08:00'
        }
      ]
    },
    quota: {
      officialStatus: 'unavailable', localStatus: 'available', localDayKey: '2026-08-30',
      caseAttemptCount: 2, globalAttemptCount: 4, caseRemaining: 3, globalRemaining: 8,
      cooldownUntil: null, inFlight: false, inFlightExpiresAt: null
    },
    ...overrides
  }
}

function payload(overrides = {}) {
  return {
    runtimeStatus: 'admin-diagnostic',
    cases: [
      marketCase('CN_MOUTAI_600519'),
      marketCase('HK_ALIBABA_9988'),
      marketCase('US_APPLE_AAPL')
    ],
    ...overrides
  }
}

class FakeElement {
  constructor(id) {
    this.id = id
    this._textContent = ''
    this.disabled = false
    this.dataset = {}
    this.attributes = new Map()
    this.listeners = new Map()
    this.innerHtmlWrites = 0
  }

  get textContent() { return this._textContent }
  set textContent(value) { this._textContent = String(value) }
  set innerHTML(_value) { this.innerHtmlWrites += 1 }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  addEventListener(name, handler) { this.listeners.set(name, handler) }
  click() {
    const handler = this.listeners.get('click')
    return handler ? handler({ preventDefault() {} }) : undefined
  }
}

const CARD_KEYS = ['hk', 'us', 'cn']
const CARD_FIELDS = [
  'company', 'code', 'last-run', 'cooldown', 'daily', 'price', 'quote-time',
  'trading-status', 'currency', 'units', 'periods', 'validation', 'missing',
  'error', 'run'
]

function diagnosticDom() {
  const ids = ['ifind-market-status', 'ifind-market-note']
  for (const key of CARD_KEYS) {
    for (const field of CARD_FIELDS) ids.push(`ifind-market-${key}-${field}`)
  }
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement(id)]))
  return {
    elements,
    document: { getElementById: (id) => elements[id] || null }
  }
}

function deferred() {
  /** @type {(value: any) => void} */
  let resolve = () => {}
  /** @type {(reason: any) => void} */
  let reject = () => {}
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function controlledClock(start) {
  let now = start
  let nextId = 1
  const timers = new Map()
  const cleared = []
  return {
    now: () => now,
    pending: () => timers.size,
    cleared,
    setTimeout(callback, delay) {
      const id = nextId
      nextId += 1
      timers.set(id, { callback, dueAt: now + delay })
      return id
    },
    clearTimeout(id) {
      if (timers.delete(id)) cleared.push(id)
    },
    async advance(milliseconds) {
      now += milliseconds
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= now)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)
      for (const [id, timer] of due) {
        timers.delete(id)
        await timer.callback()
      }
    }
  }
}

async function run() {
  assert.equal(typeof adminContract.createIfindMarketDiagnosticView, 'function')
  assert.equal(typeof adminContract.createIfindMarketDiagnosticController, 'function')

  const view = adminContract.createIfindMarketDiagnosticView(payload(), {
    now: NOW,
    dateText: (value) => `date:${value}`
  })
  assert.deepEqual(view.cards.map((card) => card.caseId), [
    'HK_ALIBABA_9988', 'US_APPLE_AAPL', 'CN_MOUTAI_600519'
  ])
  assert.deepEqual(view.cards.map((card) => card.marketLabel), ['港股', '美股', 'A 股'])
  assert.equal(view.cards[0].lastRun, `date:${NOW}`)
  assert.equal(view.cards[0].cooldown, '可运行')
  assert.equal(view.cards[0].dailyAllowance, '个案 3 / 5 · 全局 8 / 12')
  assert.equal(view.cards[0].quoteTime, '2026-08-30T15:59:00+08:00')
  assert.equal(view.cards[0].tradingStatus, '交易中')
  assert.equal(view.cards[0].currency, 'HKD')
  assert.equal(view.cards[0].units, 'million')
  assert.equal(view.cards[0].periods, '2025FY · 2026H1')
  assert.equal(view.cards[0].validation, '行情 已验证 · 财务 已验证')
  assert.equal(view.cards[0].missingFields, 'gross_profit / 2026H1')
  assert.equal(view.cards[0].safeError, '无')

  const runningView = adminContract.createIfindMarketDiagnosticView(payload(), {
    now: NOW,
    dateText: String,
    runningCaseId: 'US_APPLE_AAPL'
  })
  assert.equal(runningView.cards.every((card) => card.run.disabled), true)
  assert.deepEqual(runningView.cards.map((card) => card.run.label), [
    '等待当前诊断', '正在运行…', '等待当前诊断'
  ])

  /** @type {Array<[number, string, string]>} */
  const actualApiErrors = [
    [429, 'IFIND_MARKET_CASE_DAILY_LIMIT', '此案例今日诊断次数已达上限。'],
    [429, 'IFIND_MARKET_GLOBAL_DAILY_LIMIT', '今日三市场诊断总次数已达上限。'],
    [409, 'IFIND_MARKET_CASE_UNAVAILABLE', '此固定案例尚未完成指标核验。'],
    [409, 'IFIND_MARKET_DIAGNOSTIC_BUSY', '另一项市场诊断正在运行。'],
    [429, 'IFIND_MARKET_DIAGNOSTIC_COOLDOWN', '此案例正在冷却，请稍后重试。']
  ]
  for (const [status, code, message] of actualApiErrors) {
    assert.deepEqual(
      adminContract.ifindMarketDiagnosticApiFailure(status, { error: code }),
      { code, message, retryable: status >= 500 || code === 'IFIND_MARKET_DIAGNOSTIC_BUSY' ||
        code === 'IFIND_MARKET_DIAGNOSTIC_COOLDOWN' }
    )
  }
  assert.equal(
    adminContract.ifindMarketDiagnosticApiFailure(429, {
      error: 'IFIND_MARKET_DIAGNOSTIC_DAILY_LIMIT'
    }).code,
    'UNKNOWN'
  )

  const disabledView = adminContract.createIfindMarketDiagnosticView(payload({
    runtimeStatus: 'disabled'
  }), { now: NOW, dateText: String })
  assert.equal(disabledView.statusLabel, '三市场诊断未启用')
  assert.equal(disabledView.cards[0].run.label, '诊断未启用')
  assert.match(disabledView.note, /后端未启用/)
  const unavailableView = adminContract.createIfindMarketDiagnosticView(payload({
    runtimeStatus: 'unavailable'
  }), { now: NOW, dateText: String })
  assert.equal(unavailableView.statusLabel, '三市场诊断状态不可用')
  assert.equal(unavailableView.cards[0].run.label, '状态不可用')
  assert.match(unavailableView.note, /无法确认/)
  assert.notEqual(disabledView.note, unavailableView.note)

  const dom = diagnosticDom()
  const calls = []
  /** @type {(value: any) => void} */
  let resolveRun = () => {}
  const runPending = new Promise((resolve) => { resolveRun = resolve })
  let listReads = 0
  const lifecycle = {
    beginRequest() { return { signal: new AbortController().signal } },
    commit(_ticket, callback) { return callback() },
    finishRequest() {}
  }
  const controller = adminContract.createIfindMarketDiagnosticController({
    document: dom.document,
    sessionLifecycle: lifecycle,
    dateText: (value) => `date:${value}`,
    now: () => NOW,
    setLive() {},
    onError: async () => {},
    async request(path, options = {}) {
      calls.push([path, options.method || 'GET'])
      if (options.method === 'POST') return runPending
      listReads += 1
      const next = payload()
      next.cases[1].quota.caseRemaining = listReads === 1 ? 3 : 2
      return { data: next }
    }
  })
  controller.bind()
  await controller.refresh()
  assert.equal(dom.elements['ifind-market-hk-daily'].textContent, '个案 3 / 5 · 全局 8 / 12')
  const runPromise = dom.elements['ifind-market-hk-run'].click()
  assert.equal(dom.elements['ifind-market-hk-run'].disabled, true)
  assert.equal(dom.elements['ifind-market-us-run'].disabled, true)
  assert.equal(dom.elements['ifind-market-cn-run'].disabled, true)
  assert.equal(dom.elements['ifind-market-hk-run'].textContent, '正在运行…')
  resolveRun({ data: { status: 'complete' } })
  await runPromise
  assert.deepEqual(calls, [
    ['/api/admin/ifind/market-cases', 'GET'],
    ['/api/admin/ifind/market-cases/HK_ALIBABA_9988/run', 'POST'],
    ['/api/admin/ifind/market-cases', 'GET']
  ])
  assert.equal(dom.elements['ifind-market-hk-daily'].textContent, '个案 2 / 5 · 全局 8 / 12')
  assert.equal(
    Object.values(dom.elements).every((element) => element.innerHtmlWrites === 0),
    true
  )

  const timerClock = controlledClock(NOW)
  const timerDom = diagnosticDom()
  const timerLifecycle = adminContract.createAdminSessionLifecycle()
  timerLifecycle.activate()
  let timerReads = 0
  const coolingPayload = payload()
  coolingPayload.cases[1].quota.cooldownUntil = NOW + 5_000
  const readyPayload = payload()
  const timerController = adminContract.createIfindMarketDiagnosticController({
    document: timerDom.document,
    sessionLifecycle: timerLifecycle,
    dateText: (value) => `date:${value}`,
    now: timerClock.now,
    setTimeout: timerClock.setTimeout,
    clearTimeout: timerClock.clearTimeout,
    setLive() {},
    onError: async () => {},
    async request() {
      timerReads += 1
      return { data: readyPayload }
    }
  })
  timerController.render(coolingPayload)
  assert.equal(timerDom.elements['ifind-market-hk-run'].disabled, true)
  assert.equal(timerDom.elements['ifind-market-hk-run'].textContent, '冷却中')
  assert.equal(timerClock.pending(), 1)
  await timerClock.advance(5_000)
  assert.equal(timerReads, 1)
  assert.equal(timerDom.elements['ifind-market-hk-run'].disabled, false)
  assert.equal(timerDom.elements['ifind-market-hk-run'].textContent, '运行此案例')
  assert.equal(timerClock.pending(), 0)

  coolingPayload.cases[1].quota.cooldownUntil = NOW + 10_000
  timerController.render(coolingPayload)
  assert.equal(timerClock.pending(), 1)
  timerController.reset()
  assert.equal(timerClock.pending(), 0)
  assert.ok(timerClock.cleared.length >= 1)

  const invalidationClock = controlledClock(NOW)
  const invalidationDom = diagnosticDom()
  const invalidationLifecycle = adminContract.createAdminSessionLifecycle()
  invalidationLifecycle.activate()
  const invalidationController = adminContract.createIfindMarketDiagnosticController({
    document: invalidationDom.document,
    sessionLifecycle: invalidationLifecycle,
    dateText: String,
    now: invalidationClock.now,
    setTimeout: invalidationClock.setTimeout,
    clearTimeout: invalidationClock.clearTimeout,
    setLive() {},
    onError: async () => {},
    request: async () => ({ data: readyPayload })
  })
  invalidationController.render(coolingPayload)
  assert.equal(invalidationClock.pending(), 1)
  invalidationLifecycle.invalidate()
  assert.equal(invalidationClock.pending(), 0)

  const staleDom = diagnosticDom()
  const staleLifecycle = adminContract.createAdminSessionLifecycle()
  staleLifecycle.activate()
  const firstRead = deferred()
  const secondRead = deferred()
  let staleReads = 0
  const staleController = adminContract.createIfindMarketDiagnosticController({
    document: staleDom.document,
    sessionLifecycle: staleLifecycle,
    dateText: String,
    now: () => NOW,
    setLive() {},
    onError: async () => {},
    request() {
      staleReads += 1
      return staleReads === 1 ? firstRead.promise : secondRead.promise
    }
  })
  const olderRefresh = staleController.refresh()
  const newerRefresh = staleController.refresh()
  const newerPayload = payload()
  newerPayload.cases[1].quota.caseRemaining = 1
  secondRead.resolve({ data: newerPayload })
  await newerRefresh
  const olderPayload = payload()
  olderPayload.cases[1].quota.caseRemaining = 4
  firstRead.resolve({ data: olderPayload })
  await olderRefresh
  assert.equal(staleDom.elements['ifind-market-hk-daily'].textContent,
    '个案 1 / 5 · 全局 8 / 12')

  const expiredDom = diagnosticDom()
  const expiredLifecycle = adminContract.createAdminSessionLifecycle()
  expiredLifecycle.activate()
  let expiredErrors = 0
  const expiredController = adminContract.createIfindMarketDiagnosticController({
    document: expiredDom.document,
    sessionLifecycle: expiredLifecycle,
    dateText: String,
    now: () => NOW,
    setLive() {},
    onError: async (error) => {
      assert.equal(error.code, 'ADMIN_AUTH_REQUIRED')
      expiredErrors += 1
      expiredLifecycle.invalidate()
    },
    request: async () => {
      throw Object.assign(new Error('expired'), { code: 'ADMIN_AUTH_REQUIRED' })
    }
  })
  await expiredController.refresh()
  assert.equal(expiredErrors, 1)

  const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8')
  const script = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8')
  assert.equal((html.match(/class="ifind-market-card"/g) || []).length, 3)
  assert.ok(html.indexOf('ifind-market-hk-card') < html.indexOf('ifind-market-us-card'))
  assert.ok(html.indexOf('ifind-market-us-card') < html.indexOf('ifind-market-cn-card'))
  assert.match(html, /管理员诊断专用/)
  assert.match(html, /家庭看板继续使用 Mock/)
  assert.doesNotMatch(html, /运行全部|run-all|name="(?:securityCode|endpoint|indicatorId)"/i)
  assert.doesNotMatch(script, /[.]innerHTML\s*=/)
}

module.exports = { run }

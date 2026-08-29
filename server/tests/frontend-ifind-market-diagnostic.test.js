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

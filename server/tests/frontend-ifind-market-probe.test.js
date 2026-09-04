'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const marketProbe = require('../../public/admin-market-probe-contract')

const ROOT = path.resolve(__dirname, '../..')
const STATUS_PATH = '/api/admin/ifind/market-probes/HK_ALIBABA_9988_V1'
const RUN_PATH = `${STATUS_PATH}/run`
const VERIFICATION_IDS = [
  'issuer-identity', 'vendor-code', 'entitlement', 'currency', 'unit', 'report-period', 'scope'
]

function readyResult(overrides = {}) {
  return {
    proposalId: 'HK_ALIBABA_9988_V1',
    caseId: 'HK_ALIBABA_9988',
    displayCode: '9988.HK',
    status: 'ready',
    verification: {
      issuerIdentityStatus: 'unverified', vendorCodeStatus: 'unverified',
      entitlementStatus: 'unverified', currencyStatus: 'unverified', unitStatus: 'unverified',
      reportPeriodStatus: 'unverified', scopeStatus: 'unverified'
    },
    observations: { identity: null, quote: null, financial: null },
    requestCount: 0,
    businessRequestCount: 0,
    dataVol: null,
    attemptedAt: null,
    errorCode: null,
    failureStage: null,
    ...overrides
  }
}

function observedResult() {
  return readyResult({
    status: 'observed-unverified',
    observations: {
      identity: { returnedCode: '9988.HK', fields: { ths_stock_short_name_stock: ['阿里巴巴-W'] } },
      quote: { returnedCode: '9988.HK', fields: {
        latest: [118.4], preClose: [116.8], open: [117], high: [119], low: [116.5],
        amount: [1200000], volume: [10000], tradeDate: ['2026-09-02'], tradeTime: ['16:08:00']
      } },
      financial: { returnedCode: '9988.HK', fields: { revenue_oas: [243380000000] } }
    },
    requestCount: 4,
    businessRequestCount: 3,
    dataVol: 3,
    attemptedAt: '2026-09-02T08:08:00.000Z',
    errorCode: 'IFIND_MARKET_PROBE_OBSERVED_UNVERIFIED'
  })
}

function failedResult(status) {
  if (status === 'cooldown' || status === 'daily-limit') return readyResult({ status })
  if (status === 'unavailable') return readyResult({
    status, errorCode: 'IFIND_MARKET_PROBE_UNAVAILABLE', failureStage: 'provider'
  })
  return readyResult({
    status: 'failed', requestCount: 1, attemptedAt: '2026-09-02T08:08:00.000Z',
    errorCode: 'IFIND_MARKET_PROBE_FAILED', failureStage: 'auth'
  })
}

class Element {
  constructor(id = '') {
    this.id = id
    this.textContent = ''
    this.disabled = false
    this.dataset = {}
    this.attributes = new Map()
    this.listeners = new Map()
  }

  get innerHTML() { throw new Error('INNER_HTML_READ_FORBIDDEN') }
  set innerHTML(_value) { throw new Error('INNER_HTML_WRITE_FORBIDDEN') }
  setAttribute(key, value) { this.attributes.set(key, String(value)) }
  addEventListener(name, handler) { this.listeners.set(name, handler) }
  async click() {
    const handler = this.listeners.get('click')
    if (handler) return handler({ preventDefault() {} })
  }
}

function documentFixture() {
  const ids = [
    'ifind-market-probe-status', 'ifind-market-probe-proposal', 'ifind-market-probe-code',
    'ifind-market-probe-attempted-at', 'ifind-market-probe-request-count',
    'ifind-market-probe-business-request-count', 'ifind-market-probe-data-vol',
    'ifind-market-probe-quota', 'ifind-market-probe-identity', 'ifind-market-probe-quote',
    'ifind-market-probe-financial', 'ifind-market-probe-error', 'ifind-market-probe-run',
    ...VERIFICATION_IDS.map((name) => `ifind-market-probe-${name}`)
  ]
  const elements = new Map(ids.map((id) => [id, new Element(id)]))
  return {
    get: (id) => elements.get(id),
    document: { getElementById: (id) => elements.get(id) || null }
  }
}

function lifecycle() {
  let epoch = 1
  let active = true
  return {
    activate() { active = true; epoch += 1 },
    invalidate() { active = false; epoch += 1 },
    beginRequest() { return { epoch, signal: new AbortController().signal } },
    commit(ticket, operation) {
      if (!active || ticket.epoch !== epoch) throw new Error('ADMIN_EPOCH_STALE')
      return operation()
    },
    finishRequest() {}
  }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function controllerFixture({ responses = [readyResult()], confirm = () => true } = {}) {
  const nodes = documentFixture()
  const sessionLifecycle = lifecycle()
  const calls = []
  const errors = []
  const live = []
  let index = 0
  const controller = marketProbe.createController({
    document: nodes.document,
    sessionLifecycle,
    request: async (url, options = {}) => {
      calls.push({ url, options })
      const next = responses[Math.min(index, responses.length - 1)]
      index += 1
      return { data: await next }
    },
    dateText: (value) => `DATE:${value}`,
    confirm,
    setLive: (message, tone) => { live.push({ message, tone }) },
    onError: async (error) => { errors.push(error) }
  })
  controller.bind()
  return { ...nodes, controller, calls, errors, live, sessionLifecycle }
}

async function moduleSurfaceTest() {
  assert.deepEqual(Object.keys(marketProbe).sort(), ['apiFailure', 'createController', 'errorMessage'])
  assert.equal(Object.isFrozen(marketProbe), true)
  const source = fs.readFileSync(path.join(ROOT, 'public/admin-market-probe-contract.js'), 'utf8')
  assert.doesNotMatch(source, /localStorage|sessionStorage|innerHTML/)
  const adminSource = fs.readFileSync(path.join(ROOT, 'public/admin.js'), 'utf8')
  assert.match(adminSource,
    /if \(path\.startsWith\('\/api\/admin\/ifind\/market-probes\/'\) && marketProbeContracts\) throw failure/,
    'the locally branded API failure must reach its controller without object spreading')
}

async function offlineRefreshAndRenderTest() {
  const value = observedResult()
  const fixture = controllerFixture({ responses: [value] })
  await fixture.controller.refresh()
  assert.deepEqual(fixture.calls.map(({ url, options }) => [url, options.method || 'GET']), [
    [STATUS_PATH, 'GET']
  ])
  assert.equal(fixture.get('ifind-market-probe-proposal').textContent, 'HK_ALIBABA_9988_V1')
  assert.equal(fixture.get('ifind-market-probe-code').textContent, '9988.HK')
  assert.match(fixture.get('ifind-market-probe-identity').textContent, /阿里巴巴-W/)
  assert.match(fixture.get('ifind-market-probe-quote').textContent, /118\.4/)
  assert.match(fixture.get('ifind-market-probe-financial').textContent, /243380000000/)
  for (const name of VERIFICATION_IDS) {
    const node = fixture.get(`ifind-market-probe-${name}`)
    assert.equal(node.textContent, '未验证')
    assert.equal(node.dataset.evidenceStatus, 'unverified')
  }
  assert.doesNotMatch(fixture.get('ifind-market-probe-quota').textContent, /剩余|\d+\s*次/)
}

async function confirmationAndSingleFlightTest() {
  const gate = deferred()
  const confirmations = []
  const fixture = controllerFixture({
    responses: [readyResult(), gate.promise, observedResult()],
    confirm: (message) => { confirmations.push(message); return true }
  })
  await fixture.controller.refresh()
  const first = fixture.get('ifind-market-probe-run').click()
  const second = fixture.get('ifind-market-probe-run').click()
  assert.equal(confirmations.length, 1)
  assert.match(confirmations[0], /1 次认证 \+ 3 次业务请求/)
  assert.match(confirmations[0], /0 次重试/)
  assert.deepEqual(fixture.calls.map(({ url }) => url), [STATUS_PATH, RUN_PATH])
  assert.equal(fixture.get('ifind-market-probe-run').disabled, true)
  gate.resolve(observedResult())
  await Promise.all([first, second])
  assert.deepEqual(fixture.calls.map(({ url }) => url), [STATUS_PATH, RUN_PATH, STATUS_PATH])
  assert.deepEqual(fixture.calls[1].options, {
    method: 'POST', body: {}, csrf: true, signal: fixture.calls[1].options.signal
  })
}

async function runOutcomeMessagingTest() {
  const cases = [
    ['observed-unverified', observedResult(), 'success', /探针已完成/],
    ['failed', failedResult('failed'), 'error', /未完成/],
    ['unavailable', failedResult('unavailable'), 'error', /暂时不可用/],
    ['cooldown', failedResult('cooldown'), 'warning', /冷却/],
    ['daily-limit', failedResult('daily-limit'), 'warning', /上限/]
  ]
  for (const [name, result, tone, message] of cases) {
    const fixture = controllerFixture({ responses: [readyResult(), result, result] })
    await fixture.controller.refresh()
    await fixture.get('ifind-market-probe-run').click()
    assert.equal(fixture.live.length, 1, name)
    assert.equal(fixture.live[0].tone, tone, name)
    assert.match(fixture.live[0].message, message, name)
    if (name !== 'observed-unverified') {
      assert.doesNotMatch(fixture.live[0].message, /探针已完成/, name)
    }
  }
}

async function trustedResultSurvivesTransportAndApiFailureTest() {
  const failures = [
    [new Error('SENSITIVE_NETWORK_DETAIL'), 'IFIND_MARKET_PROBE_UNAVAILABLE'],
    [marketProbe.apiFailure(503, { error: 'IFIND_MARKET_PROBE_FAILED' }),
      'IFIND_MARKET_PROBE_FAILED']
  ]
  for (const [failure, expectedCode] of failures) {
    const fixture = controllerFixture({ responses: [observedResult(), Promise.reject(failure)] })
    await fixture.controller.refresh()
    const trustedIdentity = fixture.get('ifind-market-probe-identity').textContent
    await fixture.controller.refresh()
    assert.equal(fixture.get('ifind-market-probe-identity').textContent, trustedIdentity)
    assert.equal(fixture.get('ifind-market-probe-status').textContent, '已观察，均未验证')
    assert.equal(fixture.errors.length, 1)
    assert.equal(fixture.errors[0].code, expectedCode)
    assert.equal(fixture.errors[0].message, expectedCode)
    assert.deepEqual(Object.keys(fixture.errors[0]), ['code'])
    assert.doesNotMatch(JSON.stringify(fixture.errors[0]), /SENSITIVE/)
  }
}

async function hostileRejectionIsNeverInspectedTest() {
  const scenarios = [
    (trapped) => Object.defineProperties({}, {
      name: { get() { trapped(); throw new Error('SENSITIVE_NAME') } },
      message: { get() { trapped(); throw new Error('SENSITIVE_MESSAGE') } },
      code: { get() { trapped(); throw new Error('SENSITIVE_CODE') } }
    }),
    (trapped) => new Proxy({}, {
      get() { trapped(); throw new Error('SENSITIVE_GET') },
      getOwnPropertyDescriptor() { trapped(); throw new Error('SENSITIVE_DESCRIPTOR') },
      ownKeys() { trapped(); throw new Error('SENSITIVE_KEYS') },
      getPrototypeOf() { trapped(); throw new Error('SENSITIVE_PROTOTYPE') }
    })
  ]
  for (const create of scenarios) {
    let traps = 0
    const hostile = create(() => { traps += 1 })
    const fixture = controllerFixture({ responses: [Promise.reject(hostile)] })
    await fixture.controller.refresh()
    assert.equal(traps, 0)
    assert.equal(fixture.errors.length, 1)
    assert.equal(fixture.errors[0].code, 'IFIND_MARKET_PROBE_UNAVAILABLE')
    assert.equal(fixture.errors[0].message, 'IFIND_MARKET_PROBE_UNAVAILABLE')
    assert.deepEqual(Object.keys(fixture.errors[0]), ['code'])
  }
}

async function failedRefreshPreservesReadyButDisablesRunTest() {
  const fixture = controllerFixture({ responses: [
    readyResult(), Promise.reject(new Error('SENSITIVE_NETWORK_DETAIL')),
    readyResult(), observedResult(), observedResult()
  ] })
  await fixture.controller.refresh()
  assert.equal(fixture.get('ifind-market-probe-run').disabled, false)
  await fixture.controller.refresh()
  assert.equal(fixture.get('ifind-market-probe-status').textContent, '可以手工运行')
  assert.equal(fixture.get('ifind-market-probe-proposal').textContent, 'HK_ALIBABA_9988_V1')
  assert.equal(fixture.get('ifind-market-probe-run').disabled, true)
  await fixture.get('ifind-market-probe-run').click()
  assert.deepEqual(fixture.calls.map(({ url }) => url), [STATUS_PATH, STATUS_PATH],
    'stale ready state must not permit a POST')

  await fixture.controller.refresh()
  assert.equal(fixture.get('ifind-market-probe-run').disabled, false)
  await fixture.get('ifind-market-probe-run').click()
  assert.deepEqual(fixture.calls.map(({ url }) => url), [
    STATUS_PATH, STATUS_PATH, STATUS_PATH, RUN_PATH, STATUS_PATH
  ])
}

async function untrustedResultAndExplicitResetClearTest() {
  const invalid = { ...observedResult(), rawResponse: 'UNTRUSTED' }
  const fixture = controllerFixture({ responses: [observedResult(), invalid] })
  await fixture.controller.refresh()
  assert.match(fixture.get('ifind-market-probe-identity').textContent, /阿里巴巴-W/)
  await fixture.controller.refresh()
  assert.equal(fixture.errors[0].code, 'IFIND_MARKET_PROBE_RESULT_INVALID')
  assert.equal(fixture.get('ifind-market-probe-identity').textContent, '—')

  const restored = controllerFixture({ responses: [observedResult()] })
  await restored.controller.refresh()
  restored.controller.reset()
  assert.equal(restored.get('ifind-market-probe-identity').textContent, '—')
  assert.equal(restored.get('ifind-market-probe-status').textContent, '尚未读取状态')
}

async function cancellationAndStaleSessionTest() {
  const gate = deferred()
  const fixture = controllerFixture({ responses: [gate.promise] })
  const pending = fixture.controller.refresh()
  fixture.controller.reset()
  fixture.sessionLifecycle.invalidate()
  gate.resolve(observedResult())
  await pending
  assert.equal(fixture.get('ifind-market-probe-status').textContent, '尚未读取状态')
  assert.equal(fixture.get('ifind-market-probe-identity').textContent, '—')
  assert.equal(fixture.get('ifind-market-probe-run').disabled, true)
  assert.deepEqual(fixture.errors, [])
  assert.deepEqual(fixture.live, [])
}

async function staleGenerationSettlementsStaySilentTest() {
  const staleOutcomes = [
    { name: 'GET success', start: (fixture) => fixture.controller.refresh(),
      settle: (gate) => gate.resolve(observedResult()) },
    { name: 'GET failure', start: (fixture) => fixture.controller.refresh(),
      settle: (gate, hostile) => gate.resolve(Promise.reject(hostile)) },
    { name: 'POST success', prepare: true,
      start: (fixture) => fixture.get('ifind-market-probe-run').click(),
      settle: (gate) => gate.resolve(observedResult()) },
    { name: 'POST failure', prepare: true,
      start: (fixture) => fixture.get('ifind-market-probe-run').click(),
      settle: (gate, hostile) => gate.resolve(Promise.reject(hostile)) }
  ]
  for (const scenario of staleOutcomes) {
    let traps = 0
    const hostile = new Proxy({}, {
      get() { traps += 1; throw new Error('SENSITIVE_GET') },
      getOwnPropertyDescriptor() { traps += 1; throw new Error('SENSITIVE_DESCRIPTOR') },
      ownKeys() { traps += 1; throw new Error('SENSITIVE_KEYS') }
    })
    const gate = deferred()
    const responses = scenario.prepare ? [readyResult(), gate.promise] : [gate.promise]
    const fixture = controllerFixture({ responses })
    if (scenario.prepare) await fixture.controller.refresh()
    const pending = scenario.start(fixture)
    fixture.controller.reset()
    fixture.sessionLifecycle.invalidate()
    fixture.sessionLifecycle.activate()
    scenario.settle(gate, hostile)
    await pending
    assert.equal(traps, 0, scenario.name)
    assert.deepEqual(fixture.errors, [], scenario.name)
    assert.deepEqual(fixture.live, [], scenario.name)
    assert.equal(fixture.get('ifind-market-probe-status').textContent, '尚未读取状态', scenario.name)
    assert.equal(fixture.get('ifind-market-probe-identity').textContent, '—', scenario.name)
    assert.equal(fixture.get('ifind-market-probe-run').disabled, true, scenario.name)
  }
}

async function latestStatusRequestWinsOutOfOrderTest() {
  const older = deferred()
  const newer = deferred()
  const fixture = controllerFixture({ responses: [older.promise, newer.promise] })
  const olderPending = fixture.controller.refresh()
  const newerPending = fixture.controller.refresh()
  newer.resolve(failedResult('cooldown'))
  await newerPending
  assert.equal(fixture.get('ifind-market-probe-status').textContent, '冷却中')
  assert.equal(fixture.get('ifind-market-probe-run').disabled, true)

  older.resolve(readyResult())
  await olderPending
  assert.equal(fixture.get('ifind-market-probe-status').textContent, '冷却中')
  assert.equal(fixture.get('ifind-market-probe-run').disabled, true)
  assert.deepEqual(fixture.errors, [])
  assert.deepEqual(fixture.live, [])
}

async function externalGetCannotCancelRunningPostTest() {
  {
    const post = deferred()
    const externalGet = deferred()
    const fixture = controllerFixture({ responses: [
      readyResult(), post.promise, externalGet.promise, failedResult('cooldown')
    ] })
    await fixture.controller.refresh()
    const running = fixture.get('ifind-market-probe-run').click()
    const external = fixture.controller.refresh()
    externalGet.resolve(readyResult())
    await external
    post.resolve(observedResult())
    await running
    assert.deepEqual(fixture.calls.map(({ url }) => url), [
      STATUS_PATH, RUN_PATH, STATUS_PATH, STATUS_PATH
    ])
    assert.deepEqual(fixture.live, [{
      message: '固定港股探针已完成；所有观察仍为未验证。', tone: 'success'
    }])
    assert.equal(fixture.get('ifind-market-probe-status').textContent, '冷却中')
    assert.equal(fixture.get('ifind-market-probe-run').disabled, true)
    assert.equal(fixture.get('ifind-market-probe-run').attributes.get('aria-busy'), 'false')
  }

  {
    const post = deferred()
    const externalGet = deferred()
    const internalGet = deferred()
    const fixture = controllerFixture({ responses: [
      readyResult(), post.promise, externalGet.promise, internalGet.promise
    ] })
    await fixture.controller.refresh()
    const running = fixture.get('ifind-market-probe-run').click()
    const external = fixture.controller.refresh()
    post.resolve(observedResult())
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(fixture.calls.map(({ url }) => url), [
      STATUS_PATH, RUN_PATH, STATUS_PATH, STATUS_PATH
    ])
    internalGet.resolve(failedResult('cooldown'))
    await running
    externalGet.resolve(readyResult())
    await external
    assert.deepEqual(fixture.live, [{
      message: '固定港股探针已完成；所有观察仍为未验证。', tone: 'success'
    }])
    assert.equal(fixture.get('ifind-market-probe-status').textContent, '冷却中')
    assert.equal(fixture.get('ifind-market-probe-run').disabled, true)
    assert.equal(fixture.get('ifind-market-probe-run').attributes.get('aria-busy'), 'false')
  }
}

async function externalGetCannotHidePostFailureTest() {
  const post = deferred()
  const externalGet = deferred()
  const fixture = controllerFixture({ responses: [readyResult(), post.promise, externalGet.promise] })
  await fixture.controller.refresh()
  const running = fixture.get('ifind-market-probe-run').click()
  const external = fixture.controller.refresh()
  externalGet.resolve(readyResult())
  await external
  post.resolve(Promise.reject(marketProbe.apiFailure(503, { error: 'IFIND_MARKET_PROBE_FAILED' })))
  await running
  assert.equal(fixture.errors.length, 1)
  assert.equal(fixture.errors[0].code, 'IFIND_MARKET_PROBE_FAILED')
  assert.equal(fixture.get('ifind-market-probe-run').disabled, true)
  assert.equal(fixture.get('ifind-market-probe-run').attributes.get('aria-busy'), 'false')
  assert.deepEqual(fixture.live, [])
}

async function hostileDtoTest() {
  const base = observedResult()
  const mutations = [
    () => ({ ...base, extra: 'UNTRUSTED' }),
    () => ({ ...base, refreshToken: 'UNTRUSTED' }),
    () => ({ ...base, status: 'verified' }),
    () => ({ ...base, verification: { ...base.verification, currencyStatus: 'verified' } }),
    () => Object.defineProperty({ ...base }, 'status', { enumerable: true, get() { throw new Error('UNTRUSTED') } }),
    () => new Proxy(base, { ownKeys() { throw new Error('UNTRUSTED') } }),
    () => ({ ...base, observations: { ...base.observations,
      identity: { ...base.observations.identity, RequestId: 'UNTRUSTED' } } }),
    () => ({ ...base, observations: { ...base.observations,
      identity: { ...base.observations.identity, fields: {
        ths_stock_short_name_stock: ['bad\u0000text']
      } } } }),
    () => { const cycle = []; cycle.push(cycle); return { ...base, observations: { ...base.observations,
      identity: { ...base.observations.identity, fields: { ths_stock_short_name_stock: cycle } } } } }
  ]
  for (const mutate of mutations) {
    const fixture = controllerFixture({ responses: [mutate()] })
    await fixture.controller.refresh()
    assert.equal(fixture.errors.length, 1)
    assert.equal(fixture.errors[0].code, 'IFIND_MARKET_PROBE_RESULT_INVALID')
    assert.equal(fixture.get('ifind-market-probe-identity').textContent, '—')
  }
}

async function failureMappingTest() {
  const authFailure = marketProbe.apiFailure(401, { error: 'ADMIN_AUTH_REQUIRED' })
  assert.equal(authFailure.code, 'ADMIN_AUTH_REQUIRED')
  assert.equal(authFailure.message, 'ADMIN_AUTH_REQUIRED')
  assert.deepEqual(Object.keys(authFailure), ['code'])
  const probeFailure = marketProbe.apiFailure(503, { error: 'IFIND_MARKET_PROBE_FAILED' })
  assert.equal(probeFailure.code, 'IFIND_MARKET_PROBE_FAILED')
  assert.equal(probeFailure.message, 'IFIND_MARKET_PROBE_FAILED')
  const unknownFailure = marketProbe.apiFailure(500,
    new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('UNTRUSTED') } }))
  assert.equal(unknownFailure.code, 'UNKNOWN')
  assert.equal(unknownFailure.message, 'UNKNOWN')
  assert.equal(marketProbe.errorMessage('IFIND_MARKET_PROBE_FAILED'),
    '固定港股探针未完成，不会自动重试。')
  assert.equal(marketProbe.errorMessage('UNTRUSTED'), '固定港股探针暂时不可用，不会自动重试。')
}

async function htmlContractTest() {
  const html = fs.readFileSync(path.join(ROOT, 'public/admin.html'), 'utf8')
  assert.match(html, /<h2[^>]*>T11 港股模板验证<\/h2>/)
  assert.match(html, /1 次认证 \+ 3 次业务请求/)
  assert.match(html, /0 次重试/)
  assert.match(html, /家庭看板(?:继续|仍为) Mock/)
  assert.match(html, /<script src="\/admin-market-probe-contract\.js" defer><\/script>[\s\S]*<script src="\/admin\.js" defer><\/script>/)
  for (const name of VERIFICATION_IDS) {
    assert.match(html, new RegExp(`id="ifind-market-probe-${name}"[^>]*data-evidence-status="unverified"[^>]*>未验证<`))
  }
}

async function run() {
  for (const test of [moduleSurfaceTest, offlineRefreshAndRenderTest, confirmationAndSingleFlightTest,
    runOutcomeMessagingTest, trustedResultSurvivesTransportAndApiFailureTest,
    hostileRejectionIsNeverInspectedTest, failedRefreshPreservesReadyButDisablesRunTest,
    untrustedResultAndExplicitResetClearTest, cancellationAndStaleSessionTest,
    staleGenerationSettlementsStaySilentTest, latestStatusRequestWinsOutOfOrderTest,
    externalGetCannotCancelRunningPostTest, externalGetCannotHidePostFailureTest,
    hostileDtoTest, failureMappingTest, htmlContractTest]) {
    await test()
    console.log(`PASS frontend-market-probe: ${test.name}`)
  }
}

module.exports = { run }

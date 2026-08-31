'use strict'

const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const {
  IfindMarketDiagnosticRepository,
  IFIND_MARKET_CASE_COOLDOWN_MS: COOLDOWN,
  IFIND_MARKET_DIAGNOSTIC_LEASE_MS: LEASE
} = require('../db/ifind-market-diagnostic-repository')

const NOW = Date.parse('2026-08-31T04:00:00.000Z')
const CASE = 'HK_ALIBABA_9988'
const VERSION = 'v20260831-001'
const PREFIX = 'IFIND_REPORT_PERIOD_DIAGNOSTIC_'
const KEYS = ['diagnosticId', 'caseId', 'displayCode', 'requestedSelector', 'indicators',
  'status', 'verification', 'observation', 'requestCount', 'businessRequestCount',
  'dataVol', 'attemptedAt', 'errorCode', 'failureEvidence']
const VERIFICATION = ['issuerIdentityStatus', 'vendorCodeStatus', 'entitlementStatus',
  'currencyStatus', 'unitStatus', 'reportPeriodStatus', 'scopeStatus']
const REQUEST = { codes: '9988.HK', indipara: [
  { indicator: 'revenue_oas', indiparams: ['20260331', '1', 'BB'] },
  { indicator: 'report_sd', indiparams: ['20260331', '1'] },
  { indicator: 'report_ed', indiparams: ['20260331', '1'] }
] }
let domain
let createService
let sequence = 0
const id = () => 'market_run_' + (++sequence).toString(16).padStart(32, '0')
/** @param {any} [table] Includes intentionally invalid provider evidence. */
const payload = (table = { revenue_oas: ['247652000000'], report_sd: ['2026-01-01'],
  report_ed: ['2026-03-31'] }) => ({ errorcode: 0, tables: [{ thscode: '9988.HK', table }] })
const clone = (value) => structuredClone(value)

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve: (value = undefined) => resolve(value) }
}

/** @returns {any} Mutable adversarial service fixture. */
function fixture() {
  const db = new DatabaseSync(':memory:')
  const repository = new IfindMarketDiagnosticRepository(db)
  repository.initialize()
  const state = { now: NOW, reads: 0, auth: 0, business: 0, clears: 0, buffers: [] }
  const rows = () => db.prepare('SELECT * FROM ifind_market_case_runs ORDER BY created_at, run_id').all()
  const token = (text) => { const value = Buffer.from(text); state.buffers.push(value); return value }
  const secretProvider = { readRefreshToken() {
    state.reads += 1
    assert.equal(rows().at(-1).status, 'pending', 'SQLite reservation precedes secrets')
    return token('synthetic-report-refresh')
  } }
  const client = {
    async authenticate(refresh) {
      state.auth += 1
      assert.equal(refresh.toString(), 'synthetic-report-refresh')
      return { accessToken: token('synthetic-report-access'), requestCount: 1 }
    },
    async diagnoseReportPeriod(access) {
      state.business += 1
      assert.equal(arguments.length, 1)
      assert.equal(access.toString(), 'synthetic-report-access')
      return { payload: payload(), requestCount: 1, dataVol: 3 }
    },
    clear() { state.clears += 1 }
  }
  const options = { repository, client, secretProvider, tokenVersionId: VERSION,
    clock: () => state.now, idGenerator: id }
  return { db, repository, state, rows, token, client, secretProvider, options,
    service: (overrides = {}) => createService({ ...options, ...overrides }) }
}

async function using(operation) {
  const f = fixture()
  try { await operation(f) } finally { f.db.close() }
}

function safe(result) {
  assert.deepEqual(Object.keys(result), KEYS)
  assert.deepEqual(domain.copyReportPeriodDiagnosticResult(result), result)
  assert.deepEqual(Object.keys(result.verification), VERIFICATION)
  assert.ok(Object.values(result.verification).every((value) => value === 'unverified'))
  assert.doesNotMatch(JSON.stringify(result), /synthetic-report|UNTRUSTED/)
}

function clean(f) {
  assert.ok(f.state.buffers.every((buffer) => buffer.every((byte) => byte === 0)))
  for (const table of ['ifind_market_quote_snapshots', 'ifind_market_financial_points']) {
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0)
  }
  assert.doesNotMatch(JSON.stringify(f.rows()), /247652000000|2026-01-01|synthetic-report|dateEvidence/)
}

function seed(f, caseId, at) {
  const reserved = f.repository.reserve({ runId: id(), caseId, createdAt: at, tokenVersionId: VERSION })
  assert.equal(reserved.status, 'reserved')
  assert.equal(f.repository.fail({ reservation: reserved.reservation, result: {
    status: 'failed', quoteStatus: 'not_run', financeStatus: 'not_run', requestCount: 1,
    dataVol: null, elapsedMs: 0, safeErrorClass: 'AUTH', failureCode: 'IFIND_MARKET_AUTH_FAILED',
    vendorErrorCode: null, completedAt: at
  } }).status, 'completed')
}

/** @type {Array<[string, () => Promise<void>]>} */
const tests = [
  ['approved modules and exports exist', async () => {
    assert.doesNotThrow(() => {
      domain = require('../domain/ifind-report-period-diagnostic')
      createService = require('../services/ifind-report-period-diagnostic-service')
        .createIfindReportPeriodDiagnosticService
    }, 'report-period diagnostic backend is not implemented')
    for (const key of ['createInitialReportPeriodDiagnosticResult', 'copyReportPeriodDiagnosticResult',
      'parseReportPeriodDiagnosticObservation']) assert.equal(typeof domain[key], 'function')
    assert.equal(typeof createService, 'function')
  }],
  ['fixed request and exact initial DTO', async () => {
    assert.equal(domain.REPORT_PERIOD_DIAGNOSTIC_ID, 'HK_ALIBABA_REPORT_PERIOD_20260331_SINGLE_QUARTER_V1')
    assert.deepEqual(domain.REPORT_PERIOD_DIAGNOSTIC_REQUEST, REQUEST)
    for (const value of [domain.REPORT_PERIOD_DIAGNOSTIC_REQUEST,
      domain.REPORT_PERIOD_DIAGNOSTIC_REQUEST.indipara,
      ...domain.REPORT_PERIOD_DIAGNOSTIC_REQUEST.indipara,
      ...domain.REPORT_PERIOD_DIAGNOSTIC_REQUEST.indipara.map((item) => item.indiparams)]) {
      assert.ok(Object.isFrozen(value))
    }
    const result = domain.createInitialReportPeriodDiagnosticResult()
    assert.deepEqual(result, { diagnosticId: domain.REPORT_PERIOD_DIAGNOSTIC_ID,
      caseId: CASE, displayCode: '9988.HK', requestedSelector: '20260331',
      indicators: REQUEST.indipara.map((item) => ({ indicator: item.indicator, parameters: item.indiparams })),
      status: 'ready', verification: Object.fromEntries(VERIFICATION.map((key) => [key, 'unverified'])),
      observation: null, requestCount: 0, businessRequestCount: 0, dataVol: null,
      attemptedAt: null, errorCode: null, failureEvidence: null })
    safe(result)
    const copy = domain.copyReportPeriodDiagnosticResult(result)
    copy.indicators[0].parameters[0] = 'other'
    assert.equal(result.indicators[0].parameters[0], '20260331')
    for (const status of ['ready', 'busy', 'cooldown', 'daily-limit']) safe({ ...result, status })
  }],
  ['independent date evidence, missing columns and strict decimals', async () => {
    for (const [input, expected] of [[0, 0], [-4.25, -4.25], ['123.50', 123.5], [null, null]]) {
      for (const [dates, start, end, availability] of /** @type {any[]} */ ([
        [{ report_sd: ['2026-01-01'], report_ed: ['2026-03-31'] }, '2026-01-01', '2026-03-31', 'present'],
        [{ report_sd: ['2024-02-29'] }, '2024-02-29', null, 'partial'],
        [{ report_ed: ['2026-03-31'] }, null, '2026-03-31', 'partial'],
        [{ report_sd: [null], report_ed: [null] }, null, null, 'missing'],
        [{}, null, null, 'missing']
      ])) {
        assert.deepEqual(domain.parseReportPeriodDiagnosticObservation(payload({ revenue_oas: [input], ...dates })), {
          returnedCode: '9988.HK', revenue: { value: expected, availability: expected === null ? 'missing' : 'present' },
          dateEvidence: { requestedDataType: 'single-quarter', start, end, availability,
            revenuePeriodLink: 'unverified' }
        })
      }
    }
  }],
  ['malformed, unknown, extra and noncanonical provider evidence fails', async () => {
    /** @type {any[]} */
    const invalid = [null, {}, { ...payload(), errorcode: 1 }, { ...payload(), tables: [] },
      { ...payload(), tables: [...payload().tables, ...payload().tables] },
      { ...payload(), tables: [{ thscode: '09988.HK', table: { revenue_oas: [1] } }] },
      { ...payload(), extra: 'UNTRUSTED' }, payload({}),
      payload({ revenue_oas: [1], currency: ['CNY'] }),
      payload({ revenue_oas: [1], report_sd: ['2026-04-01'], report_ed: ['2026-03-31'] })]
    for (const value of [NaN, Infinity, -Infinity, undefined, true, {}, [], '', ' 1', '1\n',
      '1,000', '1e3', '0x10', '+1', '01', '.5', '1.', '1million']) invalid.push(payload({ revenue_oas: [value] }))
    for (const value of [undefined, '', '20260331', '2026-2-01', '2026-02-30', '2025-02-29',
      '2026-03-31T00:00:00Z', '2026-03-31\n', 20260331, true, {}]) {
      invalid.push(payload({ revenue_oas: [1], report_sd: [value] }))
    }
    for (const column of ['revenue_oas', 'report_sd', 'report_ed']) {
      for (const value of [null, [], ['2026-01-01', '2026-02-01'], '2026-01-01']) {
        invalid.push(payload({ revenue_oas: [1], [column]: value }))
      }
    }
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '3', undefined]) invalid.push({ ...payload(), dataVol: value })
    for (const value of invalid) assert.throws(() => domain.parseReportPeriodDiagnosticObservation(value))
  }],
  ['strict DTO rejects malicious metadata, counts, dates and promotion without invoking traps', async () => {
    const initial = domain.createInitialReportPeriodDiagnosticResult()
    const observed = { ...initial, status: 'observed-unverified', requestCount: 2, businessRequestCount: 1,
      dataVol: 3, attemptedAt: new Date(NOW).toISOString(), errorCode: PREFIX + 'OBSERVED_UNVERIFIED',
      observation: domain.parseReportPeriodDiagnosticObservation(payload()) }
    safe(observed)
    /** @type {any[]} */
    const invalid = [null, [], { ...initial, raw: 'UNTRUSTED' }, { ...observed, observation: null }]
    for (const [key, value] of [['diagnosticId', 'other'], ['caseId', 'US_APPLE_AAPL'],
      ['requestedSelector', '20261231'], ['displayCode', '09988.HK'], ['status', 'verified'],
      ['requestCount', 3], ['requestCount', NaN], ['requestCount', 0], ['businessRequestCount', 0],
      ['dataVol', -1], ['dataVol', 1.5], ['dataVol', '3'], ['dataVol', Number.MAX_SAFE_INTEGER + 1],
      ['attemptedAt', null], ['attemptedAt', '2026-02-30T04:00:00.000Z'],
      ['attemptedAt', '2026-08-31T04:00:00Z'], ['attemptedAt', '2026-08-31T12:00:00.000+08:00'],
      ['errorCode', null]]) invalid.push({ ...observed, [key]: value })
    for (const key of VERIFICATION) invalid.push({ ...observed,
      verification: { ...initial.verification, [key]: 'verified' } })
    for (const status of ['ready', 'busy', 'cooldown', 'daily-limit', 'failed', 'unavailable']) {
      invalid.push({ ...observed, status })
    }
    for (const [key, value] of [['revenuePeriodLink', 'verified'], ['requestedDataType', 'consolidated'],
      ['start', '2026-04-01'], ['end', '2026-02-30'], ['availability', 'missing'], ['extra', 'UNTRUSTED']]) {
      const bad = clone(observed); bad.observation.dateEvidence[key] = value; invalid.push(bad)
    }
    for (const [key, value] of [['value', '1'], ['value', Infinity], ['value', null], ['availability', 'missing']]) {
      const bad = clone(observed); bad.observation.revenue[key] = value; invalid.push(bad)
    }
    const wrongIndicator = clone(initial); wrongIndicator.indicators[1].parameters[1] = 'consolidated'
    invalid.push(wrongIndicator, { ...observed, observation: { ...observed.observation, reportPeriod: '2026Q1' } })
    let traps = 0
    const hostile = (value) => new Proxy(value, {
      get() { traps += 1; throw new Error('UNTRUSTED') },
      ownKeys() { traps += 1; throw new Error('UNTRUSTED') },
      getPrototypeOf() { traps += 1; throw new Error('UNTRUSTED') },
      getOwnPropertyDescriptor() { traps += 1; throw new Error('UNTRUSTED') }
    })
    invalid.push(hostile(initial), { ...initial, indicators: hostile(initial.indicators) },
      { ...initial, verification: hostile(initial.verification) },
      { ...observed, observation: hostile(observed.observation) },
      { ...observed, observation: { ...observed.observation, dateEvidence: hostile({}) } })
    invalid.push(Object.defineProperty({ ...initial }, 'status', { enumerable: true,
      get() { traps += 1; throw new Error('UNTRUSTED') } }))
    const getterArray = clone(initial.indicators)
    Object.defineProperty(getterArray[1].parameters, '1', { enumerable: true,
      get() { traps += 1; throw new Error('UNTRUSTED') } })
    invalid.push({ ...initial, indicators: getterArray }, { ...initial, [Symbol('extra')]: 1 },
      Object.defineProperty({ ...initial }, 'hidden', { value: 1 }))
    const revoked = Proxy.revocable({}, {}); revoked.revoke(); invalid.push(revoked.proxy)
    for (const value of invalid) assert.throws(() => domain.copyReportPeriodDiagnosticResult(value),
      { code: PREFIX + 'RESULT_INVALID' })
    const provider = payload()
    Object.defineProperty(provider.tables[0].table, 'report_sd', { enumerable: true,
      get() { traps += 1; throw new Error('UNTRUSTED') } })
    const arrayGetter = payload()
    Object.defineProperty(arrayGetter.tables, '0', { enumerable: true,
      get() { traps += 1; throw new Error('UNTRUSTED') } })
    for (const value of [provider, arrayGetter, hostile(payload()),
      payload({ revenue_oas: [1], report_sd: hostile(['2026-01-01']) })]) {
      assert.throws(() => domain.parseReportPeriodDiagnosticObservation(value))
    }
    assert.equal(traps, 0)
  }],
  ['describe and clear are offline; observation remains runtime-only', async () => using(async (f) => {
    const service = f.service()
    safe(service.describe()); service.clear()
    assert.deepEqual([f.state.reads, f.state.auth, f.state.business, f.state.clears], [0, 0, 0, 0])
    const result = await service.run()
    safe(result)
    assert.equal(result.status, 'observed-unverified')
    assert.equal(result.requestCount, 2); assert.equal(result.businessRequestCount, 1)
    assert.equal(result.attemptedAt, new Date(NOW).toISOString())
    assert.equal(result.dataVol, 3)
    const row = f.rows()[0]
    assert.deepEqual([row.status, row.quote_status, row.finance_status, row.request_count,
      row.safe_error_class, row.failure_code], ['failed', 'not_run', 'unavailable', 2,
      'PERIOD_UNVERIFIED', PREFIX + 'OBSERVED_UNVERIFIED'])
    assert.deepEqual(service.describe(), result)
    result.observation.dateEvidence.start = '2000-01-01'
    assert.equal(service.describe().observation.dateEvidence.start, '2026-01-01')
    assert.equal(f.service().describe().observation, null)
    service.clear()
    assert.equal((await service.run()).status, 'cooldown')
    assert.deepEqual([f.state.reads, f.state.auth, f.state.business, f.state.clears], [1, 1, 1, 1])
    clean(f)
  })],
  ['shared SQLite pending, cooldown, per-case and global caps precede secrets', async () => {
    await using(async (f) => {
      const reserved = f.repository.reserve({ runId: id(), caseId: 'US_APPLE_AAPL',
        createdAt: NOW, tokenVersionId: VERSION })
      assert.equal(reserved.status, 'reserved')
      const service = f.service()
      assert.equal(service.describe().status, 'busy')
      assert.equal((await service.run()).status, 'busy')
      assert.equal(f.state.reads, 0); assert.equal(f.state.clears, 0)
    })
    for (const limit of ['cooldown', 'case', 'global']) await using(async (f) => {
      if (limit === 'cooldown') seed(f, CASE, NOW)
      if (limit === 'case') for (let i = 0; i < 5; i += 1) seed(f, CASE, NOW + i * COOLDOWN)
      if (limit === 'global') for (let i = 0; i < 12; i += 1) {
        seed(f, [CASE, 'US_APPLE_AAPL', 'CN_MOUTAI_600519'][i % 3], NOW + i * COOLDOWN)
      }
      f.state.now = limit === 'cooldown' ? NOW : NOW + 13 * COOLDOWN
      const service = f.service()
      const status = limit === 'cooldown' ? 'cooldown' : 'daily-limit'
      assert.equal(service.describe().status, status)
      assert.equal((await service.run()).status, status)
      assert.deepEqual([f.state.reads, f.state.auth, f.state.business, f.state.clears], [0, 0, 0, 0])
    })
  }],
  ['existing calibration shares limits without being modified', async () => using(async (f) => {
    const { createIfindCalibrationService } = require('../services/ifind-calibration-service')
    const calibration = createIfindCalibrationService({ ...f.options, client: {
      authenticate: f.client.authenticate,
      async calibrateFinancial() { return { payload: payload({ revenue_oas: [1] }), requestCount: 1, dataVol: null } },
      clear() {}
    } })
    assert.equal((await calibration.run()).status, 'observed-unverified')
    assert.equal((await f.service().run()).status, 'cooldown')
    assert.equal(f.state.reads, 1)
  })],
  ['auth, secret and business failures have conservative counts and zeroization', async () => {
    for (const stage of ['secret', 'auth', 'business']) await using(async (f) => {
      const error = Object.assign(new Error('UNTRUSTED'), { dataVol: 4, requestCount: 100 })
      if (stage === 'secret') f.secretProvider.readRefreshToken = () => { throw error }
      if (stage === 'auth') f.client.authenticate = async () => { f.state.auth += 1; throw error }
      if (stage === 'business') f.client.diagnoseReportPeriod = async () => { f.state.business += 1; throw error }
      const result = await f.service().run()
      assert.equal(result.status, stage === 'secret' ? 'unavailable' : 'failed')
      assert.equal(result.requestCount, { secret: 0, auth: 1, business: 2 }[stage])
      assert.equal(result.dataVol, stage === 'business' ? 4 : null)
      assert.equal(result.observation, null)
      assert.equal(f.state.clears, 1)
      safe(result); clean(f)
    })
  }],
  ['invalid auth counts and envelopes still wipe returned own buffers', async () => {
    for (const count of [0, 2, -1, NaN, '1', undefined]) await using(async (f) => {
      f.client.authenticate = async () => ({ accessToken: f.token('synthetic-report-access'), requestCount: count })
      const result = await f.service().run()
      assert.equal(result.status, 'failed'); assert.equal(result.requestCount, 1)
      assert.equal(f.state.business, 0); safe(result); clean(f)
    })
    await using(async (f) => {
      f.client.authenticate = async () => ({ accessToken: f.token('synthetic-report-access'), requestCount: 1, extra: true })
      assert.equal((await f.service().run()).status, 'failed'); clean(f)
    })
  }],
  ['malformed business evidence/counts/volume never publishes observation', async () => {
    const bad = [
      { payload: payload(), requestCount: 2, dataVol: 3 },
      { payload: payload(), requestCount: 1, dataVol: -1 },
      { payload: payload(), requestCount: 1, dataVol: '3' },
      { payload: payload(), requestCount: 1, dataVol: Number.MAX_SAFE_INTEGER + 1 },
      { payload: payload({ revenue_oas: [1], report_sd: ['2026-02-30'] }), requestCount: 1, dataVol: 3 },
      { payload: payload({ revenue_oas: [1], extra: [1] }), requestCount: 1, dataVol: null },
      { payload: payload(), requestCount: 1, dataVol: 3, extra: 'UNTRUSTED' }
    ]
    for (const output of bad) await using(async (f) => {
      f.client.diagnoseReportPeriod = async () => output
      const result = await f.service().run()
      assert.equal(result.status, 'failed'); assert.equal(result.observation, null)
      assert.equal(result.requestCount, 2); safe(result); clean(f)
    })
    await using(async (f) => {
      let traps = 0
      f.client.diagnoseReportPeriod = async () => { throw new Proxy({}, {
        get() { traps += 1; throw new Error('UNTRUSTED') }
      }) }
      safe(await f.service().run()); assert.equal(traps, 0); clean(f)
    })
  }],
  ['lease expiry and generation clear discard late auth/business responses', async () => {
    for (const stage of ['auth', 'business']) for (const action of ['expiry', 'clear']) {
      await using(async (f) => {
        const gate = deferred(); const entered = deferred()
        const key = stage === 'auth' ? 'authenticate' : 'diagnoseReportPeriod'
        const original = f.client[key]
        f.client[key] = async function (...args) {
          const value = await original.apply(this, args); entered.resolve(); await gate.promise; return value
        }
        const service = f.service(); const running = service.run(); await entered.promise
        if (action === 'expiry') f.state.now += LEASE
        else service.clear()
        assert.equal((await service.run()).status, 'busy')
        assert.equal(f.state.clears, 0)
        gate.resolve()
        const result = await running
        assert.equal(result.status, 'failed'); assert.equal(result.observation, null)
        assert.equal(result.requestCount, stage === 'auth' ? 1 : 2)
        assert.equal(f.rows()[0].request_count, result.requestCount)
        safe(result); clean(f)
      })
    }
  }],
  ['settlement conflict/throw/malformed completion cannot publish or retry', async () => {
    for (const failure of ['conflict', 'throw', 'malformed']) await using(async (f) => {
      let settles = 0
      const repository = { reserve: f.repository.reserve.bind(f.repository),
        quotaStatus: f.repository.quotaStatus.bind(f.repository), fail() {
          settles += 1
          if (failure === 'throw') throw new Error('UNTRUSTED')
          return failure === 'conflict' ? { status: 'conflict' } : { status: 'completed', cooldownUntil: 0 }
        } }
      const service = f.service({ repository }); const result = await service.run()
      assert.equal(result.status, 'unavailable'); assert.equal(result.errorCode, PREFIX + 'UNAVAILABLE')
      assert.equal(result.observation, null); assert.equal(service.describe().observation, null)
      assert.equal(settles, 1); assert.equal(f.state.business, 1)
      safe(result); clean(f)
    })
  }],
  ['clear during cleanup discards result and never clears another owner', async () => using(async (f) => {
    const cleanup = deferred(); const entered = deferred()
    let service
    f.client.clear = async () => { f.state.clears += 1; service.clear(); entered.resolve(); await cleanup.promise }
    service = f.service(); const other = f.service()
    const running = service.run(); await entered.promise
    other.clear()
    assert.equal(other.describe().status, 'busy')
    assert.equal((await other.run()).status, 'busy')
    assert.equal(f.state.clears, 1)
    cleanup.resolve()
    const result = await running
    assert.equal(result.status, 'failed'); assert.equal(result.observation, null)
    assert.equal(service.describe().observation, null); safe(result); clean(f)
  })],
  ['cleanup failure is sanitized; invalid arguments and clock never read secrets', async () => {
    await using(async (f) => {
      f.client.clear = () => { throw new Error('UNTRUSTED') }
      const result = await f.service().run()
      assert.equal(result.status, 'observed-unverified'); safe(result); clean(f)
    })
    await using(async (f) => {
      const service = f.service()
      await assert.rejects(service.run({}))
      f.state.now = NaN
      assert.equal((await service.run()).status, 'unavailable')
      assert.equal(service.describe().status, 'unavailable')
      assert.equal(f.state.reads, 0); assert.equal(f.state.clears, 0)
    })
  }]
]

module.exports = { run: async function () {
  for (const [name, operation] of tests) { await operation(); console.log('PASS report-period: ' + name) }
  console.log(`ifind-report-period-diagnostic: ${tests.length} tests passed`)
} }

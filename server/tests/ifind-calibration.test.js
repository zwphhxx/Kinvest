'use strict'

const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const {
  IfindMarketDiagnosticRepository,
  IFIND_MARKET_CASE_COOLDOWN_MS,
  IFIND_MARKET_DIAGNOSTIC_LEASE_MS
} = require('../db/ifind-market-diagnostic-repository')

const NOW = Date.parse('2026-08-30T04:00:00.000Z')
const CASE_ID = 'HK_ALIBABA_9988'
const VERSION = 'v20260830-001'
const OBSERVED = 'IFIND_CALIBRATION_OBSERVED_UNVERIFIED'
const FAILED = 'IFIND_CALIBRATION_FAILED'
const UNAVAILABLE = 'IFIND_CALIBRATION_UNAVAILABLE'
const SECRET = 'synthetic-calibration-secret-do-not-expose'
const VERIFICATION_KEYS = [
  'issuerIdentityStatus', 'vendorCodeStatus', 'entitlementStatus',
  'currencyStatus', 'unitStatus', 'reportPeriodStatus', 'scopeStatus'
]
let domain
let createIfindCalibrationService
let nextId = 0

function id() {
  return 'market_run_' + (++nextId).toString(16).padStart(32, '0')
}

/** @param {any} [value] Deliberately includes malformed provider fixtures. */
function payload(value = 123.5) {
  return { errorcode: 0, tables: [{ thscode: '9988.HK', table: { revenue_oas: [value] } }], dataVol: null }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return {
    promise,
    resolve(value = undefined) {
      if (typeof resolve !== 'function') throw new Error('DEFERRED_NOT_INITIALIZED')
      resolve(value)
    }
  }
}

function harness() {
  const database = new DatabaseSync(':memory:')
  const repository = new IfindMarketDiagnosticRepository(database)
  repository.initialize()
  const state = { now: NOW, reads: 0, auth: 0, financial: 0, clears: 0, buffers: [] }
  const rows = () => database.prepare('SELECT * FROM ifind_market_case_runs ORDER BY created_at, run_id').all()
  const secretProvider = {
    readRefreshToken() {
      state.reads += 1
      assert.equal(rows().at(-1).status, 'pending', 'reserve commits before reading the secret')
      const token = Buffer.from(SECRET)
      state.buffers.push(token)
      return token
    }
  }
  const client = {
    async authenticate(token) {
      state.auth += 1
      assert.equal(token.toString(), SECRET)
      assert.equal(rows().at(-1).status, 'pending')
      const accessToken = Buffer.from('synthetic-calibration-access')
      state.buffers.push(accessToken)
      return { accessToken, requestCount: 1 }
    },
    async calibrateFinancial(token) {
      state.financial += 1
      assert.equal(arguments.length, 1, 'the parent client owns the immutable request')
      assert.equal(token.toString(), 'synthetic-calibration-access')
      return { payload: payload(), requestCount: 1, dataVol: null }
    },
    clear() { state.clears += 1 }
  }
  const options = {
    repository, client, secretProvider, tokenVersionId: VERSION,
    clock: () => state.now, idGenerator: id
  }
  return {
    database, repository, state, client, secretProvider, options, rows,
    service(overrides = {}) { return createIfindCalibrationService({ ...options, ...overrides }) },
    close() { database.close() }
  }
}

async function withHarness(operation) {
  const fixture = harness()
  try { await operation(fixture) } finally { fixture.close() }
}

function assertSafe(result) {
  assert.deepEqual(domain.copyCalibrationResult(result), result)
  assert.deepEqual(Object.keys(result.verification).sort(), [...VERIFICATION_KEYS].sort())
  for (const value of Object.values(result.verification)) assert.equal(value, 'unverified')
  assert.equal(JSON.stringify(result).includes(SECRET), false)
}

function assertWiped(state) {
  for (const buffer of state.buffers) assert.equal(buffer.every((byte) => byte === 0), true)
}

function assertNoEvidence(fixture) {
  for (const table of ['ifind_market_quote_snapshots', 'ifind_market_financial_points']) {
    assert.equal(fixture.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0)
  }
  assert.equal(JSON.stringify(fixture.rows()).includes(SECRET), false)
}

function seedR1(fixture, caseId, at) {
  const reserved = fixture.repository.reserve({ runId: id(), caseId, createdAt: at, tokenVersionId: VERSION })
  assert.equal(reserved.status, 'reserved')
  assert.equal(fixture.repository.fail({
    reservation: reserved.reservation,
    result: {
      status: 'failed', quoteStatus: 'not_run', financeStatus: 'not_run',
      requestCount: 1, dataVol: null, elapsedMs: 0, safeErrorClass: 'AUTH',
      failureCode: 'IFIND_MARKET_AUTH_FAILED', vendorErrorCode: null, completedAt: at
    }
  }).status, 'completed')
}

/** @type {Array<[string, () => Promise<void>]>} */
const tests = [
  ['new contract and service modules exist', async () => {
    assert.doesNotThrow(() => {
      domain = require('../domain/ifind-calibration')
      ;({ createIfindCalibrationService } = require('../services/ifind-calibration-service'))
    }, 'the approved calibration modules must be implemented')
    assert.equal(typeof createIfindCalibrationService, 'function')
  }],
  ['fixed request is deeply frozen and initial DTO is exact', async () => {
    assert.equal(domain.CALIBRATION_ID, 'HK_ALIBABA_REVENUE_OAS_20260331_V1')
    assert.deepEqual(domain.CALIBRATION_REQUEST, {
      codes: '9988.HK', indipara: [{ indicator: 'revenue_oas', indiparams: ['20260331', '1', 'BB'] }]
    })
    for (const object of [domain.CALIBRATION_REQUEST, domain.CALIBRATION_REQUEST.indipara,
      domain.CALIBRATION_REQUEST.indipara[0], domain.CALIBRATION_REQUEST.indipara[0].indiparams]) {
      assert.equal(Object.isFrozen(object), true)
    }
    assert.throws(() => { domain.CALIBRATION_REQUEST.indipara[0].indiparams[0] = 'other' }, TypeError)
    const initial = domain.createInitialCalibrationResult()
    assert.deepEqual(initial, {
      calibrationId: domain.CALIBRATION_ID, caseId: CASE_ID, displayCode: '9988.HK',
      indicator: 'revenue_oas', parameters: ['20260331', '1', 'BB'], status: 'ready',
      verification: Object.fromEntries(VERIFICATION_KEYS.map((key) => [key, 'unverified'])),
      observation: null, requestCount: 0, businessRequestCount: 0,
      dataVol: null, attemptedAt: null, errorCode: null
    })
    const copied = domain.copyCalibrationResult(initial)
    assert.notEqual(copied, initial)
    assert.notEqual(copied.verification, initial.verification)
    assert.notEqual(copied.parameters, initial.parameters)
    assertSafe(initial)
  }],
  ['DTO rejects extra fields, invalid primitives, metadata and verified claims', async () => {
    const initial = domain.createInitialCalibrationResult()
    const invalid = [null, [], 1, SECRET, { ...initial, extra: SECRET }]
    /** @type {Array<[string, unknown]>} */
    const invalidFields = [
      ['calibrationId', SECRET], ['caseId', 'US_APPLE_AAPL'], ['displayCode', '09988.HK'],
      ['indicator', 'other'], ['parameters', ['20260331', '1', 'BB', SECRET]],
      ['status', 'verified'], ['requestCount', 3], ['requestCount', NaN],
      ['businessRequestCount', 2], ['dataVol', -1], ['dataVol', 0.5],
      ['dataVol', Number.MAX_SAFE_INTEGER + 1], ['errorCode', SECRET],
      ['attemptedAt', '2026-02-30T00:00:00.000Z'], ['attemptedAt', '2026-08-30T04:00:00Z'],
      ['attemptedAt', '2026-08-30T12:00:00.000+08:00']
    ]
    for (const [key, value] of invalidFields) invalid.push({ ...initial, [key]: value })
    for (const key of VERIFICATION_KEYS) {
      invalid.push({ ...initial, verification: { ...initial.verification, [key]: 'verified' } })
      invalid.push({ ...initial, verification: { ...initial.verification, [key]: 'failed' } })
    }
    const observed = {
      ...initial, status: 'observed-unverified', requestCount: 2, businessRequestCount: 1,
      attemptedAt: new Date(NOW).toISOString(), errorCode: OBSERVED,
      observation: {
        value: 1, availability: 'present', returnedCode: '9988.HK', currency: null,
        unit: null, reportPeriod: null, periodType: null, disclosureScope: null
      }
    }
    assertSafe(observed)
    /** @type {Array<[string, unknown]>} */
    const invalidObservationFields = [
      ['value', Infinity], ['value', '1'], ['value', null], ['availability', 'available'],
      ['returnedCode', '09988.HK'], ['currency', 'CNY'], ['unit', 'million'],
      ['reportPeriod', '20260331'], ['periodType', 'annual'], ['disclosureScope', 'consolidated'],
      ['raw', SECRET]
    ]
    for (const [key, value] of invalidObservationFields) {
      invalid.push({ ...observed, observation: { ...observed.observation, [key]: value } })
    }
    invalid.push({ ...observed, errorCode: null }, { ...initial, observation: observed.observation })
    const symbolExtra = { ...initial, [Symbol('secret')]: SECRET }
    const hiddenExtra = Object.defineProperty({ ...initial }, 'secret', { value: SECRET })
    invalid.push(symbolExtra, hiddenExtra, Object.assign(Object.create({ secret: SECRET }), initial))
    for (const value of invalid) {
      assert.throws(() => domain.copyCalibrationResult(value), {
        code: 'IFIND_CALIBRATION_RESULT_INVALID', message: 'The iFinD calibration result is invalid'
      })
    }
  }],
  ['DTO rejects hostile proxies and accessors without invoking them', async () => {
    let traps = 0
    const proxy = (value) => new Proxy(value, {
      get() { traps += 1; throw new Error(SECRET) },
      ownKeys() { traps += 1; throw new Error(SECRET) },
      getPrototypeOf() { traps += 1; throw new Error(SECRET) },
      getOwnPropertyDescriptor() { traps += 1; throw new Error(SECRET) }
    })
    const initial = domain.createInitialCalibrationResult()
    const getter = Object.defineProperty({ ...initial }, 'status', {
      enumerable: true, get() { traps += 1; throw new Error(SECRET) }
    })
    const parameters = [...initial.parameters]
    Object.defineProperty(parameters, '0', { enumerable: true, get() { traps += 1; throw new Error(SECRET) } })
    const verification = { ...initial.verification }
    Object.defineProperty(verification, 'unitStatus', { enumerable: true, get() { traps += 1; throw new Error(SECRET) } })
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    for (const value of [proxy(initial), revoked.proxy, getter, { ...initial, parameters },
      { ...initial, parameters: proxy(initial.parameters) }, { ...initial, verification },
      { ...initial, verification: proxy(initial.verification) }, { ...initial, observation: proxy({}) }]) {
      assert.throws(() => domain.copyCalibrationResult(value), { code: 'IFIND_CALIBRATION_RESULT_INVALID' })
    }
    assert.equal(traps, 0)
  }],
  ['describe and clear are offline and never touch secrets or clients', async () => withHarness(async (f) => {
    const service = f.service()
    assert.equal(service.describe().status, 'ready')
    assertSafe(service.describe())
    service.clear()
    assert.equal(service.describe().observation, null)
    assert.deepEqual([f.state.reads, f.state.auth, f.state.financial, f.state.clears], [0, 0, 0, 0])
    assert.equal(f.rows().length, 0)
  })],
  ['transport observation is deliberately failed full-case bookkeeping, never evidence', async () => withHarness(async (f) => {
    const service = f.service()
    const result = await service.run()
    assertSafe(result)
    assert.equal(result.status, 'observed-unverified')
    assert.deepEqual(result.observation, {
      value: 123.5, availability: 'present', returnedCode: '9988.HK', currency: null,
      unit: null, reportPeriod: null, periodType: null, disclosureScope: null
    })
    assert.equal(result.requestCount, 2)
    assert.equal(result.businessRequestCount, 1)
    assert.equal(result.attemptedAt, new Date(NOW).toISOString())
    assert.equal(result.dataVol, null, 'unknown volume is not invented as zero')
    assert.equal(result.errorCode, OBSERVED)
    // Transport observation succeeds, but verified-case evidence is unavailable.
    // The shared R1 ledger must stay failed and contain no financial value.
    const row = f.rows()[0]
    assert.equal(row.status, 'failed')
    assert.equal(row.quote_status, 'not_run')
    assert.equal(row.finance_status, 'unavailable')
    assert.equal(row.safe_error_class, 'PERIOD_UNVERIFIED')
    assert.equal(row.failure_code, OBSERVED)
    assert.equal(row.request_count, 2)
    assert.equal(row.data_vol, null)
    assert.equal(row.vendor_error_code, null)
    assert.equal(row.lease_expires_at - row.created_at, 30_000)
    assertNoEvidence(f)
    assertWiped(f.state)
    assert.equal(f.state.clears, 1)
    assert.deepEqual(service.describe(), result)
    result.observation.value = 999
    result.parameters[0] = 'other'
    assert.equal(service.describe().observation.value, 123.5)
    assert.equal(service.describe().parameters[0], '20260331')
    assert.equal(f.service().describe().observation, null, 'observations are never rehydrated from SQLite')
    service.clear()
    assert.equal(service.describe().observation, null)
    assert.equal((await service.run()).status, 'cooldown', 'clear cannot reset shared quotas')
    assert.equal(f.rows().length, 1)
  })],
  ['finite and conservative numeric values have no inferred metadata or scale', async () => {
    for (const [input, expected] of [[0, 0], [-7.25, -7.25], ['123.50', 123.5], ['-0.5', -0.5], [null, null]]) {
      await withHarness(async (f) => {
        f.client.calibrateFinancial = async () => ({ payload: payload(input), requestCount: 1, dataVol: 0 })
        const result = await f.service().run()
        assert.equal(result.status, 'observed-unverified')
        assert.equal(result.observation.value, expected)
        assert.equal(result.observation.availability, expected === null ? 'missing' : 'present')
        assert.equal(result.dataVol, 0)
        assertSafe(result)
        assertNoEvidence(f)
      })
    }
  }],
  ['shape mismatches and unsafe values never yield an observation', async () => {
    const invalid = [
      null, { errorcode: 1, tables: [], dataVol: null },
      { ...payload(), tables: [] }, { ...payload(), tables: [...payload().tables, ...payload().tables] },
      { ...payload(), tables: [{ thscode: '09988.HK', table: { revenue_oas: [1] } }] },
      { ...payload(), tables: [{ thscode: '9988.HK', table: {} }] },
      { ...payload(), tables: [{ thscode: '9988.HK', table: { revenue_oas: [1, 2] } }] },
      { ...payload(), tables: [{ thscode: '9988.HK', table: { revenue_oas: 1 } }] },
      { ...payload(), tables: [{ thscode: '9988.HK', table: { revenue_oas: [1], currency: ['CNY'] } }] },
      { ...payload(), raw: SECRET }
    ]
    for (const value of [NaN, Infinity, true, {}, '', ' ', ' 1', '1\n', '1,234', '0x10', '12million', SECRET]) {
      invalid.push(payload(value))
    }
    for (const value of invalid) {
      await withHarness(async (f) => {
        f.client.calibrateFinancial = async () => ({ payload: value, requestCount: 1, dataVol: null })
        const result = await f.service().run()
        assert.equal(result.status, 'failed')
        assert.equal(result.errorCode, FAILED)
        assert.equal(result.observation, null)
        assert.equal(f.rows()[0].request_count, 2)
        assertSafe(result)
        assertWiped(f.state)
        assertNoEvidence(f)
      })
    }
  }],
  ['hostile client payload descriptors are never executed', async () => withHarness(async (f) => {
    let reads = 0
    const response = payload()
    Object.defineProperty(response.tables[0].table, 'revenue_oas', {
      enumerable: true, get() { reads += 1; throw new Error(SECRET) }
    })
    f.client.calibrateFinancial = async () => ({ payload: response, requestCount: 1, dataVol: null })
    assert.equal((await f.service().run()).status, 'failed')
    assert.equal(reads, 0)
    assertNoEvidence(f)
  })],
  ['failed authentication counts its attempted call and is never retried', async () => withHarness(async (f) => {
    f.client.authenticate = async () => { f.state.auth += 1; throw new Error(SECRET) }
    const result = await f.service().run()
    assert.equal(result.status, 'failed')
    assert.equal(result.errorCode, FAILED)
    assert.equal(result.requestCount, 1)
    assert.equal(result.businessRequestCount, 0)
    assert.equal(f.rows()[0].request_count, 1)
    assert.deepEqual([f.state.auth, f.state.financial, f.state.clears], [1, 0, 1])
    assertSafe(result)
    assertWiped(f.state)
    assertNoEvidence(f)
  })],
  ['failed business call counts both calls without reading hostile error details', async () => withHarness(async (f) => {
    let reads = 0
    f.client.calibrateFinancial = async () => {
      f.state.financial += 1
      throw new Proxy({}, { get() { reads += 1; throw new Error(SECRET) } })
    }
    const result = await f.service().run()
    assert.equal(result.requestCount, 2)
    assert.equal(result.businessRequestCount, 1)
    assert.equal(result.dataVol, null)
    assert.equal(f.rows()[0].request_count, 2)
    assert.equal(reads, 0)
    assert.equal(f.state.financial, 1)
    assertSafe(result)
    assertWiped(f.state)
  })],
  ['secret failure spends one reservation but zero calls', async () => withHarness(async (f) => {
    f.secretProvider.readRefreshToken = () => { throw new Error(SECRET) }
    const service = f.service()
    const result = await service.run()
    assert.equal(result.status, 'unavailable')
    assert.equal(result.errorCode, UNAVAILABLE)
    assert.equal(result.requestCount, 0)
    assert.equal(f.rows()[0].request_count, 0)
    assert.equal(f.state.auth, 0)
    assert.equal(f.state.clears, 1)
    assert.equal((await service.run()).status, 'cooldown')
    assertSafe(result)
  })],
  ['invalid client counts fail closed and access buffers are still wiped', async () => {
    for (const requestCount of [0, 2, -1, null, '1']) {
      await withHarness(async (f) => {
        const token = Buffer.from(SECRET)
        f.state.buffers.push(token)
        f.client.authenticate = async () => ({ accessToken: token, requestCount })
        const result = await f.service().run()
        assert.equal(result.status, 'failed')
        assert.equal(result.requestCount, 1)
        assert.equal(f.state.financial, 0)
        assertWiped(f.state)
      })
      await withHarness(async (f) => {
        f.client.calibrateFinancial = async () => ({ payload: payload(), requestCount, dataVol: null })
        const result = await f.service().run()
        assert.equal(result.status, 'failed')
        assert.equal(result.requestCount, 2)
        assert.equal(result.observation, null)
      })
    }
  }],
  ['invalid dataVol is rejected, safe integers remain exact', async () => {
    for (const dataVol of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', undefined]) {
      await withHarness(async (f) => {
        f.client.calibrateFinancial = async () => ({ payload: payload(), requestCount: 1, dataVol })
        const result = await f.service().run()
        assert.equal(result.status, 'failed')
        assert.equal(result.dataVol, null)
      })
    }
    await withHarness(async (f) => {
      f.client.calibrateFinancial = async () => ({ payload: payload(), requestCount: 1, dataVol: Number.MAX_SAFE_INTEGER })
      const result = await f.service().run()
      assert.equal(result.dataVol, Number.MAX_SAFE_INTEGER)
      assert.equal(f.rows()[0].data_vol, Number.MAX_SAFE_INTEGER)
    })
  }],
  ['arguments are rejected before any reservation or client activity', async () => withHarness(async (f) => {
    const service = f.service()
    for (const args of [[undefined], [{}], [SECRET], [1, 2]]) {
      await assert.rejects(service.run(...args), { code: FAILED })
    }
    assert.equal(f.rows().length, 0)
    assert.equal(f.state.reads, 0)
  })],
  ['reservation failure cannot read secrets or clear somebody else\'s client', async () => withHarness(async (f) => {
    const repository = {
      reserve() { throw new Error(SECRET) },
      fail: f.repository.fail.bind(f.repository),
      quotaStatus: f.repository.quotaStatus.bind(f.repository)
    }
    const result = await f.service({ repository }).run()
    assert.equal(result.status, 'unavailable')
    assert.equal(result.errorCode, UNAVAILABLE)
    assert.equal(result.attemptedAt, null)
    assert.equal(result.requestCount, 0)
    assert.deepEqual([f.state.reads, f.state.auth, f.state.clears], [0, 0, 0])
    assertSafe(result)
  })],
  ['five HK attempts and cooldown use the existing R1 quota', async () => withHarness(async (f) => {
    const service = f.service()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await service.run()).status, 'observed-unverified')
      f.state.now += IFIND_MARKET_CASE_COOLDOWN_MS - 1
      assert.equal((await service.run()).status, 'cooldown')
      f.state.now += 1
    }
    const result = await service.run()
    assert.equal(result.status, 'daily-limit')
    assert.equal(result.requestCount, 0)
    assert.equal(f.rows().length, 5)
    assert.equal(f.state.auth, 5)
    const quota = f.repository.quotaStatus({ caseId: CASE_ID, now: f.state.now })
    assert.equal(quota.caseRemaining, 0)
    assert.equal(quota.globalAttemptCount, 5)
    assertSafe(result)
  })],
  ['R1 HK attempts consume calibration budget and calibration consumes R1 budget', async () => withHarness(async (f) => {
    for (let index = 0; index < 4; index += 1) {
      seedR1(f, CASE_ID, f.state.now)
      f.state.now += IFIND_MARKET_CASE_COOLDOWN_MS
    }
    assert.equal((await f.service().run()).status, 'observed-unverified')
    f.state.now += IFIND_MARKET_CASE_COOLDOWN_MS
    assert.equal(f.repository.reserve({
      runId: id(), caseId: CASE_ID, createdAt: f.state.now, tokenVersionId: VERSION
    }).status, 'case-daily-limit')
    assert.equal(f.rows().length, 5)
  })],
  ['twelve global R1 attempts block calibration below its HK limit', async () => withHarness(async (f) => {
    for (const caseId of [CASE_ID, 'US_APPLE_AAPL', 'CN_MOUTAI_600519']) {
      for (let index = 0; index < 4; index += 1) {
        seedR1(f, caseId, f.state.now)
        f.state.now += IFIND_MARKET_CASE_COOLDOWN_MS
      }
    }
    const service = f.service()
    assert.equal(service.describe().status, 'daily-limit')
    assert.equal((await service.run()).status, 'daily-limit')
    assert.equal(f.state.reads, 0)
    assert.equal(f.rows().length, 12)
  })],
  ['Shanghai midnight resets budget but clock rollback cannot reopen yesterday', async () => withHarness(async (f) => {
    f.state.now = Date.parse('2026-08-30T15:00:00.000Z')
    const service = f.service()
    for (let index = 0; index < 5; index += 1) {
      await service.run()
      f.state.now += IFIND_MARKET_CASE_COOLDOWN_MS
    }
    f.state.now = Date.parse('2026-08-30T16:00:00.000Z')
    assert.equal((await service.run()).status, 'observed-unverified')
    const reads = f.state.reads
    f.state.now = NOW
    assert.equal((await f.service().run()).status, 'unavailable')
    assert.equal(f.state.reads, reads)
  })],
  ['concurrent service instances share the SQLite pending reservation', async () => withHarness(async (f) => {
    const entered = deferred()
    const release = deferred()
    const authenticate = f.client.authenticate
    f.client.authenticate = async (token) => { entered.resolve(); await release.promise; return authenticate(token) }
    const owner = f.service()
    const active = owner.run()
    await entered.promise
    const otherState = { clears: 0, auth: 0 }
    const otherClient = {
      async authenticate() { otherState.auth += 1; throw new Error('must not call') },
      async calibrateFinancial() { throw new Error('must not call') },
      clear() { otherState.clears += 1 }
    }
    const other = f.service({ repository: new IfindMarketDiagnosticRepository(f.database), client: otherClient })
    assert.equal(other.describe().status, 'busy')
    assert.equal((await other.run()).status, 'busy')
    assert.equal((await owner.run()).status, 'busy')
    assert.equal((await f.service().run()).status, 'busy')
    assert.deepEqual(otherState, { clears: 0, auth: 0 })
    assert.equal(f.state.clears, 0)
    assert.equal(f.rows().length, 1)
    release.resolve()
    assert.equal((await active).status, 'observed-unverified')
    assert.equal(f.state.clears, 1)
  })],
  ['clear during a business request prevents late observation resurrection', async () => withHarness(async (f) => {
    const entered = deferred()
    const release = deferred()
    f.client.calibrateFinancial = async () => {
      entered.resolve()
      await release.promise
      return { payload: payload(), requestCount: 1, dataVol: null }
    }
    const service = f.service()
    const active = service.run()
    await entered.promise
    service.clear()
    release.resolve()
    const result = await active
    assert.equal(result.observation, null)
    assert.equal(service.describe().observation, null)
    assert.equal(result.requestCount, 2)
    assert.equal(f.rows()[0].request_count, 2)
    assertWiped(f.state)
    assertNoEvidence(f)
  })],
  ['invalid clocks before reserve spend nothing', async () => {
    for (const clock of [() => NaN, () => NOW + 0.5, () => 0, () => Infinity,
      () => Date.parse('2101-01-01T00:00:00.000Z'), () => { throw new Error(SECRET) }]) {
      await withHarness(async (f) => {
        const result = await f.service({ clock }).run()
        assert.equal(result.status, 'unavailable')
        assert.equal(f.rows().length, 0)
        assert.equal(f.state.reads, 0)
        assertSafe(result)
      })
    }
  }],
  ['clock rollback or lease expiry after auth prevents a business request', async () => {
    for (const nextTime of [NOW - 1, NaN, NOW + IFIND_MARKET_DIAGNOSTIC_LEASE_MS]) {
      await withHarness(async (f) => {
        const authenticate = f.client.authenticate
        f.client.authenticate = async (token) => {
          const result = await authenticate(token)
          f.state.now = nextTime
          return result
        }
        const result = await f.service().run()
        assert.equal(result.status, 'failed')
        assert.equal(result.requestCount, 1)
        assert.equal(f.state.financial, 0)
        assert.equal(f.rows()[0].request_count, 1)
        assertWiped(f.state)
      })
    }
  }],
  ['late business response is failed with counts and bounded settlement time', async () => withHarness(async (f) => {
    f.client.calibrateFinancial = async () => {
      f.state.now += IFIND_MARKET_DIAGNOSTIC_LEASE_MS + 1
      return { payload: payload(), requestCount: 1, dataVol: 1 }
    }
    const result = await f.service().run()
    assert.equal(result.status, 'failed')
    assert.equal(result.observation, null)
    assert.equal(result.requestCount, 2)
    const row = f.rows()[0]
    assert.equal(row.status, 'failed')
    assert.equal(row.request_count, 2)
    assert.equal(row.completed_at, row.lease_expires_at)
    assertNoEvidence(f)
  })],
  ['stale R1 lease is recovered before calibration can read secrets', async () => withHarness(async (f) => {
    const reserved = f.repository.reserve({ runId: id(), caseId: CASE_ID, createdAt: NOW, tokenVersionId: VERSION })
    assert.equal(reserved.status, 'reserved')
    f.state.now += IFIND_MARKET_DIAGNOSTIC_LEASE_MS
    assert.equal((await f.service().run()).status, 'cooldown')
    assert.equal(f.rows()[0].failure_code, 'IFIND_MARKET_DIAGNOSTIC_STALE_LEASE')
    assert.equal(f.state.reads, 0)
  })],
  ['settlement conflict never publishes an unrecorded observation or retries', async () => withHarness(async (f) => {
    let failures = 0
    const repository = {
      reserve: f.repository.reserve.bind(f.repository),
      quotaStatus: f.repository.quotaStatus.bind(f.repository),
      fail() { failures += 1; return { status: 'conflict' } }
    }
    const service = f.service({ repository })
    const result = await service.run()
    assert.equal(result.status, 'unavailable')
    assert.equal(result.errorCode, UNAVAILABLE)
    assert.equal(result.observation, null)
    assert.equal(service.describe().observation, null)
    assert.equal(failures, 1)
    assertWiped(f.state)
    assertNoEvidence(f)
  })],
  ['client cleanup failure is sanitized and does not change safe bookkeeping', async () => withHarness(async (f) => {
    f.client.clear = () => { throw new Error(SECRET) }
    const result = await f.service().run()
    assert.equal(result.status, 'observed-unverified')
    assertSafe(result)
    assertWiped(f.state)
    assertNoEvidence(f)
  })]
]

async function run() {
  for (const [name, operation] of tests) {
    await operation()
    if (require.main === module) process.stdout.write(`PASS ${name}\n`)
  }
  if (require.main === module) process.stdout.write(`${tests.length} calibration tests passed\n`)
}

module.exports = { run }

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`${error.stack}\n`)
    process.exitCode = 1
  })
}

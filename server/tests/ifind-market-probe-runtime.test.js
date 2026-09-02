'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { DatabaseSync } = require('node:sqlite')
const { createIfindHttpClient } = require('../adapters/ifind-http-client')
const {
  IfindMarketDiagnosticRepository,
  IFIND_MARKET_CASE_COOLDOWN_MS: COOLDOWN,
  IFIND_MARKET_DIAGNOSTIC_LEASE_MS: LEASE
} = require('../db/ifind-market-diagnostic-repository')

const NOW = Date.parse('2026-09-01T04:00:00.000Z')
const CASE_ID = 'HK_ALIBABA_9988'
const PROPOSAL_ID = 'HK_ALIBABA_9988_V1'
const VERSION = 'v20260901-001'
const RESULT_KEYS = ['proposalId', 'caseId', 'displayCode', 'status', 'verification',
  'observations', 'requestCount', 'businessRequestCount', 'dataVol', 'attemptedAt',
  'errorCode', 'failureStage']
const VERIFICATION_KEYS = ['issuerIdentityStatus', 'vendorCodeStatus', 'entitlementStatus',
  'currencyStatus', 'unitStatus', 'reportPeriodStatus', 'scopeStatus']
const STAGES = ['identity', 'quote', 'financial']
const FIELDS = Object.freeze({
  identity: Object.freeze(['ths_stock_short_name_stock']),
  quote: Object.freeze(['latest', 'preClose', 'open', 'high', 'low', 'amount', 'volume',
    'tradeDate', 'tradeTime']),
  financial: Object.freeze(['revenue_oas'])
})
const BODIES = Object.freeze([
  Object.freeze({ codes: '9988.HK', indipara: Object.freeze([
    Object.freeze({ indicator: 'ths_stock_short_name_stock' })
  ]) }),
  Object.freeze({ codes: '9988.HK',
    indicators: 'latest,preClose,open,high,low,amount,volume,tradeDate,tradeTime' }),
  Object.freeze({ codes: '9988.HK', indipara: Object.freeze([
    Object.freeze({ indicator: 'revenue_oas', indiparams: Object.freeze(['20260331', '1', 'BB']) })
  ]) })
])
const ENDPOINTS = ['/api/v1/basic_data_service', '/api/v1/real_time_quotation',
  '/api/v1/basic_data_service']

let domain
let createService
let idSequence = 0
const runId = () => 'market_run_' + (++idSequence).toString(16).padStart(32, '0')

function providerPayload(stage, overrides = {}) {
  const fields = Object.fromEntries(FIELDS[stage].map((field, index) => [field,
    [stage === 'identity' ? 'SYNTHETIC_ALIBABA' : index + 1]]))
  return {
    errorcode: 0,
    tables: [{ thscode: '9988.HK', table: fields }],
    dataVol: 1,
    ...overrides
  }
}

function summary(stage) {
  return {
    returnedCode: '9988.HK',
    fields: Object.fromEntries(FIELDS[stage].map((field, index) => [field,
      [stage === 'identity' ? 'SYNTHETIC_ALIBABA' : index + 1]]))
  }
}

function sanitizedPayload(stage) {
  return { errorcode: 0, tables: [{ thscode: '9988.HK', table: summary(stage).fields }], dataVol: 1 }
}

function createRequestStub(responses) {
  const pending = [...responses]
  const calls = []
  function request(url, options, callback) {
    let rawBody = ''
    const call = { url: String(url), method: options.method,
      headers: Object.fromEntries(Object.entries(options.headers).map(([key, value]) =>
        [key.toLowerCase(), value])), body: null }
    calls.push(call)
    /** @type {any} */
    const outgoing = new EventEmitter()
    outgoing.write = (chunk) => { rawBody += String(chunk) }
    outgoing.setTimeout = () => {}
    outgoing.destroy = () => {}
    outgoing.end = (chunk) => {
      if (chunk !== undefined) outgoing.write(chunk)
      call.body = rawBody ? JSON.parse(rawBody) : null
      const responseBody = pending.shift()
      queueMicrotask(() => {
        /** @type {any} */
        const incoming = new EventEmitter()
        incoming.statusCode = 200
        incoming.destroy = () => {}
        callback(incoming)
        incoming.emit('data', Buffer.from(JSON.stringify(responseBody)))
        incoming.emit('end')
      })
    }
    return outgoing
  }
  return { request, calls }
}

function assertSafeResult(result) {
  assert.deepEqual(Object.keys(result), RESULT_KEYS)
  assert.deepEqual(Object.keys(result.verification), VERIFICATION_KEYS)
  assert.ok(Object.values(result.verification).every((value) => value === 'unverified'))
  assert.deepEqual(domain.copyIfindMarketProbeResult(result), result)
  assert.doesNotMatch(JSON.stringify(result), /RequestId|DROP_ME|synthetic-refresh|synthetic-access/)
}

/**
 * @param {unknown} error
 * @returns {Error & Record<'code' | 'class' | 'vendorErrorCode' | 'stage' | 'requestCount' | 'failureCode', unknown>}
 */
function errorRecord(error) {
  assert.ok(error instanceof Error)
  for (const key of ['code', 'class', 'vendorErrorCode', 'stage', 'requestCount', 'failureCode']) {
    assert.ok(Object.hasOwn(error, key))
  }
  return /** @type {Error & Record<'code' | 'class' | 'vendorErrorCode' | 'stage' | 'requestCount' | 'failureCode', unknown>} */ (error)
}

function deferred() {
  /** @type {() => void} */
  let resolve = () => {}
  /** @type {Promise<void>} */
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const db = new DatabaseSync(':memory:')
  const repository = new IfindMarketDiagnosticRepository(db)
  repository.initialize()
  const state = { now: NOW, reads: 0, auth: 0, probes: [], clears: 0, buffers: [] }
  const rows = () => db.prepare('SELECT * FROM ifind_market_case_runs ORDER BY created_at, run_id').all()
  const token = (value) => { const buffer = Buffer.from(value); state.buffers.push(buffer); return buffer }
  const secretProvider = { readRefreshToken() {
    state.reads += 1
    assert.equal(rows().at(-1).status, 'pending', 'reservation must precede secret access')
    return token('synthetic-refresh')
  } }
  const client = {
    async authenticate(refreshToken) {
      state.auth += 1
      assert.equal(refreshToken.toString(), 'synthetic-refresh')
      return { accessToken: token('synthetic-access'), requestCount: 1 }
    },
    async probeFixed(accessToken, proposalId, sequence) {
      state.probes.push(sequence)
      assert.equal(accessToken.toString(), 'synthetic-access')
      assert.equal(proposalId, PROPOSAL_ID)
      const stage = STAGES[sequence - 1]
      return { stage, payload: sanitizedPayload(stage), requestCount: 1, dataVol: 1 }
    },
    clear() { state.clears += 1 }
  }
  const options = { repository, client, secretProvider, tokenVersionId: VERSION,
    clock: () => state.now, idGenerator: runId }
  return { db, repository, state, rows, token, client, secretProvider, options,
    service: (overrides = {}) => createService({ ...options, ...overrides }) }
}

async function using(operation) {
  const value = fixture()
  try { await operation(value) } finally { value.db.close() }
}

function assertClean(value) {
  assert.ok(value.state.buffers.every((buffer) => buffer.every((byte) => byte === 0)))
  for (const table of ['ifind_market_quote_snapshots', 'ifind_market_financial_points']) {
    assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0)
  }
  assert.doesNotMatch(JSON.stringify(value.rows()), /SYNTHETIC_ALIBABA|RequestId|DROP_ME|synthetic-/)
}

function seed(value, caseId, at) {
  const reserved = value.repository.reserve({ runId: runId(), caseId, createdAt: at,
    tokenVersionId: VERSION })
  assert.equal(reserved.status, 'reserved')
  assert.equal(value.repository.fail({ reservation: reserved.reservation, result: {
    status: 'failed', quoteStatus: 'not_run', financeStatus: 'not_run', requestCount: 1,
    dataVol: null, elapsedMs: 0, safeErrorClass: 'AUTH',
    failureCode: 'IFIND_MARKET_PROBE_FAILED', vendorErrorCode: null, completedAt: at
  } }).status, 'completed')
}

/** @type {Array<[string, () => Promise<void>]>} */
const tests = [
  ['fixed adapter rejects forbidden protocol keys and hostile bounded values without retry', async () => {
    const rootDangerous = providerPayload('identity')
    Object.defineProperty(rootDangerous, '__proto__', { value: 'UNTRUSTED', enumerable: true })
    const tableDangerous = providerPayload('identity')
    Object.defineProperty(tableDangerous.tables[0].table, 'constructor', {
      value: ['UNTRUSTED'], enumerable: true
    })
    const control = providerPayload('identity')
    control.tables[0].table.ths_stock_short_name_stock = ['bad\u0000value']
    const unicodeCc = providerPayload('identity')
    unicodeCc.tables[0].table.ths_stock_short_name_stock = ['bad\u0085value']
    const unicodeCf = providerPayload('identity')
    unicodeCf.tables[0].table.ths_stock_short_name_stock = ['bad\u202Evalue']
    const overlong = providerPayload('identity')
    overlong.tables[0].table.ths_stock_short_name_stock = ['x'.repeat(257)]
    const oversized = providerPayload('identity')
    oversized.tables[0].table.ths_stock_short_name_stock = Array.from({ length: 65 },
      (_, index) => index)
    const invalid = [
      { ...providerPayload('identity'), RequestId: 'UNTRUSTED' },
      { ...providerPayload('identity'), providerExtra: 'UNTRUSTED' },
      { ...providerPayload('identity'), tables: [{ ...providerPayload('identity').tables[0],
        RequestId: 'UNTRUSTED' }] },
      { ...providerPayload('identity'), tables: [{ thscode: '9988.HK', table: {
        ...summary('identity').fields, providerExtra: ['UNTRUSTED'] } }] },
      { errorcode: -403, tables: [{ thscode: '9988.HK', table: {
        ...summary('identity').fields, providerExtra: ['UNTRUSTED'] } }], dataVol: 1 },
      rootDangerous, tableDangerous, control, unicodeCc, unicodeCf, overlong, oversized
    ]
    for (const response of invalid) {
      const transport = createRequestStub([response])
      const client = createIfindHttpClient({ request: transport.request })
      await assert.rejects(client.probeFixed(Buffer.from('synthetic-access'), PROPOSAL_ID, 1),
        { code: 'IFIND_RESPONSE_SHAPE', stage: 'probe', requestCount: 1 })
      assert.equal(transport.calls.length, 1)
    }
    const printable = providerPayload('identity')
    printable.tables[0].table.ths_stock_short_name_stock = ['阿里巴巴-SW (Alibaba)，Inc.!']
    const printableTransport = createRequestStub([printable])
    const printableClient = createIfindHttpClient({ request: printableTransport.request })
    const printableTable = /** @type {Readonly<Record<string, unknown>>} */ (
      (await printableClient.probeFixed(Buffer.from('synthetic-access'),
        PROPOSAL_ID, 1)).payload.tables[0].table)
    assert.deepEqual(printableTable.ths_stock_short_name_stock,
    ['阿里巴巴-SW (Alibaba)，Inc.!'])
  }],
  ['strict initial and terminal DTO rejects hostile values without executing traps', async () => {
    domain = require('../domain/ifind-market-probe-result')
    createService = require('../services/ifind-market-probe-service').createIfindMarketProbeService
    assert.equal(domain.IFIND_MARKET_PROBE_RESULT_INVALID, 'IFIND_MARKET_PROBE_RESULT_INVALID')
    const initial = domain.createInitialIfindMarketProbeResult()
    assert.deepEqual(initial, { proposalId: PROPOSAL_ID, caseId: CASE_ID, displayCode: '9988.HK',
      status: 'ready', verification: Object.fromEntries(VERIFICATION_KEYS.map((key) => [key, 'unverified'])),
      observations: { identity: null, quote: null, financial: null }, requestCount: 0,
      businessRequestCount: 0, dataVol: null, attemptedAt: null, errorCode: null,
      failureStage: null })
    assertSafeResult(initial)
    for (const status of ['ready', 'busy', 'cooldown', 'daily-limit']) {
      assertSafeResult({ ...initial, status })
    }
    const observed = { ...initial, status: 'observed-unverified',
      observations: Object.fromEntries(STAGES.map((stage) => [stage, summary(stage)])),
      requestCount: 4, businessRequestCount: 3, dataVol: 3,
      attemptedAt: new Date(NOW).toISOString(),
      errorCode: 'IFIND_MARKET_PROBE_OBSERVED_UNVERIFIED' }
    assertSafeResult(observed)
    const failed = { ...observed, status: 'failed', observations: {
      identity: summary('identity'), quote: null, financial: null }, requestCount: 3,
      businessRequestCount: 2, errorCode: 'IFIND_MARKET_PROBE_FAILED', failureStage: 'quote' }
    assertSafeResult(failed)

    let traps = 0
    const hostile = (value) => new Proxy(value, {
      get() { traps += 1; throw new Error('UNTRUSTED') },
      ownKeys() { traps += 1; throw new Error('UNTRUSTED') },
      getPrototypeOf() { traps += 1; throw new Error('UNTRUSTED') },
      getOwnPropertyDescriptor() { traps += 1; throw new Error('UNTRUSTED') }
    })
    const accessor = Object.defineProperty({ ...initial }, 'status', { enumerable: true,
      get() { traps += 1; throw new Error('UNTRUSTED') } })
    const extraField = structuredClone(observed)
    extraField.observations.quote.fields.extra = ['UNTRUSTED']
    const dangerous = structuredClone(observed)
    Object.defineProperty(dangerous.observations.identity.fields, '__proto__', {
      value: ['UNTRUSTED'], enumerable: true
    })
    const overlong = structuredClone(observed)
    overlong.observations.identity.fields.ths_stock_short_name_stock = ['x'.repeat(257)]
    const oversized = structuredClone(observed)
    oversized.observations.quote.fields.latest = Array.from({ length: 65 }, (_, index) => index)
    const control = structuredClone(observed)
    control.observations.identity.fields.ths_stock_short_name_stock = ['bad\u0000value']
    const unicodeCc = structuredClone(observed)
    unicodeCc.observations.identity.fields.ths_stock_short_name_stock = ['bad\u0085value']
    const unicodeCf = structuredClone(observed)
    unicodeCf.observations.identity.fields.ths_stock_short_name_stock = ['bad\u202Evalue']
    const printable = structuredClone(observed)
    printable.observations.identity.fields.ths_stock_short_name_stock =
      ['阿里巴巴-SW (Alibaba)，Inc.!']
    assertSafeResult(printable)
    const sparse = structuredClone(observed)
    const sparseValues = Array(3)
    sparseValues[0] = 1
    sparseValues[2] = 3
    sparse.observations.quote.fields.latest = sparseValues
    const customPrototype = structuredClone(observed)
    Object.setPrototypeOf(customPrototype.observations.quote.fields.latest, null)
    const cyclic = structuredClone(observed)
    const cycle = []; cycle.push(cycle)
    cyclic.observations.quote.fields.latest = cycle
    const symbolArray = structuredClone(observed)
    symbolArray.observations.quote.fields.latest[Symbol('UNTRUSTED')] = true
    const invalid = [hostile(initial), { ...initial, observations: hostile(initial.observations) },
      { ...observed, observations: { ...observed.observations, quote: hostile({}) } }, accessor,
      { ...initial, extra: true }, { ...initial, [Symbol('extra')]: true }, extraField, dangerous,
      overlong, oversized, control, unicodeCc, unicodeCf, sparse, customPrototype, cyclic, symbolArray,
      { ...observed, verification: { ...observed.verification,
        scopeStatus: 'verified' } }, { ...observed, requestCount: 3 },
      { ...observed, observations: { ...observed.observations, financial: null } }]
    const accessorArray = structuredClone(observed)
    Object.defineProperty(accessorArray.observations.quote.fields.latest, '0', { enumerable: true,
      get() { traps += 1; throw new Error('UNTRUSTED') } })
    const proxyArray = structuredClone(observed)
    proxyArray.observations.quote.fields.latest = hostile([1])
    invalid.push(accessorArray, proxyArray)
    const revoked = Proxy.revocable({}, {}); revoked.revoke(); invalid.push(revoked.proxy)
    for (const value of invalid) assert.throws(() => domain.copyIfindMarketProbeResult(value),
      { code: 'IFIND_MARKET_PROBE_RESULT_INVALID' })
    assert.equal(traps, 0)
  }],
  ['fixed adapter performs exact requests, sanitizes output and never retries', async () => {
    const transport = createRequestStub(STAGES.map((stage) => providerPayload(stage)))
    const client = createIfindHttpClient({ request: transport.request })
    assert.deepEqual(Object.keys(client), ['diagnose', 'authenticate', 'quote', 'financial',
      'calibrateFinancial', 'diagnoseReportPeriod', 'probeFixed'])
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      const result = await client.probeFixed(Buffer.from('synthetic-access'), PROPOSAL_ID, sequence)
      const stage = STAGES[sequence - 1]
      assert.deepEqual(result, { stage, payload: sanitizedPayload(stage), requestCount: 1, dataVol: 1 })
    }
    assert.deepEqual(transport.calls.map((call) => ({ ...call,
      url: call.url.replace('https://quantapi.51ifind.com', '') })), ENDPOINTS.map((url, index) => ({
      url, method: 'POST', headers: { 'content-type': 'application/json',
        access_token: 'synthetic-access', ifindlang: 'cn' }, body: BODIES[index]
    })))

    for (const response of [providerPayload('identity', { tables: [{ thscode: '09988.HK',
      table: summary('identity').fields }] }), { errorcode: 0, tables: [] }]) {
      const badTransport = createRequestStub([response])
      const badClient = createIfindHttpClient({ request: badTransport.request })
      await assert.rejects(badClient.probeFixed(Buffer.from('synthetic-access'), PROPOSAL_ID, 1),
        { code: 'IFIND_RESPONSE_SHAPE', stage: 'probe', requestCount: 1 })
      assert.equal(badTransport.calls.length, 1)
    }
  }],
  ['fixed adapter maps provider errors and rejects invalid requests without retry', async () => {
    const providerFailures = [
      { vendorErrorCode: -401, code: 'IFIND_AUTH_REJECTED', errorClass: 'AUTH' },
      { vendorErrorCode: -403, code: 'IFIND_PERMISSION_REJECTED', errorClass: 'PERMISSION' },
      { vendorErrorCode: -429, code: 'IFIND_QUOTA_REJECTED', errorClass: 'QUOTA' },
      { vendorErrorCode: -777, code: 'IFIND_PROBE_REJECTED', errorClass: 'API' }
    ]
    for (const expected of providerFailures) {
      const transport = createRequestStub([{ errorcode: expected.vendorErrorCode }])
      const client = createIfindHttpClient({ request: transport.request })
      await assert.rejects(
        client.probeFixed(Buffer.from('synthetic-access'), PROPOSAL_ID, 1),
        (error) => {
          const actual = errorRecord(error)
          assert.deepEqual({ code: actual.code, errorClass: actual.class,
            vendorErrorCode: actual.vendorErrorCode, stage: actual.stage,
            requestCount: actual.requestCount }, { code: expected.code,
            errorClass: expected.errorClass, vendorErrorCode: expected.vendorErrorCode,
            stage: 'probe', requestCount: 1 })
          assert.equal(actual.failureCode, expected.code)
          assert.equal(actual.message, 'iFinD fixed market probe failed')
          assert.deepEqual(Object.keys(actual).sort(), [
            'class', 'code', 'failureCode', 'requestCount', 'stage', 'vendorErrorCode'
          ])
          assert.equal('cause' in actual, false)
          assert.doesNotMatch(`${actual.message}\n${JSON.stringify(actual)}`,
            /RequestId|errmsg|provider payload|synthetic-access/)
          return true
        }
      )
      assert.equal(transport.calls.length, 1)
    }

    /** @type {Array<[string, [string | Buffer, string, number]]>} */
    const invalidRequests = [
      ['non-buffer access token', ['synthetic-access', PROPOSAL_ID, 1]],
      ['empty access token', [Buffer.alloc(0), PROPOSAL_ID, 1]],
      ['unsupported proposal id', [Buffer.from('synthetic-access'), 'HK_OTHER_V1', 1]],
      ['sequence below range', [Buffer.from('synthetic-access'), PROPOSAL_ID, 0]],
      ['sequence above range', [Buffer.from('synthetic-access'), PROPOSAL_ID, 4]]
    ]
    for (const [name, args] of invalidRequests) {
      const transport = createRequestStub([])
      const client = createIfindHttpClient({ request: transport.request })
      await assert.rejects(client.probeFixed(...args), (error) => {
        const actual = errorRecord(error)
        assert.deepEqual({ code: actual.code, errorClass: actual.class,
          vendorErrorCode: actual.vendorErrorCode, stage: actual.stage,
          requestCount: actual.requestCount }, { code: 'IFIND_CONFIG_INVALID',
          errorClass: 'CONFIG', vendorErrorCode: null, stage: 'probe', requestCount: 0 }, name)
        assert.equal(actual.failureCode, 'IFIND_CONFIG_INVALID', name)
        assert.deepEqual(Object.keys(actual).sort(), [
          'class', 'code', 'failureCode', 'requestCount', 'stage', 'vendorErrorCode'
        ], name)
        assert.equal('cause' in actual, false, name)
        return true
      })
      assert.equal(transport.calls.length, 0, name)
    }
  }],
  ['service reserves first, runs auth plus three stages, settles failed and keeps observations memory-only',
    async () => using(async (value) => {
      const service = value.service()
      assertSafeResult(service.describe())
      const result = await service.run()
      assertSafeResult(result)
      assert.equal(result.status, 'observed-unverified')
      assert.deepEqual(result.observations, Object.fromEntries(STAGES.map((stage) => [stage, summary(stage)])))
      assert.deepEqual([result.requestCount, result.businessRequestCount, result.dataVol], [4, 3, 3])
      assert.deepEqual([value.state.reads, value.state.auth, value.state.probes.join(','), value.state.clears],
        [1, 1, '1,2,3', 1])
      const row = value.rows()[0]
      assert.deepEqual([row.status, row.quote_status, row.finance_status, row.request_count,
        row.failure_code], ['failed', 'not_run', 'not_run', 4,
        'IFIND_MARKET_PROBE_OBSERVED_UNVERIFIED'])
      assert.deepEqual(service.describe(), result)
      result.observations.identity.fields.ths_stock_short_name_stock[0] = 'MUTATED'
      assert.equal(service.describe().observations.identity.fields.ths_stock_short_name_stock[0],
        'SYNTHETIC_ALIBABA')
      assertClean(value)
    })],
  ['malformed reserved receipt grants no ownership and leaves stale-lease recovery authoritative', async () => {
    const corruptions = [
      (reserved) => ({ ...reserved, reservation: { ...reserved.reservation,
        leaseExpiresAt: 'UNTRUSTED' } }),
      (reserved) => ({ ...reserved, extra: 'UNTRUSTED' })
    ]
    for (const corrupt of corruptions) await using(async (value) => {
      let settlements = 0
      const repository = {
        quotaStatus: value.repository.quotaStatus.bind(value.repository),
        reserve(input) {
          const reserved = value.repository.reserve(input)
          return corrupt(reserved)
        },
        fail(input) {
          settlements += 1
          return value.repository.fail(input)
        }
      }
      const result = await value.service({ repository }).run()
      assertSafeResult(result)
      assert.equal(result.status, 'unavailable')
      const row = value.rows()[0]
      assert.equal(row.status, 'pending')
      assert.deepEqual([value.state.reads, value.state.clears, settlements], [0, 0, 0])
      assertClean(value)
    })
  }],
  ['unreadable or thrown reserve outcomes never acquire ownership', async () => {
    const scenarios = [
      { transform(reserved, trapped) { return new Proxy(reserved, {
        get() { trapped(); throw new Error('UNTRUSTED') },
        ownKeys() { trapped(); throw new Error('UNTRUSTED') },
        getOwnPropertyDescriptor() { trapped(); throw new Error('UNTRUSTED') }
      }) } },
      { transform(reserved, trapped) {
        return Object.defineProperty({ ...reserved }, 'status', { enumerable: true,
          get() { trapped(); throw new Error('UNTRUSTED') } })
      } },
      { transform(reserved) { const missing = { ...reserved }; delete missing.status; return missing } },
      { transform() { return { status: 'clock-rollback' } } },
      { throws: true }
    ]
    for (const scenario of scenarios) await using(async (value) => {
      let traps = 0
      let settlements = 0
      const repository = {
        quotaStatus: value.repository.quotaStatus.bind(value.repository),
        reserve() {
          if (scenario.throws) throw new Error('UNTRUSTED')
          return scenario.transform({ status: 'UNTRUSTED' }, () => { traps += 1 })
        },
        fail(input) {
          settlements += 1
          return value.repository.fail(input)
        }
      }
      const result = await value.service({ repository }).run()
      assertSafeResult(result)
      assert.equal(result.status, 'unavailable')
      assert.equal(result.errorCode, 'IFIND_MARKET_PROBE_UNAVAILABLE')
      assert.deepEqual(result.observations, { identity: null, quote: null, financial: null })
      assert.deepEqual([value.state.reads, value.state.clears, settlements, traps], [0, 0, 0, 0])
      assert.equal(value.rows().length, 0)
      assertClean(value)
    })
  }],
  ['pre-existing duplicate tuple is never settled by the second invocation', async () =>
    using(async (value) => {
      const duplicateId = runId()
      const first = value.repository.reserve({ runId: duplicateId, caseId: CASE_ID,
        createdAt: NOW, tokenVersionId: VERSION })
      assert.equal(first.status, 'reserved')
      let settlements = 0
      const repository = {
        reserve: value.repository.reserve.bind(value.repository),
        quotaStatus: value.repository.quotaStatus.bind(value.repository),
        fail(input) { settlements += 1; return value.repository.fail(input) }
      }
      const result = await value.service({ repository, idGenerator: () => duplicateId }).run()
      assertSafeResult(result)
      assert.equal(result.status, 'unavailable')
      assert.deepEqual([value.state.reads, value.state.clears, settlements], [0, 0, 0])
      assert.equal(value.rows()[0].status, 'pending')
      assertClean(value)
    })],
  ['busy, cooldown and shared daily limits never read secrets', async () => {
    await using(async (value) => {
      let settlements = 0
      const pending = value.repository.reserve({ runId: runId(), caseId: 'US_APPLE_AAPL',
        createdAt: NOW, tokenVersionId: VERSION })
      assert.equal(pending.status, 'reserved')
      const repository = { reserve: value.repository.reserve.bind(value.repository),
        quotaStatus: value.repository.quotaStatus.bind(value.repository),
        fail(input) { settlements += 1; return value.repository.fail(input) } }
      assert.equal((await value.service({ repository }).run()).status, 'busy')
      assert.deepEqual([value.state.reads, value.state.clears, settlements], [0, 0, 0])
    })
    for (const limit of ['cooldown', 'case', 'global']) await using(async (value) => {
      let settlements = 0
      if (limit === 'cooldown') seed(value, CASE_ID, NOW)
      if (limit === 'case') for (let index = 0; index < 5; index += 1) {
        seed(value, CASE_ID, NOW + index * COOLDOWN)
      }
      if (limit === 'global') for (let index = 0; index < 12; index += 1) {
        seed(value, [CASE_ID, 'US_APPLE_AAPL', 'CN_MOUTAI_600519'][index % 3],
          NOW + index * COOLDOWN)
      }
      value.state.now = limit === 'cooldown' ? NOW : NOW + 13 * COOLDOWN
      const repository = { reserve: value.repository.reserve.bind(value.repository),
        quotaStatus: value.repository.quotaStatus.bind(value.repository),
        fail(input) { settlements += 1; return value.repository.fail(input) } }
      assert.equal((await value.service({ repository }).run()).status,
        limit === 'cooldown' ? 'cooldown' : 'daily-limit')
      assert.deepEqual([value.state.reads, value.state.clears, settlements], [0, 0, 0])
    })
  }],
  ['secret, auth and each business failure stage have exact counts and no retries', async () => {
    const cleanError = (errorClass, code) => Object.assign(new Error('safe client failure'), {
      code, failureCode: code, class: errorClass, vendorErrorCode: null,
      stage: 'probe', requestCount: 1
    })
    const cases = [
      { name: 'secret', expectedStatus: 'unavailable', requestCount: 0,
        businessRequestCount: 0, failureStage: 'provider', probes: [], dataVol: null },
      { name: 'auth', expectedStatus: 'failed', requestCount: 1,
        businessRequestCount: 0, failureStage: 'auth', probes: [], dataVol: null },
      { name: 'identity', errorClass: 'AUTH', code: 'IFIND_AUTH_REJECTED', sequence: 1,
        expectedStatus: 'failed', requestCount: 2, businessRequestCount: 1,
        failureStage: 'identity', probes: [1], dataVol: null },
      { name: 'quote', errorClass: 'PERMISSION', code: 'IFIND_PERMISSION_REJECTED', sequence: 2,
        expectedStatus: 'failed', requestCount: 3, businessRequestCount: 2,
        failureStage: 'quote', probes: [1, 2], dataVol: 1 },
      { name: 'financial', errorClass: 'QUOTA', code: 'IFIND_QUOTA_REJECTED', sequence: 3,
        expectedStatus: 'failed', requestCount: 4, businessRequestCount: 3,
        failureStage: 'financial', probes: [1, 2, 3], dataVol: 2 }
    ]
    for (const scenario of cases) await using(async (value) => {
      if (scenario.name === 'secret') value.secretProvider.readRefreshToken = () => {
        value.state.reads += 1
        throw new Error('safe secret failure')
      }
      if (scenario.name === 'auth') value.client.authenticate = async () => {
        value.state.auth += 1
        throw cleanError('AUTH', 'IFIND_AUTH_REJECTED')
      }
      if (scenario.sequence) value.client.probeFixed = async (accessToken, proposalId, sequence) => {
        value.state.probes.push(sequence)
        if (sequence === scenario.sequence) throw cleanError(scenario.errorClass, scenario.code)
        const stage = STAGES[sequence - 1]
        return { stage, payload: sanitizedPayload(stage), requestCount: 1, dataVol: 1 }
      }
      const result = await value.service().run()
      assertSafeResult(result)
      assert.deepEqual([result.status, result.requestCount, result.businessRequestCount,
        result.failureStage, result.dataVol], [scenario.expectedStatus, scenario.requestCount,
        scenario.businessRequestCount, scenario.failureStage, scenario.dataVol])
      assert.deepEqual(value.state.probes, scenario.probes)
      assert.equal(value.rows()[0].request_count, scenario.requestCount)
      assert.equal(value.state.clears, 1)
      assertClean(value)
    })
  }],
  ['lease remains valid at minus one and fails closed at the exact boundary', async () => {
    /** @type {Array<[number, 'observed-unverified' | 'failed']>} */
    const leaseCases = [[-1, 'observed-unverified'], [0, 'failed']]
    for (const [offset, expectedStatus] of leaseCases) {
      await using(async (value) => {
        const gate = deferred(); const entered = deferred()
        const original = value.client.probeFixed
        value.client.probeFixed = async function (...args) {
          const output = await original.apply(this, args)
          if (args[2] === 3) { entered.resolve(); await gate.promise }
          return output
        }
        const running = value.service().run()
        await entered.promise
        value.state.now = NOW + LEASE + offset
        gate.resolve()
        const result = await running
        assertSafeResult(result)
        assert.equal(result.status, expectedStatus)
        assert.deepEqual([result.requestCount, result.businessRequestCount], [4, 3])
        assert.deepEqual(value.state.probes, [1, 2, 3])
        assert.equal(value.rows()[0].request_count, 4)
        if (offset === 0) {
          assert.equal(result.failureStage, 'lease')
          assert.deepEqual(result.observations, {
            identity: summary('identity'), quote: summary('quote'), financial: null
          })
        }
        assertClean(value)
      })
    }
  }],
  ['shared-client contention cannot clear the active owner', async () => using(async (value) => {
    const gate = deferred(); const entered = deferred()
    const original = value.client.probeFixed
    value.client.probeFixed = async function (...args) {
      const output = await original.apply(this, args)
      if (args[2] === 1) { entered.resolve(); await gate.promise }
      return output
    }
    const owner = value.service()
    const contender = value.service()
    const running = owner.run()
    await entered.promise
    assert.equal((await contender.run()).status, 'busy')
    assert.equal(value.state.clears, 0)
    gate.resolve()
    assert.equal((await running).status, 'observed-unverified')
    assert.equal(value.state.clears, 1)
    assertClean(value)
  })],
  ['hostile output fails closed without retry and still settles shared quota', async () => {
    const mutations = [
      (output) => { output.extra = 'UNTRUSTED' },
      (output) => { output.payload.RequestId = 'UNTRUSTED' },
      (output) => { output.payload.tables[0].table.extra = ['UNTRUSTED'] },
      (output) => { output.payload.tables[0].table[Symbol('UNTRUSTED')] = true },
      (output, trapped) => { output.payload = new Proxy({}, {
        get() { trapped(); throw new Error('UNTRUSTED') },
        ownKeys() { trapped(); throw new Error('UNTRUSTED') }
      }) },
      (output, trapped) => Object.defineProperty(output.payload, 'tables', { enumerable: true,
        get() { trapped(); throw new Error('UNTRUSTED') } }),
      (output) => { output.payload.tables[0].table.latest = ['bad\u0000value'] },
      (output) => { output.payload.tables[0].table.latest = ['bad\u0085value'] },
      (output) => { output.payload.tables[0].table.latest = ['bad\u202Evalue'] },
      (output) => { output.payload.tables[0].table.latest = ['x'.repeat(257)] },
      (output) => { output.payload.tables[0].table.latest = Array.from({ length: 65 },
        (_, index) => index) },
      (output) => {
        const sparseValues = Array(3)
        sparseValues[0] = 1
        sparseValues[2] = 3
        output.payload.tables[0].table.latest = sparseValues
      },
      (output) => Object.setPrototypeOf(output.payload.tables[0].table.latest, null),
      (output) => { const cycle = []; cycle.push(cycle); output.payload.tables[0].table.latest = cycle }
    ]
    for (const mutate of mutations) await using(async (value) => {
      let traps = 0
      value.client.probeFixed = async (accessToken, proposalId, sequence) => {
        value.state.probes.push(sequence)
        if (sequence === 1) return { stage: 'identity', payload: sanitizedPayload('identity'),
          requestCount: 1, dataVol: 1 }
        const output = { stage: 'quote', payload: sanitizedPayload('quote'),
          requestCount: 1, dataVol: 1 }
        mutate(output, () => { traps += 1 })
        return output
      }
      const result = await value.service().run()
      assertSafeResult(result)
      assert.equal(result.status, 'failed')
      assert.deepEqual(value.state.probes, [1, 2])
      assert.deepEqual(result.observations, { identity: summary('identity'), quote: null, financial: null })
      assert.equal(value.rows()[0].request_count, 3)
      assert.equal(traps, 0)
      assertClean(value)
    })
  }],
  ['settlement conflict discards observations and clear invalidates late observation', async () => {
    await using(async (value) => {
      const repository = { reserve: value.repository.reserve.bind(value.repository),
        quotaStatus: value.repository.quotaStatus.bind(value.repository),
        fail() { return { status: 'conflict' } } }
      const service = value.service({ repository })
      const result = await service.run()
      assertSafeResult(result)
      assert.equal(result.status, 'unavailable')
      assert.deepEqual(result.observations, { identity: null, quote: null, financial: null })
      assert.deepEqual(service.describe().observations, result.observations)
      assertClean(value)
    })
    await using(async (value) => {
      const gate = deferred()
      const entered = deferred()
      const original = value.client.probeFixed
      value.client.probeFixed = async function (...args) {
        const result = await original.apply(this, args)
        if (args[2] === 3) { entered.resolve(); await gate.promise }
        return result
      }
      const service = value.service()
      const running = service.run()
      await entered.promise
      service.clear()
      assert.equal((await service.run()).status, 'busy')
      gate.resolve()
      const result = await running
      assertSafeResult(result)
      assert.equal(result.status, 'failed')
      assert.deepEqual(result.observations, { identity: null, quote: null, financial: null })
      assert.deepEqual([value.rows()[0].request_count, value.rows()[0].failure_code],
        [result.requestCount, result.errorCode])
      assert.deepEqual(service.describe().observations, result.observations)
      assertClean(value)
    })
    await using(async (value) => {
      const cleanup = deferred(); const entered = deferred()
      value.client.clear = async () => {
        value.state.clears += 1
        entered.resolve()
        await cleanup.promise
      }
      const service = value.service()
      const running = service.run()
      await entered.promise
      const settled = value.rows()[0]
      assert.deepEqual([settled.status, settled.failure_code],
        ['failed', 'IFIND_MARKET_PROBE_OBSERVED_UNVERIFIED'])
      service.clear()
      cleanup.resolve()
      const result = await running
      assertSafeResult(result)
      assert.equal(result.status, 'observed-unverified')
      assert.equal(result.errorCode, settled.failure_code)
      assert.equal(service.describe().status, 'cooldown')
      assertClean(value)
    })
  }]
]

module.exports = { run: async function () {
  for (const [name, operation] of tests) {
    await operation()
    console.log('PASS market-probe-runtime: ' + name)
  }
  console.log(`ifind-market-probe-runtime: ${tests.length} tests passed`)
} }

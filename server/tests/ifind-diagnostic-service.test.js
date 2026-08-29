const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { DatabaseSync } = require('node:sqlite')

const VERSION_ID = 'v20260826-001'
const ROUTE = '/api/v1/get_trade_dates'
const SCOPE = 'market-trade-dates:212001:D:-10'

/** @returns {any} */
function dynamicEmitter() {
  return new EventEmitter()
}

function createRepository() {
  const { IfindDiagnosticRepository } = require('../db/ifind-diagnostic-repository')
  const database = new DatabaseSync(':memory:')
  const repository = new IfindDiagnosticRepository(database)
  repository.initialize()
  return { database, repository }
}

function successResult(overrides = {}) {
  return {
    route: ROUTE,
    scope: SCOPE,
    retrievedAt: '2026-08-26T02:00:00.010Z',
    timezone: 'Asia/Shanghai',
    elapsedMs: 10,
    requestCount: 2,
    dataVol: 11,
    officialQuotaStatus: 'unavailable',
    completeness: 'complete',
    ...overrides
  }
}

function createEnabledService(overrides = {}) {
  const { createIfindDiagnosticService } = require('../services/ifind-diagnostic-service')
  const state = createRepository()
  let now = Date.parse('2026-08-26T02:00:00.000Z')
  let id = 0
  const tokenBuffers = []
  const secretProvider = {
    readRefreshToken() {
      const token = Buffer.from('synthetic-refresh-token')
      tokenBuffers.push(token)
      return token
    }
  }
  const client = {
    diagnose: async () => successResult(),
    clear() {}
  }
  const service = createIfindDiagnosticService({
    mode: 'admin-diagnostic',
    tokenVersionId: VERSION_ID,
    repository: state.repository,
    client,
    secretProvider,
    clock: () => new Date(now),
    idSource: () => `diag_${String(++id).padStart(24, '0')}`,
    ...overrides
  })
  return {
    ...state,
    service,
    client,
    secretProvider,
    tokenBuffers,
    setNow(value) { now = value }
  }
}

function clientFailure(errorClass, overrides = {}) {
  const error = /** @type {Error & Record<string, any>} */ (
    new Error('raw provider marker must not escape')
  )
  error.class = errorClass
  error.code = 'RAW_PROVIDER_CODE'
  error.failureCode = {
    AUTH: 'IFIND_AUTH_REJECTED',
    CONFIG: 'IFIND_CONFIG_INVALID',
    PERMISSION: 'IFIND_PERMISSION_REJECTED',
    NETWORK: 'IFIND_NETWORK_FAILED'
  }[errorClass] || 'RAW_PROVIDER_CODE'
  error.vendorErrorCode = null
  error.stage = {
    AUTH: 'auth',
    PERMISSION: 'probe',
    QUOTA: 'probe',
    NETWORK: null,
    API: 'probe',
    CONFIG: null
  }[errorClass] ?? null
  error.headers = { authorization: 'secret' }
  error.RequestId = 'raw-request-id'
  Object.assign(error, overrides)
  return error
}

function createRequestStub(responseBodies) {
  const pending = [...responseBodies]
  const calls = []
  function request(url, options, callback) {
    calls.push(String(url))
    const outgoing = dynamicEmitter()
    outgoing.write = () => {}
    outgoing.end = () => {
      const body = pending.shift()
      queueMicrotask(() => {
        const incoming = dynamicEmitter()
        incoming.statusCode = 200
        incoming.destroy = () => {}
        callback(incoming)
        incoming.emit('data', Buffer.from(JSON.stringify(body)))
        incoming.emit('end')
      })
    }
    outgoing.destroy = () => {}
    return outgoing
  }
  return { calls, request }
}

function createStageFailureTransport(scenarios) {
  const pending = [...scenarios]
  const calls = []
  function request(url, _options, callback) {
    const scenario = pending.shift()
    calls.push(String(url))
    const outgoing = dynamicEmitter()
    outgoing.write = () => {}
    outgoing.destroy = () => {}
    outgoing.setTimeout = (milliseconds, handler) => {
      if (scenario && scenario.timeout && milliseconds > 0) {
        queueMicrotask(handler)
      }
    }
    outgoing.end = () => {
      if (scenario && scenario.timeout) return
      queueMicrotask(() => {
        if (scenario && scenario.networkError) {
          outgoing.emit('error', new Error('raw network marker'))
          return
        }
        const incoming = dynamicEmitter()
        incoming.statusCode = 200
        incoming.destroy = () => {}
        callback(incoming)
        incoming.emit('data', Buffer.from(JSON.stringify(scenario.body)))
        incoming.emit('end')
      })
    }
    return outgoing
  }
  return { calls, request }
}

function wrapRepository(repository, overrides = {}) {
  return {
    reserve: repository.reserve.bind(repository),
    complete: repository.complete.bind(repository),
    fail: repository.fail.bind(repository),
    latest: repository.latest.bind(repository),
    status: repository.status.bind(repository),
    ...overrides
  }
}

async function run() {
  const {
    IfindDiagnosticServiceError,
    createIfindDiagnosticService
  } = require('../services/ifind-diagnostic-service')

  let disabledClientTouches = 0
  const disabledClient = {}
  Object.defineProperties(disabledClient, {
    diagnose: { get() { disabledClientTouches += 1; throw new Error('client touched') } },
    clear: { get() { disabledClientTouches += 1; throw new Error('client touched') } }
  })
  const disabled = createIfindDiagnosticService({
    mode: 'disabled',
    tokenVersionId: null,
    repository: null,
    client: disabledClient,
    secretProvider: null,
    clock: () => new Date(0),
    idSource: () => 'unused'
  })
  assert.deepEqual(disabled.status(), {
    mode: 'disabled',
    configured: false,
    tokenVersionId: null,
    officialQuotaStatus: 'unavailable',
    cooldownUntil: null,
    localAttemptCount: 0,
    inFlight: false,
    latest: null
  })
  assert.deepEqual(await disabled.run(), {
    status: 'disabled',
    safeErrorClass: 'CONFIG'
  })
  assert.equal(disabledClientTouches, 0)

  const successful = createEnabledService()
  let receivedToken
  successful.client.diagnose = async (input) => {
    assert.deepEqual(Object.keys(input), ['refreshToken'])
    receivedToken = input.refreshToken
    return successResult({ requestCount: 4 })
  }
  const success = await successful.service.run()
  assert.equal(success.status, 'completed')
  assert.equal(success.safeErrorClass, null)
  assert.equal(success.diagnostic.requestCount, 4)
  assert.equal(success.diagnostic.authStatus, 'success')
  assert.equal(success.diagnostic.probeStatus, 'success')
  assert.equal(success.diagnostic.scope, SCOPE)
  assert.equal(success.diagnostic.officialQuotaStatus, 'unavailable')
  assert.equal(success.localAttemptCount, 1)
  assert.equal(successful.repository.status(Date.parse('2026-08-26T02:00:00.010Z')).localAttemptCount, 1)
  assert.equal(successful.repository.latest().requestCount, 4)
  assert.equal(successful.repository.latest().failureCode, null)
  assert.equal(successful.repository.latest().vendorErrorCode, null)
  assert.equal(Buffer.isBuffer(receivedToken), true)
  assert.equal((/** @type {Buffer} */ (receivedToken)).every((byte) => byte === 0), true)
  assert.equal(successful.tokenBuffers.every((buffer) => buffer.every((byte) => byte === 0)), true)
  assert.deepEqual(Object.keys(success.diagnostic).sort(), [
    'authStatus',
    'completedAt',
    'completeness',
    'dataVol',
    'diagnosticId',
    'elapsedMs',
    'officialQuotaStatus',
    'probeStatus',
    'requestCount',
    'route',
    'safeErrorClass',
    'scope',
    'startedAt',
    'tokenVersionId'
  ])
  successful.database.close()

  const legacyFailure = createEnabledService()
  legacyFailure.repository.latest = () => ({
    diagnosticId: 'diag_000000000000000000000778',
    startedAt: 1777777777000,
    completedAt: 1777777777010,
    authStatus: 'success',
    probeStatus: 'failed',
    safeErrorClass: 'API',
    failureCode: 'IFIND_LEGACY_DIAGNOSTIC_FAILURE',
    vendorErrorCode: null,
    route: ROUTE,
    requestCount: 2,
    dataVol: null,
    elapsedMs: 10,
    completeness: 'unavailable',
    tokenVersionId: VERSION_ID
  })
  const legacyFailureStatus = legacyFailure.service.status()
  assert.equal(legacyFailureStatus.latest.safeErrorClass, 'API')
  assert.equal(Object.hasOwn(legacyFailureStatus.latest, 'failureCode'), false)
  assert.equal(Object.hasOwn(legacyFailureStatus.latest, 'vendorErrorCode'), false)
  legacyFailure.database.close()

  let invalidSecretClientCalls = 0
  const invalidSecret = createEnabledService({
    secretProvider: { readRefreshToken: () => null },
    client: {
      diagnose: async () => {
        invalidSecretClientCalls += 1
        return successResult()
      },
      clear() {}
    }
  })
  const invalidSecretOutcome = await invalidSecret.service.run()
  assert.equal(invalidSecretOutcome.status, 'failed')
  assert.equal(invalidSecretOutcome.diagnostic.safeErrorClass, 'CONFIG')
  assert.equal(invalidSecretOutcome.diagnostic.requestCount, 0)
  assert.equal(invalidSecretOutcome.localAttemptCount, 1)
  assert.equal(invalidSecretClientCalls, 0)
  assert.equal(invalidSecret.repository.latest().requestCount, 0)
  assert.equal(
    invalidSecret.repository.status(Date.parse('2026-08-26T02:00:00.000Z')).localAttemptCount,
    1
  )
  invalidSecret.database.close()

  let throwingSecretClientCalls = 0
  const throwingSecretError = /** @type {Error & Record<string, any>} */ (
    new Error('throwing secret provider raw marker')
  )
  throwingSecretError.class = 'CONFIG'
  throwingSecretError.requestCount = 4
  throwingSecretError.failureCode = 'IFIND_CONFIG_INVALID'
  throwingSecretError.vendorErrorCode = null
  const throwingSecret = createEnabledService({
    secretProvider: {
      readRefreshToken() { throw throwingSecretError }
    },
    client: {
      diagnose: async () => {
        throwingSecretClientCalls += 1
        return successResult()
      },
      clear() {}
    }
  })
  const throwingSecretOutcome = await throwingSecret.service.run()
  assert.equal(throwingSecretOutcome.status, 'failed')
  assert.equal(throwingSecretOutcome.diagnostic.safeErrorClass, 'CONFIG')
  assert.equal(throwingSecretOutcome.diagnostic.requestCount, 0)
  assert.equal(throwingSecretClientCalls, 0)
  assert.equal(throwingSecret.repository.latest().requestCount, 0)
  assert.equal(JSON.stringify(throwingSecretOutcome).includes('raw marker'), false)
  throwingSecret.database.close()

  const busyState = createEnabledService()
  const occupied = busyState.repository.reserve({
    diagnosticId: 'diag_999999999999999999999999',
    startedAt: Date.parse('2026-08-26T02:00:00.000Z'),
    tokenVersionId: VERSION_ID
  })
  let busyClientCalls = 0
  busyState.client.diagnose = async () => { busyClientCalls += 1; return successResult() }
  assert.deepEqual(await busyState.service.run(), {
    status: 'busy',
    safeErrorClass: 'BUSY',
    retryAt: occupied.reservation.inFlightExpiresAt,
    localAttemptCount: 1
  })
  assert.equal(busyClientCalls, 0)
  busyState.database.close()

  for (const scenario of [
    {
      error: clientFailure('AUTH', { requestCount: 1 }),
      expected: { authStatus: 'failed', probeStatus: 'not_run', safeErrorClass: 'AUTH', requestCount: 1 }
    },
    {
      error: clientFailure('CONFIG', { requestCount: 0 }),
      expected: { authStatus: 'failed', probeStatus: 'not_run', safeErrorClass: 'CONFIG', requestCount: 0 }
    },
    {
      error: clientFailure('PERMISSION', { requestCount: 2, dataVol: 7 }),
      expected: { authStatus: 'success', probeStatus: 'failed', safeErrorClass: 'PERMISSION', requestCount: 2, dataVol: 7 }
    },
    {
      error: clientFailure('NETWORK', { requestCount: 3 }),
      expected: { authStatus: 'unknown', probeStatus: 'failed', safeErrorClass: 'NETWORK', requestCount: 3 }
    },
    {
      error: clientFailure('NOT_APPROVED', { requestCount: 1 }),
      expected: { authStatus: 'unknown', probeStatus: 'failed', safeErrorClass: 'API', requestCount: 1 },
      persisted: { failureCode: 'IFIND_CLIENT_FAILED', vendorErrorCode: null }
    },
    {
      error: clientFailure('NETWORK', { requestCount: Number.MAX_SAFE_INTEGER }),
      expected: { authStatus: 'unknown', probeStatus: 'failed', safeErrorClass: 'NETWORK', requestCount: 1 }
    },
    {
      error: clientFailure('NETWORK', { requestCount: -1 }),
      expected: { authStatus: 'unknown', probeStatus: 'failed', safeErrorClass: 'NETWORK', requestCount: 1 }
    }
  ]) {
    const state = createEnabledService()
    state.client.diagnose = async () => { throw scenario.error }
    const outcome = await state.service.run()
    assert.equal(outcome.status, 'failed')
    for (const [key, value] of Object.entries(scenario.expected)) {
      assert.equal(outcome.diagnostic[key], value)
    }
    const serialized = JSON.stringify(outcome)
    for (const marker of ['raw provider marker', 'RAW_PROVIDER_CODE', 'authorization', 'raw-request-id']) {
      assert.equal(serialized.includes(marker), false)
    }
    assert.equal(state.repository.latest().safeErrorClass, scenario.expected.safeErrorClass)
    const persisted = state.repository.latest()
    assert.equal(
      persisted.failureCode,
      scenario.persisted?.failureCode || scenario.error.failureCode
    )
    assert.equal(
      persisted.vendorErrorCode,
      scenario.persisted?.vendorErrorCode || null
    )
    assert.equal(Object.hasOwn(outcome.diagnostic, 'failureCode'), false)
    assert.equal(Object.hasOwn(outcome.diagnostic, 'vendorErrorCode'), false)
    state.database.close()
  }

  const vendorFailure = createEnabledService()
  vendorFailure.client.diagnose = async () => {
    throw clientFailure('API', {
      failureCode: 'IFIND_PROBE_REJECTED',
      vendorErrorCode: -999,
      requestCount: 2,
      errmsg: 'provider errmsg must not escape',
      rawResponse: 'provider response body must not escape',
      token: 'provider token must not escape'
    })
  }
  const vendorFailureOutcome = await vendorFailure.service.run()
  assert.equal(Object.hasOwn(vendorFailureOutcome.diagnostic, 'failureCode'), false)
  assert.equal(Object.hasOwn(vendorFailureOutcome.diagnostic, 'vendorErrorCode'), false)
  assert.equal(vendorFailure.repository.latest().failureCode, 'IFIND_PROBE_REJECTED')
  assert.equal(vendorFailure.repository.latest().vendorErrorCode, -999)
  for (const marker of [
    'provider errmsg', 'provider response body', 'provider token', 'raw-request-id'
  ]) {
    assert.equal(JSON.stringify(vendorFailureOutcome).includes(marker), false)
    assert.equal(JSON.stringify(vendorFailure.repository.latest()).includes(marker), false)
  }
  assert.equal(Object.hasOwn(vendorFailure.service.status().latest, 'failureCode'), false)
  assert.equal(Object.hasOwn(vendorFailure.service.status().latest, 'vendorErrorCode'), false)
  vendorFailure.database.close()

  let accessorReads = 0
  const accessorFailure = /** @type {Error & Record<string, any>} */ (
    new Error('hostile accessor error')
  )
  accessorFailure.class = 'API'
  accessorFailure.stage = 'probe'
  accessorFailure.requestCount = 2
  accessorFailure.vendorErrorCode = null
  Object.defineProperty(accessorFailure, 'failureCode', {
    enumerable: true,
    get() {
      accessorReads += 1
      return 'IFIND_PROBE_REJECTED'
    }
  })
  const hostileClientErrors = [
    clientFailure('AUTH', {
      failureCode: 'IFIND_PROBE_REJECTED',
      vendorErrorCode: -999,
      stage: 'probe',
      requestCount: 2
    }),
    clientFailure('PERMISSION', {
      failureCode: 'IFIND_PERMISSION_REJECTED',
      vendorErrorCode: -403,
      stage: 'auth',
      requestCount: 2
    }),
    clientFailure('NETWORK', {
      failureCode: 'IFIND_NETWORK_FAILED',
      vendorErrorCode: -500,
      stage: 'probe',
      requestCount: 2
    }),
    clientFailure('CONFIG', {
      failureCode: 'IFIND_DIAGNOSTIC_STALE_RESERVATION',
      vendorErrorCode: null,
      stage: null,
      requestCount: 0
    }),
    clientFailure('API', {
      failureCode: 'IFIND_LEGACY_DIAGNOSTIC_FAILURE',
      vendorErrorCode: null,
      stage: null,
      requestCount: 1
    }),
    accessorFailure
  ]
  for (const hostileError of hostileClientErrors) {
    const hostileClient = createEnabledService()
    hostileClient.client.diagnose = async () => { throw hostileError }
    const hostileOutcome = await hostileClient.service.run()
    assert.equal(hostileOutcome.status, 'failed')
    assert.equal(hostileOutcome.diagnostic.safeErrorClass, 'API')
    assert.equal(hostileClient.repository.latest().failureCode, 'IFIND_CLIENT_FAILED')
    assert.equal(hostileClient.repository.latest().vendorErrorCode, null)
    hostileClient.database.close()
  }
  assert.equal(accessorReads, 0)

  const { createIfindHttpClient } = require('../adapters/ifind-http-client')
  const exhaustedTransport = createRequestStub([
    { errorcode: 0, data: { access_token: 'synthetic-access-token' } },
    { errorcode: -401, errmsg: 'synthetic first rejection' },
    { errorcode: 0, data: { access_token: 'synthetic-recovered-access-token' } },
    { errorcode: -401, errmsg: 'synthetic exhausted rejection' }
  ])
  const realClient = createIfindHttpClient({
    request: exhaustedTransport.request,
    now: () => new Date('2026-08-26T02:00:00.000Z')
  })
  const integrated = createEnabledService({ client: realClient })
  const integratedOutcome = await integrated.service.run()
  assert.equal(integratedOutcome.status, 'failed')
  assert.equal(integratedOutcome.diagnostic.safeErrorClass, 'AUTH')
  assert.equal(integratedOutcome.diagnostic.requestCount, 4)
  assert.equal(integratedOutcome.localAttemptCount, 1)
  assert.equal(integrated.repository.latest().requestCount, 4)
  assert.equal(integrated.repository.latest().failureCode, 'IFIND_AUTH_REJECTED')
  assert.equal(integrated.repository.latest().vendorErrorCode, -401)
  assert.equal(
    integrated.repository.status(Date.parse('2026-08-26T02:00:00.000Z')).localAttemptCount,
    1
  )
  assert.equal(exhaustedTransport.calls.length, 4)
  integrated.database.close()

  for (const scenario of [
    {
      name: 'authentication network failure',
      transport: [{ networkError: true }],
      expected: {
        authStatus: 'failed', probeStatus: 'not_run',
        safeErrorClass: 'NETWORK', requestCount: 1
      }
    },
    {
      name: 'authentication timeout',
      transport: [{ timeout: true }],
      expected: {
        authStatus: 'failed', probeStatus: 'not_run',
        safeErrorClass: 'NETWORK', requestCount: 1
      }
    },
    {
      name: 'authentication format failure',
      transport: [{ body: {} }],
      expected: {
        authStatus: 'failed', probeStatus: 'not_run',
        safeErrorClass: 'API', requestCount: 1
      }
    },
    {
      name: 'probe network failure',
      transport: [
        { body: { errorcode: 0, data: { access_token: 'synthetic-access-token' } } },
        { networkError: true }
      ],
      expected: {
        authStatus: 'success', probeStatus: 'failed',
        safeErrorClass: 'NETWORK', requestCount: 2
      }
    }
  ]) {
    const transport = createStageFailureTransport(scenario.transport)
    const client = createIfindHttpClient({
      request: transport.request,
      now: () => new Date('2026-08-26T02:00:00.000Z')
    })
    const state = createEnabledService({ client })
    const outcome = await state.service.run()
    assert.equal(outcome.status, 'failed', scenario.name)
    for (const [key, value] of Object.entries(scenario.expected)) {
      assert.equal(outcome.diagnostic[key], value, `${scenario.name}: ${key}`)
      assert.equal(state.repository.latest()[key], value, `${scenario.name}: persisted ${key}`)
    }
    assert.equal(transport.calls.length, scenario.expected.requestCount)
    state.database.close()
  }

  const malformedCount = createEnabledService()
  malformedCount.client.diagnose = async () => successResult({
    route: '/malformed-route',
    requestCount: 4
  })
  const malformedCountOutcome = await malformedCount.service.run()
  assert.equal(malformedCountOutcome.status, 'failed')
  assert.equal(malformedCountOutcome.diagnostic.safeErrorClass, 'API')
  assert.equal(malformedCountOutcome.diagnostic.requestCount, 4)
  assert.equal(malformedCount.repository.latest().requestCount, 4)
  malformedCount.database.close()

  const hostileSuccessZero = createEnabledService()
  hostileSuccessZero.client.diagnose = async () => successResult({ requestCount: 0 })
  const hostileSuccessZeroOutcome = await hostileSuccessZero.service.run()
  assert.equal(hostileSuccessZeroOutcome.status, 'failed')
  assert.equal(hostileSuccessZeroOutcome.diagnostic.safeErrorClass, 'API')
  assert.equal(hostileSuccessZeroOutcome.diagnostic.requestCount, 1)
  assert.equal(hostileSuccessZero.repository.latest().requestCount, 1)
  hostileSuccessZero.database.close()

  const invalidResponse = createEnabledService()
  invalidResponse.client.diagnose = async () => ({
    ...successResult(),
    rawResponse: { refresh_token: 'secret-marker' }
  })
  const invalidOutcome = await invalidResponse.service.run()
  assert.equal(invalidOutcome.status, 'failed')
  assert.equal(invalidOutcome.diagnostic.safeErrorClass, 'API')
  assert.equal(JSON.stringify(invalidOutcome).includes('secret-marker'), false)
  invalidResponse.database.close()

  const repositoryFailure = createEnabledService()
  repositoryFailure.repository.reserve = () => { throw new Error('database-path-marker') }
  assert.deepEqual(await repositoryFailure.service.run(), {
    status: 'internal-error',
    safeErrorClass: 'API'
  })
  repositoryFailure.database.close()

  const completionFailure = createEnabledService()
  let completionCalls = 0
  completionFailure.repository.complete = () => {
    completionCalls += 1
    throw new Error('completion-cause-marker')
  }
  completionFailure.client.diagnose = async () => successResult()
  assert.deepEqual(await completionFailure.service.run(), {
    status: 'internal-error',
    safeErrorClass: 'API'
  })
  assert.equal(completionCalls, 2)
  completionFailure.database.close()

  const responseLostState = createRepository()
  let responseLostCalls = 0
  const responseLostRepository = wrapRepository(responseLostState.repository, {
    complete(input) {
      responseLostCalls += 1
      const result = responseLostState.repository.complete(input)
      if (responseLostCalls === 1) throw new Error('committed response lost marker')
      return result
    }
  })
  const responseLost = createEnabledService({ repository: responseLostRepository })
  const recoveredSettlement = await responseLost.service.run()
  assert.equal(recoveredSettlement.status, 'completed')
  assert.equal(responseLostCalls, 2)
  assert.equal(responseLostState.repository.list().length, 1)
  responseLost.database.close()
  responseLostState.database.close()

  const ambiguousState = createRepository()
  let ambiguousCalls = 0
  const ambiguousRepository = wrapRepository(ambiguousState.repository, {
    complete(input) {
      ambiguousCalls += 1
      if (ambiguousCalls === 1) return { status: 'ambiguous' }
      return ambiguousState.repository.complete(input)
    }
  })
  const ambiguous = createEnabledService({ repository: ambiguousRepository })
  assert.equal((await ambiguous.service.run()).status, 'completed')
  assert.equal(ambiguousCalls, 2)
  ambiguous.database.close()
  ambiguousState.database.close()

  const persistentState = createRepository()
  let persistentCalls = 0
  const persistentRepository = wrapRepository(persistentState.repository, {
    complete() {
      persistentCalls += 1
      throw new Error('persistent settlement marker')
    }
  })
  const persistent = createEnabledService({ repository: persistentRepository })
  assert.deepEqual(await persistent.service.run(), {
    status: 'internal-error',
    safeErrorClass: 'API'
  })
  assert.equal(persistentCalls, 2)
  const pendingRow = persistentState.database.prepare(`
    SELECT completed_at FROM ifind_diagnostic_runs
    WHERE diagnostic_id = ?
  `).get('diag_000000000000000000000001')
  assert.equal(pendingRow.completed_at, null)
  assert.equal(
    persistentState.repository.status(Date.parse('2026-08-26T02:00:00.000Z')).inFlight,
    true
  )
  persistent.database.close()
  persistentState.database.close()

  let hostileReads = 0
  const hiddenExtraDto = {
    status: 'busy',
    retryAt: 1,
    localDayKey: '2026-08-26',
    localAttemptCount: 1
  }
  Object.defineProperty(hiddenExtraDto, 'rawResponse', { value: true })
  const hostileDtos = [
    new Proxy({}, { get() { hostileReads += 1; throw new Error('proxy marker') } }),
    Object.defineProperty({}, 'status', {
      enumerable: true,
      get() { hostileReads += 1; throw new Error('getter marker') }
    }),
    hiddenExtraDto,
    { status: 'busy', retryAt: 'tomorrow', localDayKey: '2026-08-26', localAttemptCount: 1 },
    { status: 'reserved', reservation: null, localDayKey: '2026-08-26', localAttemptCount: 1 }
  ]
  for (const dto of hostileDtos) {
    const state = createRepository()
    let clientCalls = 0
    const repository = wrapRepository(state.repository, { reserve: () => dto })
    const hostile = createEnabledService({
      repository,
      client: { diagnose: async () => { clientCalls += 1 }, clear() {} }
    })
    assert.deepEqual(await hostile.service.run(), {
      status: 'internal-error',
      safeErrorClass: 'API'
    })
    assert.equal(clientCalls, 0)
    hostile.database.close()
    state.database.close()
  }
  assert.equal(hostileReads, 0)

  const hostileStatusState = createRepository()
  const symbolStatus = {
    localDayKey: '2026-08-26',
    localAttemptCount: 0,
    cooldownUntil: null,
    inFlight: false,
    inFlightExpiresAt: null
  }
  symbolStatus[Symbol('raw')] = true
  const hostileStatus = createEnabledService({
    repository: wrapRepository(hostileStatusState.repository, {
      status: () => symbolStatus
    })
  })
  assert.throws(
    () => hostileStatus.service.status(),
    (/**  {any} */ error) => error instanceof IfindDiagnosticServiceError &&
      !`${error.message}:${error.code}`.includes('raw')
  )
  hostileStatus.database.close()
  hostileStatusState.database.close()

  const clearState = createEnabledService()
  let clearCalls = 0
  let finishClient
  clearState.client.clear = () => { clearCalls += 1 }
  clearState.client.diagnose = () => new Promise((resolve) => { finishClient = resolve })
  const pending = clearState.service.run()
  await Promise.resolve()
  clearState.service.clear()
  clearState.service.clear()
  assert.equal(clearCalls, 1)
  ;(/** @type {(value: any) => void} */ (finishClient))(successResult())
  const clearedOutcome = await pending
  assert.equal(clearedOutcome.status, 'failed')
  assert.equal(clearedOutcome.diagnostic.safeErrorClass, 'CONFIG')
  assert.equal(clearState.service.status().mode, 'disabled')
  assert.deepEqual(await clearState.service.run(), {
    status: 'disabled',
    safeErrorClass: 'CONFIG'
  })
  clearState.database.close()

  const invalidFactories = [
    null,
    {},
    {
      mode: 'admin-diagnostic',
      tokenVersionId: 'current',
      repository: {},
      client: {},
      secretProvider: {},
      clock: () => new Date(),
      idSource: () => 'id'
    },
    {
      mode: 'disabled',
      tokenVersionId: null,
      repository: null,
      client: null,
      secretProvider: null,
      clock: () => new Date(),
      idSource: () => 'id',
      rawResponse: true
    }
  ]
  for (const input of invalidFactories) {
    assert.throws(() => createIfindDiagnosticService(input), IfindDiagnosticServiceError)
  }
}

module.exports = { run }

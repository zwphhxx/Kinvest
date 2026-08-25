const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')

const VERSION_ID = 'v20260826-001'
const ROUTE = '/api/v1/get_trade_dates'
const SCOPE = 'market-trade-dates:212001:D:-10'

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
  const error = new Error('raw provider marker must not escape')
  error.class = errorClass
  error.code = 'RAW_PROVIDER_CODE'
  error.headers = { authorization: 'secret' }
  error.RequestId = 'raw-request-id'
  Object.assign(error, overrides)
  return error
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
  assert.equal(Buffer.isBuffer(receivedToken), true)
  assert.equal(receivedToken.every((byte) => byte === 0), true)
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
      error: clientFailure('PERMISSION', { requestCount: 2, dataVol: 7 }),
      expected: { authStatus: 'success', probeStatus: 'failed', safeErrorClass: 'PERMISSION', requestCount: 2, dataVol: 7 }
    },
    {
      error: clientFailure('NETWORK', { requestCount: 3 }),
      expected: { authStatus: 'unknown', probeStatus: 'failed', safeErrorClass: 'NETWORK', requestCount: 3 }
    },
    {
      error: clientFailure('NOT_APPROVED', { requestCount: 1 }),
      expected: { authStatus: 'unknown', probeStatus: 'failed', safeErrorClass: 'API', requestCount: 1 }
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
    state.database.close()
  }

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
  assert.equal(completionCalls, 1)
  completionFailure.database.close()

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
  finishClient(successResult())
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

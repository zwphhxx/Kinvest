const crypto = require('node:crypto')
const { types } = require('node:util')

const MODE_ADMIN = 'admin-diagnostic'
const MODE_DISABLED = 'disabled'
const ROUTE = '/api/v1/get_trade_dates'
const SCOPE = 'market-trade-dates:212001:D:-10'
const VERSION_ID_PATTERN = /^v[0-9]{8}-[0-9]{3}$/
const DIAGNOSTIC_ID_PATTERN = /^diag_[a-f0-9]{24,64}$/
const SAFE_ERROR_CLASSES = new Set([
  'AUTH',
  'PERMISSION',
  'QUOTA',
  'NETWORK',
  'API',
  'CONFIG',
  'BUSY',
  'RATE_LIMITED'
])

class IfindDiagnosticServiceError extends Error {
  constructor() {
    super('The iFinD diagnostic service configuration is invalid')
    this.name = 'IfindDiagnosticServiceError'
    this.code = 'IFIND_DIAGNOSTIC_SERVICE_INVALID'
  }
}

function failConfig() {
  throw new IfindDiagnosticServiceError()
}

function snapshotExactDataObject(value, expectedKeys) {
  try {
    if (types.isProxy(value) || value === null || typeof value !== 'object' ||
        Array.isArray(value)) return null
    const prototype = Reflect.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length !== expectedKeys.length || keys.some((key) =>
      typeof key !== 'string' || !expectedKeys.includes(key))) return null
    const snapshot = Object.create(null)
    for (const key of expectedKeys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        return null
      }
      snapshot[key] = descriptor.value
    }
    return snapshot
  } catch {
    return null
  }
}

function readTimestamp(clock) {
  try {
    const value = clock()
    const timestamp = value instanceof Date
      ? Date.prototype.getTime.call(value)
      : value
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 ||
        timestamp > 8_640_000_000_000_000) failConfig()
    return timestamp
  } catch (error) {
    if (error instanceof IfindDiagnosticServiceError) throw error
    failConfig()
  }
}

function readErrorFields(error) {
  const fallback = {
    errorClass: 'API',
    requestCount: 1,
    dataVol: null,
    stage: null
  }
  try {
    if (types.isProxy(error) || error === null ||
        (typeof error !== 'object' && typeof error !== 'function')) return fallback
    const readData = (key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(error, key)
      return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
    }
    const candidateClass = readData('class')
    const candidateCount = readData('requestCount')
    const candidateDataVol = readData('dataVol')
    const candidateStage = readData('stage')
    return {
      errorClass: SAFE_ERROR_CLASSES.has(candidateClass) ? candidateClass : 'API',
      requestCount: Number.isSafeInteger(candidateCount) && candidateCount >= 0
        ? candidateCount
        : 1,
      dataVol: Number.isSafeInteger(candidateDataVol) && candidateDataVol >= 0
        ? candidateDataVol
        : null,
      stage: candidateStage === 'auth' || candidateStage === 'probe'
        ? candidateStage
        : null
    }
  } catch {
    return fallback
  }
}

function validateClientResult(value) {
  const result = snapshotExactDataObject(value, [
    'route',
    'scope',
    'retrievedAt',
    'timezone',
    'elapsedMs',
    'requestCount',
    'dataVol',
    'officialQuotaStatus',
    'completeness'
  ])
  const dataVolValid = result && (result.dataVol === 'unavailable' ||
    (Number.isSafeInteger(result.dataVol) && result.dataVol >= 0))
  if (!result || result.route !== ROUTE || result.scope !== SCOPE ||
      result.timezone !== 'Asia/Shanghai' ||
      result.officialQuotaStatus !== 'unavailable' ||
      typeof result.retrievedAt !== 'string' ||
      !Number.isFinite(Date.parse(result.retrievedAt)) ||
      !Number.isSafeInteger(result.elapsedMs) || result.elapsedMs < 0 ||
      !Number.isSafeInteger(result.requestCount) || result.requestCount < 1 ||
      !dataVolValid ||
      (result.completeness !== 'complete' && result.completeness !== 'partial') ||
      (result.dataVol === 'unavailable' && result.completeness !== 'partial') ||
      (result.dataVol !== 'unavailable' && result.completeness !== 'complete')) {
    const error = new Error('invalid client result')
    error.class = 'API'
    error.requestCount = 1
    throw error
  }
  return result
}

function mapFailureStatuses(errorClass, stage) {
  if (errorClass === 'AUTH' || errorClass === 'CONFIG' || stage === 'auth') {
    return { authStatus: 'failed', probeStatus: 'not_run' }
  }
  if (errorClass === 'PERMISSION' || errorClass === 'QUOTA' || stage === 'probe') {
    return { authStatus: 'success', probeStatus: 'failed' }
  }
  return { authStatus: 'unknown', probeStatus: 'failed' }
}

function publicDiagnostic(run) {
  return {
    diagnosticId: run.diagnosticId,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    authStatus: run.authStatus,
    probeStatus: run.probeStatus,
    safeErrorClass: run.safeErrorClass,
    route: run.route,
    scope: SCOPE,
    requestCount: run.requestCount,
    dataVol: run.dataVol,
    elapsedMs: run.elapsedMs,
    completeness: run.completeness,
    tokenVersionId: run.tokenVersionId,
    officialQuotaStatus: 'unavailable'
  }
}

function disabledStatus() {
  return {
    mode: MODE_DISABLED,
    configured: false,
    tokenVersionId: null,
    officialQuotaStatus: 'unavailable',
    cooldownUntil: null,
    localAttemptCount: 0,
    inFlight: false,
    latest: null
  }
}

function createIfindDiagnosticService(options) {
  const config = snapshotExactDataObject(options, [
    'mode',
    'tokenVersionId',
    'repository',
    'client',
    'secretProvider',
    'clock',
    'idSource'
  ])
  if (!config || (config.mode !== MODE_ADMIN && config.mode !== MODE_DISABLED) ||
      typeof config.clock !== 'function' || typeof config.idSource !== 'function') {
    failConfig()
  }

  if (config.mode === MODE_DISABLED) {
    if (config.tokenVersionId !== null || config.repository !== null ||
        config.secretProvider !== null) failConfig()
  } else {
    if (typeof config.tokenVersionId !== 'string' ||
        !VERSION_ID_PATTERN.test(config.tokenVersionId) ||
        config.repository === null || typeof config.repository !== 'object' ||
        typeof config.repository.reserve !== 'function' ||
        typeof config.repository.complete !== 'function' ||
        typeof config.repository.fail !== 'function' ||
        typeof config.repository.latest !== 'function' ||
        typeof config.repository.status !== 'function' ||
        config.client === null || typeof config.client !== 'object' ||
        typeof config.client.diagnose !== 'function' ||
        typeof config.client.clear !== 'function' ||
        config.secretProvider === null || typeof config.secretProvider !== 'object' ||
        typeof config.secretProvider.readRefreshToken !== 'function') failConfig()
  }

  let invalidated = false
  let clientCleared = false
  let generation = 0
  const activeTokens = new Set()

  function status() {
    if (config.mode === MODE_DISABLED || invalidated) return disabledStatus()
    try {
      const now = readTimestamp(config.clock)
      const control = config.repository.status(now)
      const latest = config.repository.latest()
      return {
        mode: MODE_ADMIN,
        configured: true,
        tokenVersionId: config.tokenVersionId,
        officialQuotaStatus: 'unavailable',
        cooldownUntil: control.cooldownUntil,
        localAttemptCount: control.localAttemptCount,
        inFlight: control.inFlight,
        latest: latest === null ? null : publicDiagnostic(latest)
      }
    } catch {
      throw new IfindDiagnosticServiceError()
    }
  }

  function reserveOutcome(result) {
    if (result.status === 'busy') {
      return {
        status: 'busy',
        safeErrorClass: 'BUSY',
        retryAt: result.retryAt,
        localAttemptCount: result.localAttemptCount
      }
    }
    if (result.status === 'cooldown' || result.status === 'daily-limit') {
      return {
        status: result.status,
        safeErrorClass: 'RATE_LIMITED',
        retryAt: result.retryAt,
        localAttemptCount: result.localAttemptCount
      }
    }
    return null
  }

  async function run() {
    if (config.mode === MODE_DISABLED || invalidated) {
      return { status: 'disabled', safeErrorClass: 'CONFIG' }
    }

    let startedAt
    let diagnosticId
    let reservationResult
    try {
      startedAt = readTimestamp(config.clock)
      diagnosticId = config.idSource()
      if (typeof diagnosticId !== 'string' || !DIAGNOSTIC_ID_PATTERN.test(diagnosticId)) {
        failConfig()
      }
      reservationResult = config.repository.reserve({
        diagnosticId,
        startedAt,
        tokenVersionId: config.tokenVersionId
      })
    } catch {
      return { status: 'internal-error', safeErrorClass: 'API' }
    }

    const blocked = reserveOutcome(reservationResult)
    if (blocked) return blocked
    if (!reservationResult || reservationResult.status !== 'reserved') {
      return { status: 'internal-error', safeErrorClass: 'API' }
    }

    const operationGeneration = generation
    const reservation = reservationResult.reservation
    let refreshToken = null
    let terminal
    let outcomeStatus = 'failed'
    try {
      refreshToken = config.secretProvider.readRefreshToken()
      if (!Buffer.isBuffer(refreshToken) || refreshToken.length < 1 || refreshToken.length > 4096) {
        const error = new Error('invalid secret provider')
        error.class = 'CONFIG'
        error.requestCount = 0
        throw error
      }
      activeTokens.add(refreshToken)
      const clientResult = validateClientResult(await config.client.diagnose({ refreshToken }))
      if (invalidated || operationGeneration !== generation) {
        const error = new Error('service cleared')
        error.class = 'CONFIG'
        error.requestCount = clientResult.requestCount
        throw error
      }
      const completedAt = readTimestamp(config.clock)
      terminal = {
        completedAt,
        authStatus: 'success',
        probeStatus: 'success',
        safeErrorClass: null,
        route: ROUTE,
        requestCount: clientResult.requestCount,
        dataVol: clientResult.dataVol === 'unavailable' ? null : clientResult.dataVol,
        elapsedMs: clientResult.elapsedMs,
        completeness: clientResult.completeness
      }
      outcomeStatus = 'completed'
    } catch (error) {
      const fields = readErrorFields(error)
      const statuses = mapFailureStatuses(fields.errorClass, fields.stage)
      let completedAt = startedAt
      try { completedAt = readTimestamp(config.clock) } catch {}
      terminal = {
        completedAt: Math.max(startedAt, completedAt),
        authStatus: statuses.authStatus,
        probeStatus: statuses.probeStatus,
        safeErrorClass: fields.errorClass,
        route: ROUTE,
        requestCount: fields.requestCount,
        dataVol: fields.dataVol,
        elapsedMs: Math.max(0, completedAt - startedAt),
        completeness: 'unavailable'
      }
    } finally {
      if (Buffer.isBuffer(refreshToken)) refreshToken.fill(0)
      activeTokens.delete(refreshToken)
    }

    let settlement
    try {
      settlement = outcomeStatus === 'completed'
        ? config.repository.complete({ reservation, result: terminal })
        : config.repository.fail({ reservation, result: terminal })
    } catch {
      return { status: 'internal-error', safeErrorClass: 'API' }
    }
    if (!settlement || settlement.status !== 'completed') {
      return { status: 'internal-error', safeErrorClass: 'API' }
    }

    const persisted = {
      diagnosticId: reservation.diagnosticId,
      startedAt: reservation.startedAt,
      ...terminal,
      tokenVersionId: reservation.tokenVersionId
    }
    return {
      status: outcomeStatus,
      safeErrorClass: terminal.safeErrorClass,
      diagnostic: publicDiagnostic(persisted),
      cooldownUntil: settlement.cooldownUntil,
      localAttemptCount: reservationResult.localAttemptCount
    }
  }

  function clear() {
    if (config.mode === MODE_DISABLED || clientCleared) {
      invalidated = true
      return
    }
    invalidated = true
    generation += 1
    for (const token of activeTokens) token.fill(0)
    activeTokens.clear()
    clientCleared = true
    try {
      config.client.clear()
    } catch {
      throw new IfindDiagnosticServiceError()
    }
  }

  return Object.freeze({ status, run, clear })
}

function createDefaultDiagnosticId() {
  return `diag_${crypto.randomBytes(16).toString('hex')}`
}

module.exports = {
  IfindDiagnosticServiceError,
  createDefaultDiagnosticId,
  createIfindDiagnosticService
}

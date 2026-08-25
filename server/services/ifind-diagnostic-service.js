const crypto = require('node:crypto')
const { types } = require('node:util')

const MODE_ADMIN = 'admin-diagnostic'
const MODE_DISABLED = 'disabled'
const ROUTE = '/api/v1/get_trade_dates'
const SCOPE = 'market-trade-dates:212001:D:-10'
const VERSION_ID_PATTERN = /^v[0-9]{8}-[0-9]{3}$/
const DIAGNOSTIC_ID_PATTERN = /^diag_[a-f0-9]{24,64}$/
const DAY_KEY_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const MAX_DIAGNOSTIC_REQUEST_COUNT = 4
const SAFE_ERROR_CLASSES = new Set([
  'AUTH', 'PERMISSION', 'QUOTA', 'NETWORK', 'API', 'CONFIG', 'BUSY',
  'RATE_LIMITED'
])
const AUTH_STATUSES = new Set(['success', 'failed', 'unknown'])
const PROBE_STATUSES = new Set(['success', 'failed', 'not_run'])
const COMPLETENESS_VALUES = new Set(['complete', 'partial', 'unavailable'])

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

function isTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
}

function isCount(value, minimum = 0, maximum = 20) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function isDayKey(value) {
  if (typeof value !== 'string' || !DAY_KEY_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function readTimestamp(clock) {
  try {
    const value = clock()
    const timestamp = value instanceof Date
      ? Date.prototype.getTime.call(value)
      : value
    if (!isTimestamp(timestamp)) failConfig()
    return timestamp
  } catch (error) {
    if (error instanceof IfindDiagnosticServiceError) throw error
    failConfig()
  }
}

function readErrorFields(error, fallbackRequestCount = 1) {
  const fallback = {
    errorClass: 'API',
    requestCount: fallbackRequestCount === 0 ? 0 : 1,
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
      requestCount: isCount(candidateCount, 0, MAX_DIAGNOSTIC_REQUEST_COUNT)
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

function safeClientResultRequestCount(value) {
  try {
    if (types.isProxy(value) || value === null || typeof value !== 'object' ||
        Array.isArray(value)) return 1
    const prototype = Reflect.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return 1
    const descriptor = Reflect.getOwnPropertyDescriptor(value, 'requestCount')
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return 1
    }
    return isCount(descriptor.value, 1, MAX_DIAGNOSTIC_REQUEST_COUNT)
      ? descriptor.value
      : 1
  } catch {
    return 1
  }
}

function invalidClientResult(requestCount) {
  const error = new Error('invalid client result')
  error.class = 'API'
  error.requestCount = requestCount
  return error
}

function validateClientResult(value) {
  const requestCount = safeClientResultRequestCount(value)
  const result = snapshotExactDataObject(value, [
    'route', 'scope', 'retrievedAt', 'timezone', 'elapsedMs', 'requestCount',
    'dataVol', 'officialQuotaStatus', 'completeness'
  ])
  const dataVolValid = result && (result.dataVol === 'unavailable' ||
    (Number.isSafeInteger(result.dataVol) && result.dataVol >= 0))
  if (!result || result.route !== ROUTE || result.scope !== SCOPE ||
      result.timezone !== 'Asia/Shanghai' ||
      result.officialQuotaStatus !== 'unavailable' ||
      typeof result.retrievedAt !== 'string' ||
      !Number.isFinite(Date.parse(result.retrievedAt)) ||
      !Number.isSafeInteger(result.elapsedMs) || result.elapsedMs < 0 ||
      !isCount(result.requestCount, 1, MAX_DIAGNOSTIC_REQUEST_COUNT) ||
      !dataVolValid ||
      (result.completeness !== 'complete' && result.completeness !== 'partial') ||
      (result.dataVol === 'unavailable' && result.completeness !== 'partial') ||
      (result.dataVol !== 'unavailable' && result.completeness !== 'complete')) {
    throw invalidClientResult(requestCount)
  }
  return result
}

function decodeReservation(value) {
  const reservation = snapshotExactDataObject(value, [
    'diagnosticId', 'startedAt', 'tokenVersionId', 'inFlightExpiresAt'
  ])
  if (!reservation || typeof reservation.diagnosticId !== 'string' ||
      !DIAGNOSTIC_ID_PATTERN.test(reservation.diagnosticId) ||
      !isTimestamp(reservation.startedAt) ||
      typeof reservation.tokenVersionId !== 'string' ||
      !VERSION_ID_PATTERN.test(reservation.tokenVersionId) ||
      !isTimestamp(reservation.inFlightExpiresAt) ||
      reservation.inFlightExpiresAt <= reservation.startedAt) failConfig()
  return {
    diagnosticId: reservation.diagnosticId,
    startedAt: reservation.startedAt,
    tokenVersionId: reservation.tokenVersionId,
    inFlightExpiresAt: reservation.inFlightExpiresAt
  }
}

function decodeReserveResult(value) {
  let dto = snapshotExactDataObject(value, [
    'status', 'reservation', 'localDayKey', 'localAttemptCount'
  ])
  if (dto && dto.status === 'reserved' && isDayKey(dto.localDayKey) &&
      isCount(dto.localAttemptCount, 1, 20)) {
    return {
      status: 'reserved',
      reservation: decodeReservation(dto.reservation),
      localDayKey: dto.localDayKey,
      localAttemptCount: dto.localAttemptCount
    }
  }

  dto = snapshotExactDataObject(value, [
    'status', 'retryAt', 'localDayKey', 'localAttemptCount'
  ])
  if (dto && ['busy', 'cooldown', 'daily-limit'].includes(dto.status) &&
      isTimestamp(dto.retryAt) && isDayKey(dto.localDayKey) &&
      isCount(dto.localAttemptCount, 0, 20)) {
    return {
      status: dto.status,
      retryAt: dto.retryAt,
      localDayKey: dto.localDayKey,
      localAttemptCount: dto.localAttemptCount
    }
  }

  dto = snapshotExactDataObject(value, [
    'status', 'localDayKey', 'localAttemptCount'
  ])
  if (dto && (dto.status === 'duplicate' || dto.status === 'clock-rollback') &&
      isDayKey(dto.localDayKey) && isCount(dto.localAttemptCount, 0, 20)) {
    return {
      status: dto.status,
      localDayKey: dto.localDayKey,
      localAttemptCount: dto.localAttemptCount
    }
  }
  failConfig()
}

function decodeSettlement(value) {
  let dto = snapshotExactDataObject(value, ['status', 'cooldownUntil'])
  if (dto && dto.status === 'completed' && isTimestamp(dto.cooldownUntil)) {
    return { status: 'completed', cooldownUntil: dto.cooldownUntil }
  }
  dto = snapshotExactDataObject(value, ['status'])
  if (dto && (dto.status === 'not-found' || dto.status === 'conflict')) {
    return { status: dto.status }
  }
  failConfig()
}

function decodeRepositoryStatus(value) {
  const dto = snapshotExactDataObject(value, [
    'localDayKey', 'localAttemptCount', 'cooldownUntil', 'inFlight',
    'inFlightExpiresAt'
  ])
  if (!dto || !isDayKey(dto.localDayKey) ||
      !isCount(dto.localAttemptCount, 0, 20) ||
      (dto.cooldownUntil !== null && !isTimestamp(dto.cooldownUntil)) ||
      typeof dto.inFlight !== 'boolean' ||
      (dto.inFlight && !isTimestamp(dto.inFlightExpiresAt)) ||
      (!dto.inFlight && dto.inFlightExpiresAt !== null)) failConfig()
  return {
    localDayKey: dto.localDayKey,
    localAttemptCount: dto.localAttemptCount,
    cooldownUntil: dto.cooldownUntil,
    inFlight: dto.inFlight,
    inFlightExpiresAt: dto.inFlightExpiresAt
  }
}

function decodeRun(value) {
  if (value === null) return null
  const run = snapshotExactDataObject(value, [
    'diagnosticId', 'startedAt', 'completedAt', 'authStatus', 'probeStatus',
    'safeErrorClass', 'route', 'requestCount', 'dataVol', 'elapsedMs',
    'completeness', 'tokenVersionId'
  ])
  if (!run || typeof run.diagnosticId !== 'string' ||
      !DIAGNOSTIC_ID_PATTERN.test(run.diagnosticId) ||
      !isTimestamp(run.startedAt) || !isTimestamp(run.completedAt) ||
      run.completedAt < run.startedAt || !AUTH_STATUSES.has(run.authStatus) ||
      !PROBE_STATUSES.has(run.probeStatus) ||
      (run.safeErrorClass !== null && !SAFE_ERROR_CLASSES.has(run.safeErrorClass)) ||
      run.route !== ROUTE || !isCount(run.requestCount, 0, 4) ||
      (run.dataVol !== null && (!Number.isSafeInteger(run.dataVol) || run.dataVol < 0)) ||
      !Number.isSafeInteger(run.elapsedMs) || run.elapsedMs < 0 ||
      !COMPLETENESS_VALUES.has(run.completeness) ||
      typeof run.tokenVersionId !== 'string' ||
      !VERSION_ID_PATTERN.test(run.tokenVersionId)) failConfig()
  if (run.authStatus === 'success' && run.probeStatus === 'success') {
    if (run.safeErrorClass !== null || run.completeness === 'unavailable') failConfig()
  } else if (run.safeErrorClass === null) {
    failConfig()
  }
  return {
    diagnosticId: run.diagnosticId,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    authStatus: run.authStatus,
    probeStatus: run.probeStatus,
    safeErrorClass: run.safeErrorClass,
    route: run.route,
    requestCount: run.requestCount,
    dataVol: run.dataVol,
    elapsedMs: run.elapsedMs,
    completeness: run.completeness,
    tokenVersionId: run.tokenVersionId
  }
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
    'mode', 'tokenVersionId', 'repository', 'client', 'secretProvider', 'clock',
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
      const control = decodeRepositoryStatus(config.repository.status(now))
      const latest = decodeRun(config.repository.latest())
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
    if (result.status === 'duplicate') {
      return {
        status: 'rejected',
        safeErrorClass: 'CONFIG',
        localAttemptCount: result.localAttemptCount
      }
    }
    if (result.status === 'clock-rollback') {
      return {
        status: 'clock-rollback',
        safeErrorClass: 'CONFIG',
        localAttemptCount: result.localAttemptCount
      }
    }
    return null
  }

  function settleWithRetry(method, input) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = decodeSettlement(config.repository[method](input))
        if (result.status === 'completed') return result
      } catch {}
    }
    return null
  }

  async function run() {
    if (config.mode === MODE_DISABLED || invalidated) {
      return { status: 'disabled', safeErrorClass: 'CONFIG' }
    }

    let startedAt
    let reservationResult
    try {
      startedAt = readTimestamp(config.clock)
      const diagnosticId = config.idSource()
      if (typeof diagnosticId !== 'string' || !DIAGNOSTIC_ID_PATTERN.test(diagnosticId)) {
        failConfig()
      }
      reservationResult = decodeReserveResult(config.repository.reserve({
        diagnosticId,
        startedAt,
        tokenVersionId: config.tokenVersionId
      }))
    } catch {
      return { status: 'internal-error', safeErrorClass: 'API' }
    }

    const blocked = reserveOutcome(reservationResult)
    if (blocked) return blocked
    if (reservationResult.status !== 'reserved') {
      return { status: 'internal-error', safeErrorClass: 'API' }
    }

    const operationGeneration = generation
    const reservation = reservationResult.reservation
    let refreshToken = null
    let terminal
    let outcomeStatus = 'failed'
    let clientInvoked = false
    try {
      refreshToken = config.secretProvider.readRefreshToken()
      if (!Buffer.isBuffer(refreshToken) || refreshToken.length < 1 || refreshToken.length > 4096) {
        const error = new Error('invalid secret provider')
        error.class = 'CONFIG'
        error.requestCount = 0
        throw error
      }
      activeTokens.add(refreshToken)
      clientInvoked = true
      const clientResult = validateClientResult(
        await config.client.diagnose({ refreshToken })
      )
      if (invalidated || operationGeneration !== generation) {
        const error = new Error('service cleared')
        error.class = 'CONFIG'
        error.requestCount = clientResult.requestCount
        throw error
      }
      terminal = {
        completedAt: readTimestamp(config.clock),
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
      const observedFields = readErrorFields(error, clientInvoked ? 1 : 0)
      const fields = clientInvoked
        ? observedFields
        : { ...observedFields, requestCount: 0 }
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

    const settlement = settleWithRetry(
      outcomeStatus === 'completed' ? 'complete' : 'fail',
      { reservation, result: terminal }
    )
    if (!settlement) return { status: 'internal-error', safeErrorClass: 'API' }

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

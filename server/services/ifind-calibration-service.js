'use strict'

const { randomBytes } = require('node:crypto')
const { types } = require('node:util')
const {
  copyCalibrationResult,
  createInitialCalibrationResult
} = require('../domain/ifind-calibration')
const {
  IFIND_MARKET_CASE_COOLDOWN_MS,
  IFIND_MARKET_DIAGNOSTIC_LEASE_MS,
  IFIND_MARKET_MAX_CREATED_AT
} = require('../db/ifind-market-diagnostic-repository')

const CASE_ID = 'HK_ALIBABA_9988'
const FAILED = 'IFIND_CALIBRATION_FAILED'
const UNAVAILABLE = 'IFIND_CALIBRATION_UNAVAILABLE'
const OBSERVED = 'IFIND_CALIBRATION_OBSERVED_UNVERIFIED'
const MIN_TIME = Date.parse('2000-01-01T00:00:00.000Z')
const CLIENT_OWNERS = new WeakMap()

class IfindCalibrationServiceError extends Error {
  constructor(code = UNAVAILABLE) {
    super('The iFinD calibration operation is unavailable')
    this.name = 'IfindCalibrationServiceError'
    this.code = code
  }
}

function fail() {
  throw new IfindCalibrationServiceError(FAILED)
}

function record(value, allowed, required = allowed) {
  if (types.isProxy(value) || value === null || typeof value !== 'object' || Array.isArray(value)) fail()
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail()
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) ||
      required.some((key) => !keys.includes(key))) fail()
  const snapshot = Object.create(null)
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
    snapshot[key] = descriptor.value
  }
  return snapshot
}

function ownValue(value, key) {
  if (types.isProxy(value) || value === null || typeof value !== 'object') return undefined
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}

function methodReference(value, key) {
  let object = value
  for (let depth = 0; object && depth < 8; depth += 1) {
    if (types.isProxy(object) || (typeof object !== 'object' && typeof object !== 'function')) fail()
    const descriptor = Reflect.getOwnPropertyDescriptor(object, key)
    if (descriptor) {
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function' ||
          types.isProxy(descriptor.value)) fail()
      return descriptor.value
    }
    object = Reflect.getPrototypeOf(object)
  }
  fail()
}

function exactMatch(pattern, value) {
  if (typeof value !== 'string') return false
  const match = pattern.exec(value)
  return match !== null && match[0] === value
}

function validTime(value) {
  return Number.isSafeInteger(value) && value >= MIN_TIME && value <= IFIND_MARKET_MAX_CREATED_AT
}

function validVolume(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0)
}

function isToken(value) {
  return !types.isProxy(value) && Buffer.isBuffer(value)
}

function wipe(value) {
  try {
    if (isToken(value)) Buffer.prototype.fill.call(value, 0)
  } catch {
    // Cleanup does not expose token contents or replace a stable result.
  }
}

function oneItem(value) {
  if (types.isProxy(value) || !Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) fail()
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 2 || !keys.includes('0') || !keys.includes('length')) fail()
  const length = Reflect.getOwnPropertyDescriptor(value, 'length')
  const item = Reflect.getOwnPropertyDescriptor(value, '0')
  if (!length || !Object.hasOwn(length, 'value') || length.value !== 1 ||
      !item || !item.enumerable || !Object.hasOwn(item, 'value')) fail()
  return item.value
}

function parseObservation(payload) {
  const response = record(payload, ['errorcode', 'tables', 'dataVol'], ['errorcode', 'tables'])
  if (response.errorcode !== 0 || (Object.hasOwn(response, 'dataVol') && !validVolume(response.dataVol))) fail()
  const row = record(oneItem(response.tables), ['thscode', 'table'])
  if (row.thscode !== '9988.HK') fail()
  const table = record(row.table, ['revenue_oas'])
  let value = oneItem(table.revenue_oas)
  if (typeof value === 'string') {
    // Plain decimal syntax only: no whitespace, grouping, units, or inferred scale.
    if (value.length > 64 || !exactMatch(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/, value)) fail()
    value = Number(value)
  }
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) fail()
  return {
    value, availability: value === null ? 'missing' : 'present', returnedCode: '9988.HK',
    currency: null, unit: null, reportPeriod: null, periodType: null, disclosureScope: null
  }
}

function idleResult(status) {
  const result = createInitialCalibrationResult()
  result.status = status
  if (status === 'unavailable') result.errorCode = UNAVAILABLE
  return result
}

function createIfindCalibrationService(options) {
  let config
  let methods
  try {
    config = record(options, [
      'repository', 'client', 'secretProvider', 'tokenVersionId', 'clock', 'idGenerator'
    ], ['repository', 'client', 'secretProvider', 'tokenVersionId'])
    if (!exactMatch(/^v[0-9]{8}-[0-9]{3}$/, config.tokenVersionId)) fail()
    config.clock = config.clock === undefined ? Date.now : config.clock
    config.idGenerator = config.idGenerator === undefined
      ? () => 'market_run_' + randomBytes(16).toString('hex')
      : config.idGenerator
    if (typeof config.clock !== 'function' || typeof config.idGenerator !== 'function' ||
        types.isProxy(config.clock) || types.isProxy(config.idGenerator)) fail()
    methods = {
      reserve: methodReference(config.repository, 'reserve'),
      fail: methodReference(config.repository, 'fail'),
      quotaStatus: methodReference(config.repository, 'quotaStatus'),
      authenticate: methodReference(config.client, 'authenticate'),
      calibrateFinancial: methodReference(config.client, 'calibrateFinancial'),
      clearClient: methodReference(config.client, 'clear'),
      readSecret: methodReference(config.secretProvider, 'readRefreshToken')
    }
  } catch {
    throw new IfindCalibrationServiceError()
  }

  let current = createInitialCalibrationResult()
  let generation = 0
  let active = null
  let lastStartedAt = null

  function timestamp() {
    const now = config.clock()
    if (!validTime(now)) fail()
    return now
  }

  function describe() {
    if (active || CLIENT_OWNERS.has(config.client)) return idleResult('busy')
    if (current.status !== 'ready') return copyCalibrationResult(current)
    try {
      const now = timestamp()
      if (lastStartedAt !== null && now < lastStartedAt) fail()
      const quota = methods.quotaStatus.call(config.repository, { caseId: CASE_ID, now })
      const inFlight = ownValue(quota, 'inFlight')
      const caseRemaining = ownValue(quota, 'caseRemaining')
      const globalRemaining = ownValue(quota, 'globalRemaining')
      const cooldownUntil = ownValue(quota, 'cooldownUntil')
      if (typeof inFlight !== 'boolean' || !Number.isSafeInteger(caseRemaining) || caseRemaining < 0 ||
          !Number.isSafeInteger(globalRemaining) || globalRemaining < 0 ||
          (cooldownUntil !== null && !Number.isSafeInteger(cooldownUntil))) fail()
      if (inFlight) return idleResult('busy')
      if (cooldownUntil !== null && now < cooldownUntil) return idleResult('cooldown')
      if (caseRemaining === 0 || globalRemaining === 0) return idleResult('daily-limit')
      return copyCalibrationResult(current)
    } catch {
      return idleResult('unavailable')
    }
  }

  async function run(...args) {
    if (args.length !== 0) throw new IfindCalibrationServiceError(FAILED)
    if (active || CLIENT_OWNERS.has(config.client)) return idleResult('busy')

    let reservation
    try {
      const createdAt = timestamp()
      if (lastStartedAt !== null && createdAt < lastStartedAt) fail()
      const runId = config.idGenerator()
      if (!exactMatch(/^market_run_[a-f0-9]{24,64}$/, runId)) fail()
      const request = { runId, caseId: CASE_ID, createdAt, tokenVersionId: config.tokenVersionId }
      // This shared R1 transaction is authoritative, never the describe() preflight.
      // The legacy trade-calendar probe retains its independent existing quota.
      const reserved = methods.reserve.call(config.repository, request)
      const status = ownValue(reserved, 'status')
      if (status === 'busy' || status === 'cooldown') return idleResult(status)
      if (status === 'case-daily-limit' || status === 'global-daily-limit') return idleResult('daily-limit')
      if (status !== 'reserved') return idleResult('unavailable')
      const received = record(ownValue(reserved, 'reservation'), [
        'runId', 'caseId', 'createdAt', 'tokenVersionId', 'leaseExpiresAt'
      ])
      if (received.runId !== runId || received.caseId !== CASE_ID || received.createdAt !== createdAt ||
          received.tokenVersionId !== config.tokenVersionId ||
          received.leaseExpiresAt !== createdAt + IFIND_MARKET_DIAGNOSTIC_LEASE_MS) fail()
      reservation = { ...request, leaseExpiresAt: received.leaseExpiresAt }
      lastStartedAt = createdAt
    } catch {
      return idleResult('unavailable')
    }

    const owner = { generation }
    active = owner
    CLIENT_OWNERS.set(config.client, owner)
    let refreshToken = null
    let accessToken = null
    let requestCount = 0
    let businessRequestCount = 0
    let dataVol = null
    let lastTime = reservation.createdAt
    let observation
    let status = 'failed'
    let errorCode = FAILED
    let safeErrorClass = 'NETWORK'
    let result

    function checkLease() {
      const now = timestamp()
      if (now < lastTime) fail()
      lastTime = now
      if (now >= reservation.leaseExpiresAt || generation !== owner.generation) fail()
    }

    try {
      try {
        checkLease()
        status = 'unavailable'
        errorCode = UNAVAILABLE
        safeErrorClass = 'AUTH'
        refreshToken = methods.readSecret.call(config.secretProvider)
        if (!isToken(refreshToken) || refreshToken.length < 1 || refreshToken.length > 4096) fail()

        status = 'failed'
        errorCode = FAILED
        checkLease()
        // Count attempted calls before awaiting: thrown calls also consume permits.
        requestCount = 1
        const authOutput = await methods.authenticate.call(config.client, refreshToken)
        // Capture an own buffer before validating the envelope, so malformed counts
        // cannot prevent zeroization of a token that has already been returned.
        accessToken = ownValue(authOutput, 'accessToken')
        safeErrorClass = 'RESPONSE_SHAPE'
        const authentication = record(authOutput, ['accessToken', 'requestCount'])
        if (authentication.requestCount !== 1 || !isToken(accessToken) ||
            accessToken.length < 1 || accessToken.length > 4096) fail()
        safeErrorClass = 'NETWORK'
        checkLease()

        requestCount = 2
        businessRequestCount = 1
        // The parent adapter supplies the fixed request; no caller arguments pass through.
        const financialOutput = await methods.calibrateFinancial.call(config.client, accessToken)
        safeErrorClass = 'RESPONSE_SHAPE'
        const financial = record(financialOutput, ['payload', 'requestCount', 'dataVol'])
        if (!validVolume(financial.dataVol)) fail()
        dataVol = financial.dataVol
        if (financial.requestCount !== 1) fail()
        safeErrorClass = 'NETWORK'
        checkLease()
        safeErrorClass = 'RESPONSE_SHAPE'
        observation = parseObservation(financial.payload)
        safeErrorClass = 'NETWORK'
        checkLease()
        status = 'observed-unverified'
        errorCode = OBSERVED
        safeErrorClass = 'PERIOD_UNVERIFIED'
      } catch (error) {
        observation = null
        // Only a numeric own data property is admissible from a client failure.
        // In particular, never inspect message/code/stack or execute proxy traps.
        if (businessRequestCount === 1 && dataVol === null) {
          const volume = ownValue(error, 'dataVol')
          if (validVolume(volume)) dataVol = volume
        }
        try {
          const now = timestamp()
          if (now >= lastTime) lastTime = now
        } catch {
          // Retain the last valid monotonic instant if the injected clock fails.
        }
      }

      const completedAt = Math.min(lastTime, reservation.leaseExpiresAt)
      result = {
        ...createInitialCalibrationResult(), status, observation,
        requestCount, businessRequestCount, dataVol,
        attemptedAt: new Date(reservation.createdAt).toISOString(), errorCode
      }
      try {
        // Observation succeeds only at the transport level. Full-case verification
        // intentionally stays failed: no quote snapshot or financial point is written.
        // An expired response is already rejected above; bounding its failure time
        // merely lets the existing lease contract retain attempted-call bookkeeping.
        const settlement = methods.fail.call(config.repository, {
          reservation,
          result: {
            status: 'failed', quoteStatus: 'not_run', financeStatus: 'unavailable',
            requestCount, dataVol, elapsedMs: completedAt - reservation.createdAt,
            safeErrorClass, failureCode: errorCode, vendorErrorCode: null, completedAt
          }
        })
        const settled = record(settlement, ['status', 'cooldownUntil'])
        if (settled.status !== 'completed' || settled.cooldownUntil !== completedAt + IFIND_MARKET_CASE_COOLDOWN_MS) fail()
      } catch {
        // Never publish an observation whose shared quota settlement failed.
        // No retry can overwrite a recovered lease or somebody else's reservation.
        result.status = 'unavailable'
        result.errorCode = UNAVAILABLE
        result.observation = null
      }
    } finally {
      wipe(refreshToken)
      wipe(accessToken)
      // Only an actually reserved calibration may clear this shared client.
      // Busy/cooldown/daily-limit paths return before entering this ownership scope.
      if (CLIENT_OWNERS.get(config.client) === owner) {
        try {
          await methods.clearClient.call(config.client)
        } catch {
          // Client cleanup is best effort and must never leak provider details.
        } finally {
          CLIENT_OWNERS.delete(config.client)
        }
      }
      active = null
    }

    if (generation === owner.generation) {
      current = copyCalibrationResult(result)
    } else if (result.observation !== null) {
      result.status = 'failed'
      result.errorCode = FAILED
      result.observation = null
    }
    return copyCalibrationResult(result)
  }

  function clear() {
    generation += 1
    current = createInitialCalibrationResult()
    // Invalidates a late result without releasing the active reservation or client.
    return copyCalibrationResult(current)
  }

  return Object.freeze({ describe, run, clear })
}

module.exports = { IfindCalibrationServiceError, createIfindCalibrationService }

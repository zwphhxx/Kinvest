'use strict'

const { randomBytes } = require('node:crypto')
const { types } = require('node:util')
const {
  createInitialIfindMarketProbeResult,
  copyIfindMarketProbeResult
} = require('../domain/ifind-market-probe-result')
const {
  IFIND_MARKET_CASE_COOLDOWN_MS,
  IFIND_MARKET_DIAGNOSTIC_LEASE_MS,
  IFIND_MARKET_MAX_CREATED_AT
} = require('../db/ifind-market-diagnostic-repository')

const CASE_ID = 'HK_ALIBABA_9988'
const PROPOSAL_ID = 'HK_ALIBABA_9988_V1'
const FAILED = 'IFIND_MARKET_PROBE_FAILED'
const UNAVAILABLE = 'IFIND_MARKET_PROBE_UNAVAILABLE'
const OBSERVED = 'IFIND_MARKET_PROBE_OBSERVED_UNVERIFIED'
const MIN_TIME = Date.parse('2000-01-01T00:00:00.000Z')
/** @typedef {'identity' | 'quote' | 'financial'} ProbeStage */
/** @typedef {{returnedCode: string, fields: Record<string, Array<null | string | number | boolean>>}} ProbeObservation */
/** @typedef {{identity: ProbeObservation | null, quote: ProbeObservation | null, financial: ProbeObservation | null}} ProbeObservations */
/** @type {ReadonlyArray<ProbeStage>} */
const STAGES = Object.freeze(['identity', 'quote', 'financial'])
const FIELD_KEYS = Object.freeze({
  identity: Object.freeze(['ths_stock_short_name_stock']),
  quote: Object.freeze(['latest', 'preClose', 'open', 'high', 'low', 'amount', 'volume',
    'tradeDate', 'tradeTime']),
  financial: Object.freeze(['revenue_oas'])
})
const CLIENT_OWNERS = new WeakMap()

class IfindMarketProbeServiceError extends Error {
  constructor(code = UNAVAILABLE) {
    super('The iFinD market probe operation is unavailable')
    this.name = 'IfindMarketProbeServiceError'
    this.code = code
  }
}

class LeaseFailure extends Error {}
function fail() { throw new IfindMarketProbeServiceError(FAILED) }

function record(value, allowed, required = allowed) {
  if (types.isProxy(value) || value === null || typeof value !== 'object' || Array.isArray(value)) fail()
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail()
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) ||
      required.some((key) => !keys.includes(key))) fail()
  const result = Object.create(null)
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
    result[key] = descriptor.value
  }
  return result
}

function array(value, maximum = 64, exact = null) {
  if (types.isProxy(value) || !Array.isArray(value) ||
      Reflect.getPrototypeOf(value) !== Array.prototype) fail()
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length')
  const length = lengthDescriptor && lengthDescriptor.value
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum ||
      (exact !== null && length !== exact) || Reflect.ownKeys(value).length !== length + 1) fail()
  const result = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
    result.push(descriptor.value)
  }
  return result
}

function primitiveArray(value) {
  return array(value).map((item) => {
    if (item === null || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item === 'string' && Buffer.byteLength(item, 'utf8') <= 256 &&
        !/[\p{Cc}\p{Cf}]/u.test(item)) return item
    fail()
  })
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

function validVolume(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0)
}

function isToken(value) { return !types.isProxy(value) && Buffer.isBuffer(value) }
function wipe(value) {
  try { if (isToken(value)) Buffer.prototype.fill.call(value, 0) } catch {
    // Cleanup cannot replace safe bookkeeping or expose provider values.
  }
}

function idleResult(status) {
  const result = createInitialIfindMarketProbeResult()
  result.status = status
  return result
}

function unavailableResult(attemptedAt = null, failureStage = 'lease') {
  return copyIfindMarketProbeResult({ ...createInitialIfindMarketProbeResult(),
    status: 'unavailable', attemptedAt, errorCode: UNAVAILABLE, failureStage })
}

function copyProbeEnvelope(value, expectedStage) {
  const envelope = record(value, ['stage', 'payload', 'requestCount', 'dataVol'])
  if (envelope.stage !== expectedStage || envelope.requestCount !== 1 ||
      !validVolume(envelope.dataVol)) fail()
  const payload = record(envelope.payload, ['errorcode', 'tables', 'dataVol'], ['errorcode', 'tables'])
  if (payload.errorcode !== 0 || (Object.hasOwn(payload, 'dataVol') &&
      (!validVolume(payload.dataVol) || payload.dataVol !== envelope.dataVol))) fail()
  const table = record(array(payload.tables, 1, 1)[0], ['thscode', 'table'])
  if (table.thscode !== '9988.HK') fail()
  const fields = record(table.table, FIELD_KEYS[expectedStage])
  return {
    observation: { returnedCode: '9988.HK', fields: Object.fromEntries(
      FIELD_KEYS[expectedStage].map((key) => [key, primitiveArray(fields[key])])) },
    dataVol: envelope.dataVol
  }
}

function createIfindMarketProbeService(options) {
  let config
  let methods
  try {
    config = record(options, ['repository', 'client', 'secretProvider', 'tokenVersionId', 'clock',
      'idGenerator'], ['repository', 'client', 'secretProvider', 'tokenVersionId'])
    if (!exactMatch(/^v[0-9]{8}-[0-9]{3}$/, config.tokenVersionId)) fail()
    config.clock = config.clock === undefined ? Date.now : config.clock
    config.idGenerator = config.idGenerator === undefined
      ? () => 'market_run_' + randomBytes(16).toString('hex') : config.idGenerator
    if (typeof config.clock !== 'function' || types.isProxy(config.clock) ||
        typeof config.idGenerator !== 'function' || types.isProxy(config.idGenerator)) fail()
    methods = {
      reserve: methodReference(config.repository, 'reserve'),
      fail: methodReference(config.repository, 'fail'),
      quotaStatus: methodReference(config.repository, 'quotaStatus'),
      authenticate: methodReference(config.client, 'authenticate'),
      probeFixed: methodReference(config.client, 'probeFixed'),
      clearClient: methodReference(config.client, 'clear'),
      readSecret: methodReference(config.secretProvider, 'readRefreshToken')
    }
  } catch {
    throw new IfindMarketProbeServiceError()
  }

  let current = createInitialIfindMarketProbeResult()
  let generation = 0
  let active = null
  let lastStartedAt = null

  function timestamp() {
    const now = config.clock()
    if (!Number.isSafeInteger(now) || now < MIN_TIME || now > IFIND_MARKET_MAX_CREATED_AT) fail()
    return now
  }

  function describe() {
    if (active || CLIENT_OWNERS.has(config.client)) return idleResult('busy')
    if (current.status !== 'ready') return copyIfindMarketProbeResult(current)
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
      return copyIfindMarketProbeResult(current)
    } catch { return unavailableResult() }
  }

  async function run(...args) {
    if (args.length !== 0) throw new IfindMarketProbeServiceError(FAILED)
    if (active || CLIENT_OWNERS.has(config.client)) return idleResult('busy')
    let reservation
    let createdAt
    try {
      createdAt = timestamp()
      if (lastStartedAt !== null && createdAt < lastStartedAt) fail()
      const id = config.idGenerator()
      if (!exactMatch(/^market_run_[a-f0-9]{24,64}$/, id)) fail()
      const request = { runId: id, caseId: CASE_ID, createdAt,
        tokenVersionId: config.tokenVersionId }
      const reserved = methods.reserve.call(config.repository, request)
      const status = ownValue(reserved, 'status')
      if (status === 'busy' || status === 'cooldown') return idleResult(status)
      if (status === 'case-daily-limit' || status === 'global-daily-limit') {
        return idleResult('daily-limit')
      }
      if (status !== 'reserved') return unavailableResult(new Date(createdAt).toISOString())
      const envelope = record(reserved, ['status', 'reservation', 'localDayKey',
        'caseAttemptCount', 'globalAttemptCount'])
      if (envelope.status !== 'reserved' ||
          !exactMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, envelope.localDayKey) ||
          !Number.isSafeInteger(envelope.caseAttemptCount) || envelope.caseAttemptCount < 1 ||
          !Number.isSafeInteger(envelope.globalAttemptCount) || envelope.globalAttemptCount < 1) fail()
      const received = record(envelope.reservation, [
        'runId', 'caseId', 'createdAt', 'tokenVersionId', 'leaseExpiresAt'
      ])
      if (received.runId !== request.runId || received.caseId !== request.caseId ||
          received.createdAt !== request.createdAt ||
          received.tokenVersionId !== request.tokenVersionId ||
          received.leaseExpiresAt !== createdAt + IFIND_MARKET_DIAGNOSTIC_LEASE_MS) fail()
      reservation = { ...request, leaseExpiresAt: received.leaseExpiresAt }
      lastStartedAt = createdAt
    } catch {
      return unavailableResult(Number.isSafeInteger(createdAt) ? new Date(createdAt).toISOString() : null)
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
    let status
    let errorCode
    let failureStage = 'provider'
    /** @type {ProbeObservations} */
    let observations = { identity: null, quote: null, financial: null }
    let result

    function checkLease() {
      let now
      try { now = timestamp() } catch { throw new LeaseFailure() }
      if (now < lastTime) throw new LeaseFailure()
      lastTime = now
      if (now >= reservation.leaseExpiresAt || generation !== owner.generation) {
        throw new LeaseFailure()
      }
    }

    try {
      try {
        checkLease()
        refreshToken = methods.readSecret.call(config.secretProvider)
        if (!isToken(refreshToken) || refreshToken.length < 1 || refreshToken.length > 4096) fail()

        status = 'failed'; errorCode = FAILED; failureStage = 'auth'
        checkLease()
        requestCount = 1
        const authOutput = await methods.authenticate.call(config.client, refreshToken)
        accessToken = ownValue(authOutput, 'accessToken')
        const authentication = record(authOutput, ['accessToken', 'requestCount'])
        if (authentication.requestCount !== 1 || !isToken(accessToken) ||
            accessToken.length < 1 || accessToken.length > 4096) fail()
        checkLease()

        for (let index = 0; index < STAGES.length; index += 1) {
          const stage = STAGES[index]
          failureStage = stage
          checkLease()
          requestCount += 1
          businessRequestCount += 1
          const output = await methods.probeFixed.call(config.client, accessToken, PROPOSAL_ID, index + 1)
          checkLease()
          const copied = copyProbeEnvelope(output, stage)
          observations[stage] = copied.observation
          if (copied.dataVol !== null) {
            const nextVolume = (dataVol === null ? 0 : dataVol) + copied.dataVol
            if (!Number.isSafeInteger(nextVolume)) fail()
            dataVol = nextVolume
          }
        }
        checkLease()
        status = 'observed-unverified'; errorCode = OBSERVED; failureStage = null
      } catch (error) {
        if (error instanceof LeaseFailure) failureStage = 'lease'
        if (failureStage === 'provider') {
          status = 'unavailable'; errorCode = UNAVAILABLE
        } else {
          status = 'failed'; errorCode = FAILED
        }
        try {
          const now = timestamp()
          if (now >= lastTime) lastTime = now
        } catch {
          // Keep the latest valid monotonic instant for settlement.
        }
      }

      result = copyIfindMarketProbeResult({ ...createInitialIfindMarketProbeResult(), status,
        observations, requestCount, businessRequestCount, dataVol,
        attemptedAt: new Date(reservation.createdAt).toISOString(), errorCode, failureStage })
      if (generation !== owner.generation) {
        status = 'failed'; errorCode = FAILED; failureStage = 'lease'
        observations = { identity: null, quote: null, financial: null }
        result = copyIfindMarketProbeResult({ ...result, status, observations,
          errorCode, failureStage })
      }
      const completedAt = Math.min(lastTime, reservation.leaseExpiresAt)
      try {
        const settlement = methods.fail.call(config.repository, { reservation, result: {
          status: 'failed', quoteStatus: 'not_run', financeStatus: 'not_run',
          requestCount: result.requestCount, dataVol: result.dataVol,
          elapsedMs: completedAt - reservation.createdAt,
          safeErrorClass: result.status === 'observed-unverified' ? 'PERIOD_UNVERIFIED'
            : result.failureStage === 'provider' || result.failureStage === 'auth' ? 'AUTH' : 'API',
          failureCode: result.errorCode, vendorErrorCode: null, completedAt
        } })
        const settled = record(settlement, ['status', 'cooldownUntil'])
        if (settled.status !== 'completed' ||
            settled.cooldownUntil !== completedAt + IFIND_MARKET_CASE_COOLDOWN_MS) fail()
      } catch {
        result = copyIfindMarketProbeResult({ ...result, status: 'unavailable',
          observations: { identity: null, quote: null, financial: null },
          errorCode: UNAVAILABLE, failureStage: 'lease' })
      }
    } finally {
      wipe(refreshToken); wipe(accessToken)
      if (CLIENT_OWNERS.get(config.client) === owner) {
        try { await methods.clearClient.call(config.client) } catch {
          // Best-effort cleanup cannot expose provider failures or retry a call.
        } finally { CLIENT_OWNERS.delete(config.client) }
      }
      active = null
    }

    const exactResult = { ...result, observations: {
      identity: result.observations.identity,
      quote: result.observations.quote,
      financial: result.observations.financial
    } }
    if (generation === owner.generation) current = exactResult
    return copyIfindMarketProbeResult(exactResult)
  }

  function clear() {
    generation += 1
    current = createInitialIfindMarketProbeResult()
    return copyIfindMarketProbeResult(current)
  }

  return Object.freeze({ describe, run, clear })
}

module.exports = { IfindMarketProbeServiceError, createIfindMarketProbeService }

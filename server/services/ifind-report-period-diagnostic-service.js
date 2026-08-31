'use strict'

const { randomBytes } = require('node:crypto')
const { types } = require('node:util')
const {
  createInitialReportPeriodDiagnosticResult,
  copyReportPeriodDiagnosticResult,
  parseReportPeriodDiagnosticObservation
} = require('../domain/ifind-report-period-diagnostic')
const {
  IFIND_MARKET_CASE_COOLDOWN_MS,
  IFIND_MARKET_DIAGNOSTIC_LEASE_MS,
  IFIND_MARKET_MAX_CREATED_AT
} = require('../db/ifind-market-diagnostic-repository')

const CASE_ID = 'HK_ALIBABA_9988'
const FAILED = 'IFIND_REPORT_PERIOD_DIAGNOSTIC_FAILED'
const UNAVAILABLE = 'IFIND_REPORT_PERIOD_DIAGNOSTIC_UNAVAILABLE'
const OBSERVED = 'IFIND_REPORT_PERIOD_DIAGNOSTIC_OBSERVED_UNVERIFIED'
const MIN_TIME = Date.parse('2000-01-01T00:00:00.000Z')
// Runtime supplies a dedicated client, never the market/calibration client.
const CLIENT_OWNERS = new WeakMap()

class ReportPeriodDiagnosticServiceError extends Error {
  constructor(code = UNAVAILABLE) {
    super('The iFinD report-period diagnostic operation is unavailable')
    this.name = 'ReportPeriodDiagnosticServiceError'
    this.code = code
  }
}

function fail() { throw new ReportPeriodDiagnosticServiceError(FAILED) }

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

function validVolume(value) { return value === null || (Number.isSafeInteger(value) && value >= 0) }
function isToken(value) { return !types.isProxy(value) && Buffer.isBuffer(value) }
function wipe(value) {
  try { if (isToken(value)) Buffer.prototype.fill.call(value, 0) } catch {
    // Cleanup never exposes provider values or replaces safe bookkeeping.
  }
}

function idleResult(status) {
  const result = createInitialReportPeriodDiagnosticResult()
  result.status = status
  if (status === 'unavailable') result.errorCode = UNAVAILABLE
  return result
}

function createIfindReportPeriodDiagnosticService(options) {
  let config
  let methods
  try {
    config = record(options, ['repository', 'client', 'secretProvider', 'tokenVersionId', 'clock', 'idGenerator'],
      ['repository', 'client', 'secretProvider', 'tokenVersionId'])
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
      diagnose: methodReference(config.client, 'diagnoseReportPeriod'),
      clearClient: methodReference(config.client, 'clear'),
      readSecret: methodReference(config.secretProvider, 'readRefreshToken')
    }
  } catch {
    throw new ReportPeriodDiagnosticServiceError()
  }

  let current = createInitialReportPeriodDiagnosticResult()
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
    if (current.status !== 'ready') return copyReportPeriodDiagnosticResult(current)
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
      return copyReportPeriodDiagnosticResult(current)
    } catch { return idleResult('unavailable') }
  }

  async function run(...args) {
    if (args.length !== 0) throw new ReportPeriodDiagnosticServiceError(FAILED)
    if (active || CLIENT_OWNERS.has(config.client)) return idleResult('busy')
    let reservation
    try {
      const createdAt = timestamp()
      if (lastStartedAt !== null && createdAt < lastStartedAt) fail()
      const runId = config.idGenerator()
      if (!exactMatch(/^market_run_[a-f0-9]{24,64}$/, runId)) fail()
      const request = { runId, caseId: CASE_ID, createdAt, tokenVersionId: config.tokenVersionId }
      // Shared SQLite R1 reservation is authoritative and precedes secret access.
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
    } catch { return idleResult('unavailable') }

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
        status = 'unavailable'; errorCode = UNAVAILABLE; safeErrorClass = 'AUTH'
        refreshToken = methods.readSecret.call(config.secretProvider)
        if (!isToken(refreshToken) || refreshToken.length < 1 || refreshToken.length > 4096) fail()
        status = 'failed'; errorCode = FAILED
        checkLease()
        requestCount = 1
        const authOutput = await methods.authenticate.call(config.client, refreshToken)
        // Capture owned buffers before envelope/count validation, even on failure.
        accessToken = ownValue(authOutput, 'accessToken')
        safeErrorClass = 'RESPONSE_SHAPE'
        const authentication = record(authOutput, ['accessToken', 'requestCount'])
        if (authentication.requestCount !== 1 || !isToken(accessToken) ||
            accessToken.length < 1 || accessToken.length > 4096) fail()
        safeErrorClass = 'NETWORK'
        checkLease()
        requestCount = 2; businessRequestCount = 1
        const output = await methods.diagnose.call(config.client, accessToken)
        safeErrorClass = 'RESPONSE_SHAPE'
        const business = record(output, ['payload', 'requestCount', 'dataVol'])
        if (!validVolume(business.dataVol)) fail()
        dataVol = business.dataVol
        if (business.requestCount !== 1) fail()
        safeErrorClass = 'NETWORK'
        checkLease()
        safeErrorClass = 'RESPONSE_SHAPE'
        observation = parseReportPeriodDiagnosticObservation(business.payload)
        safeErrorClass = 'NETWORK'
        checkLease()
        status = 'observed-unverified'; errorCode = OBSERVED; safeErrorClass = 'PERIOD_UNVERIFIED'
      } catch (error) {
        observation = null
        if (businessRequestCount === 1 && dataVol === null) {
          const volume = ownValue(error, 'dataVol')
          if (validVolume(volume)) dataVol = volume
        }
        try { const now = timestamp(); if (now >= lastTime) lastTime = now } catch {
          // Retain the last valid monotonic instant if the clock fails.
        }
      }
      const completedAt = Math.min(lastTime, reservation.leaseExpiresAt)
      result = {
        ...createInitialReportPeriodDiagnosticResult(), status, observation,
        requestCount, businessRequestCount, dataVol,
        attemptedAt: new Date(reservation.createdAt).toISOString(), errorCode
      }
      try {
        // Never persist numerical/date evidence or mark the market case verified.
        const settlement = methods.fail.call(config.repository, {
          reservation,
          result: {
            status: 'failed', quoteStatus: 'not_run', financeStatus: 'unavailable',
            requestCount, dataVol, elapsedMs: completedAt - reservation.createdAt,
            safeErrorClass, failureCode: errorCode, vendorErrorCode: null, completedAt
          }
        })
        const settled = record(settlement, ['status', 'cooldownUntil'])
        if (settled.status !== 'completed' ||
            settled.cooldownUntil !== completedAt + IFIND_MARKET_CASE_COOLDOWN_MS) fail()
      } catch {
        result.status = 'unavailable'; result.errorCode = UNAVAILABLE; result.observation = null
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
    if (generation !== owner.generation && result.observation !== null) {
      result.status = 'failed'; result.errorCode = FAILED; result.observation = null
    }
    if (generation === owner.generation) current = copyReportPeriodDiagnosticResult(result)
    return copyReportPeriodDiagnosticResult(result)
  }

  function clear() {
    generation += 1
    current = createInitialReportPeriodDiagnosticResult()
    // Invalidates late results without releasing an active reservation/client.
    return copyReportPeriodDiagnosticResult(current)
  }

  return Object.freeze({ describe, run, clear })
}

module.exports = { createIfindReportPeriodDiagnosticService }

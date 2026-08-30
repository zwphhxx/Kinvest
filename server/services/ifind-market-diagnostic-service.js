'use strict'

const { types, isDeepStrictEqual } = require('node:util')
const {
  getVerifiedMarketManifest,
  validateLiveRequestManifestDefinition
} = require('../domain/ifind-market-manifest-validator')
const { isClientFailureMetadata } = require('../contracts/ifind-diagnostic-errors')

const MAX_REQUEST_COUNT = 5
const CLIENT_OWNERS = new WeakMap()
const RUN_ID_PATTERN = /^market_run_[a-f0-9]{24,64}$/
const VERSION_ID_PATTERN = /^v[0-9]{8}-[0-9]{3}$/
const CASE_ID_PATTERN = /^(?:HK|US|CN)_[A-Z][A-Z0-9]{0,31}_[A-Z0-9]{1,16}$/
const FIXED_PARSER_IDS = Object.freeze({
  HK_ALIBABA_9988: 'ifind-hk-equity-v1',
  US_APPLE_AAPL: 'ifind-us-equity-v1',
  CN_MOUTAI_600519: 'ifind-cn-equity-v1'
})
const VERIFICATION_FIELDS = Object.freeze([
  'issuerIdentityStatus',
  'vendorCodeStatus',
  'entitlementStatus',
  'currencyStatus',
  'unitStatus',
  'reportPeriodStatus',
  'scopeStatus',
  'sourceMode'
])
const QUOTE_RESULT_FIELDS = Object.freeze([
  'caseId', 'listingId', 'displayCode', 'latestPrice', 'previousClose',
  'open', 'high', 'low', 'volume', 'turnover', 'quoteTime',
  'tradingStatus', 'currency', 'source', 'verification', 'missingFields'
])
const FINANCIAL_RESULT_FIELDS = Object.freeze([
  'caseId', 'listingId', 'displayCode', 'source', 'availability',
  'verification', 'points'
])
const FINANCIAL_POINT_FIELDS = Object.freeze([
  'indicatorId', 'metricKey', 'value', 'currency', 'unit', 'reportPeriod',
  'reportDate', 'periodType', 'disclosureScope', 'sourceTime', 'fetchTime',
  'verification', 'availability'
])
const FINANCIAL_METRIC_KEYS = new Set([
  'revenue', 'grossProfit', 'attributableNetProfit', 'operatingCashFlow',
  'receivables', 'inventory', 'interestBearingDebt'
])
const FINANCIAL_DISCLOSURE_SCOPES = Object.freeze({
  HK_ALIBABA_9988: 'consolidated',
  US_APPLE_AAPL: 'issuer_consolidated',
  CN_MOUTAI_600519: 'consolidated'
})
const LEASE_DURATION_MS = 30_000
const SNAPSHOT_WORK_LIMIT = 4096
const DANGEROUS_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const REPOSITORY_SAFE_CLASSES = new Set([
  'AUTH', 'PERMISSION', 'INDICATOR', 'QUOTA', 'NETWORK', 'API',
  'RESPONSE_SHAPE', 'IDENTITY_CONFLICT', 'CURRENCY_MISMATCH',
  'UNIT_UNVERIFIED', 'PERIOD_UNVERIFIED'
])

class IfindMarketDiagnosticServiceError extends Error {
  constructor() {
    super('The iFinD market diagnostic service configuration is invalid')
    this.name = 'IfindMarketDiagnosticServiceError'
    this.code = 'IFIND_MARKET_DIAGNOSTIC_SERVICE_INVALID'
  }
}

class SafeFailure extends Error {
  constructor(failureCode, safeErrorClass, stage, vendorErrorCode = null, status = 'failed') {
    super('The iFinD market diagnostic operation failed')
    this.name = 'SafeFailure'
    this.failureCode = failureCode
    this.safeErrorClass = safeErrorClass
    this.stage = stage
    this.vendorErrorCode = vendorErrorCode
    this.status = status
  }
}

function failConfig() {
  throw new IfindMarketDiagnosticServiceError()
}

function isObjectLike(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

function exactDataObject(value, expectedKeys, prototypeRequired = true) {
  try {
    if (!isObjectLike(value) || types.isProxy(value) || Array.isArray(value)) return null
    const prototype = Reflect.getPrototypeOf(value)
    if (prototypeRequired && prototype !== Object.prototype && prototype !== null) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.getOwnPropertySymbols(value).length !== 0) return null
    const keys = Object.keys(descriptors)
    if (keys.length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.hasOwn(descriptors, key))) return null
    const snapshot = Object.create(null)
    for (const key of expectedKeys) {
      const descriptor = descriptors[key]
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null
      snapshot[key] = descriptor.value
    }
    return snapshot
  } catch {
    return null
  }
}

function ownDataValue(value, key) {
  try {
    if (!isObjectLike(value) || types.isProxy(value)) return { present: false }
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return { present: false }
    }
    return { present: true, value: descriptor.value }
  } catch {
    return { present: false }
  }
}

function ownBufferReference(value, key) {
  try {
    if (!isObjectLike(value) || types.isProxy(value)) return null
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value') ||
      types.isProxy(descriptor.value) || !Buffer.isBuffer(descriptor.value)) return null
    return descriptor.value
  } catch {
    return null
  }
}

function methodReference(value, name) {
  try {
    if (!isObjectLike(value) || types.isProxy(value)) failConfig()
    let current = value
    for (let depth = 0; current && depth < 8; depth += 1) {
      if (types.isProxy(current)) failConfig()
      const descriptor = Reflect.getOwnPropertyDescriptor(current, name)
      if (descriptor) {
        if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
          failConfig()
        }
        return descriptor.value
      }
      current = Reflect.getPrototypeOf(current)
    }
  } catch (error) {
    if (error instanceof IfindMarketDiagnosticServiceError) throw error
  }
  failConfig()
}

function snapshotTree(value, state = { work: 0, active: new Set() }, depth = 0) {
  if (state.work >= SNAPSHOT_WORK_LIMIT) {
    throw new SafeFailure(
      'IFIND_MARKET_CLIENT_OUTPUT_INVALID', 'RESPONSE_SHAPE', 'client'
    )
  }
  state.work += 1
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SafeFailure(
      'IFIND_MARKET_CLIENT_OUTPUT_INVALID', 'RESPONSE_SHAPE', 'client'
    )
    return value
  }
  if (typeof value !== 'object' || types.isProxy(value) || depth > 12) {
    throw new SafeFailure(
      'IFIND_MARKET_CLIENT_OUTPUT_INVALID', 'RESPONSE_SHAPE', 'client'
    )
  }
  if (state.active.has(value)) {
    throw new SafeFailure(
      'IFIND_MARKET_CLIENT_OUTPUT_INVALID', 'RESPONSE_SHAPE', 'client'
    )
  }
  state.active.add(value)
  try {
    const prototype = Reflect.getPrototypeOf(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error('invalid')
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype || descriptors.length.value !== value.length ||
        Object.keys(descriptors).length !== value.length + 1 || value.length > 1024) {
        throw new Error('invalid')
      }
      const result = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[index]
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new Error('invalid')
        }
        result.push(snapshotTree(descriptor.value, state, depth + 1))
      }
      return Object.freeze(result)
    }
    if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid')
    const result = Object.create(null)
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (DANGEROUS_RECORD_KEYS.has(key) || !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')) throw new Error('invalid')
      Object.defineProperty(result, key, {
        value: snapshotTree(descriptor.value, state, depth + 1),
        enumerable: true,
        configurable: false,
        writable: false
      })
    }
    return Object.freeze(result)
  } catch (error) {
    if (error instanceof SafeFailure) throw error
    throw new SafeFailure(
      'IFIND_MARKET_CLIENT_OUTPUT_INVALID', 'RESPONSE_SHAPE', 'client'
    )
  } finally {
    state.active.delete(value)
  }
}

function snapshotParserTree(value, failureCode, stage, state = {
  work: 0,
  active: new Set()
}, depth = 0) {
  const fail = () => {
    throw new SafeFailure(failureCode, 'RESPONSE_SHAPE', stage)
  }
  if (state.work >= SNAPSHOT_WORK_LIMIT) fail()
  state.work += 1
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail()
    return value
  }
  if (typeof value !== 'object' || types.isProxy(value) || depth > 12 ||
    state.active.has(value)) fail()

  state.active.add(value)
  try {
    const prototype = Reflect.getPrototypeOf(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.getOwnPropertySymbols(value).length !== 0) fail()

    if (Array.isArray(value)) {
      const lengthDescriptor = descriptors.length
      if (prototype !== Array.prototype || !lengthDescriptor ||
        !Object.hasOwn(lengthDescriptor, 'value') ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 || lengthDescriptor.value > 1024 ||
        Object.getOwnPropertyNames(value).length !== lengthDescriptor.value + 1) fail()
      const result = []
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = descriptors[index]
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
        result.push(snapshotParserTree(
          descriptor.value,
          failureCode,
          stage,
          state,
          depth + 1
        ))
      }
      return Object.freeze(result)
    }

    if (prototype !== Object.prototype && prototype !== null) fail()
    const keys = Object.keys(descriptors)
    if (keys.length > 1024) fail()
    const result = Object.create(null)
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (DANGEROUS_RECORD_KEYS.has(key) || !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')) fail()
      Object.defineProperty(result, key, {
        value: snapshotParserTree(
          descriptor.value,
          failureCode,
          stage,
          state,
          depth + 1
        ),
        enumerable: true,
        configurable: false,
        writable: false
      })
    }
    return Object.freeze(result)
  } catch (error) {
    if (error instanceof SafeFailure) throw error
    fail()
  } finally {
    state.active.delete(value)
  }
}

function materializeParserInput(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => materializeParserInput(entry)))
  }
  const result = {}
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    Object.defineProperty(result, key, {
      value: materializeParserInput(descriptor.value),
      enumerable: true,
      configurable: false,
      writable: false
    })
  }
  return Object.freeze(result)
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || Object.isFrozen(value)) {
    return value
  }
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function clearBuffer(value) {
  try {
    if (!types.isProxy(value) && Buffer.isBuffer(value)) {
      Buffer.prototype.fill.call(value, 0)
    }
  } catch {
    // Cleanup failure must not replace the originating safe result.
  }
}

function readTimestamp(clock) {
  try {
    const value = clock()
    const timestamp = value instanceof Date ? Date.prototype.getTime.call(value) : value
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 ||
      timestamp > 8_640_000_000_000_000) failConfig()
    return timestamp
  } catch (error) {
    if (error instanceof IfindMarketDiagnosticServiceError) throw error
    failConfig()
  }
}

function safeResult(failure) {
  return {
    status: failure.status,
    failureCode: failure.failureCode,
    safeErrorClass: failure.safeErrorClass,
    stage: failure.stage,
    vendorErrorCode: failure.vendorErrorCode
  }
}

function repositoryFailure() {
  return new SafeFailure('IFIND_MARKET_REPOSITORY_FAILED', 'API', 'repository')
}

function budgetFailure(stage) {
  return new SafeFailure(
    'IFIND_MARKET_REQUEST_BUDGET_EXHAUSTED', 'QUOTA', stage
  )
}

function validateVerification(value) {
  const snapshot = exactDataObject(value, VERIFICATION_FIELDS)
  if (!snapshot) throw new SafeFailure(
    'IFIND_MARKET_CASE_UNVERIFIED', 'CONFIG', 'catalog', null, 'rejected'
  )
  for (const key of VERIFICATION_FIELDS) {
    if (key === 'sourceMode') {
      if (snapshot[key] !== 'real') throw new SafeFailure(
        'IFIND_MARKET_CASE_UNVERIFIED', 'CONFIG', 'catalog', null, 'rejected'
      )
    } else if (snapshot[key] !== 'verified') {
      throw new SafeFailure(
        'IFIND_MARKET_CASE_UNVERIFIED', 'CONFIG', 'catalog', null, 'rejected'
      )
    }
  }
  return deepFreeze({ ...snapshot })
}

function validateParserVerification(value, failureCode, stage) {
  const snapshot = exactDataObject(value, VERIFICATION_FIELDS)
  if (!snapshot) throw new SafeFailure(failureCode, 'RESPONSE_SHAPE', stage)
  for (const key of VERIFICATION_FIELDS) {
    const expected = key === 'sourceMode' ? 'real' : 'verified'
    if (snapshot[key] !== expected) {
      throw new SafeFailure(failureCode, 'RESPONSE_SHAPE', stage)
    }
  }
}

function canonicalReportPeriod(value) {
  if (typeof value !== 'string') return null
  let match = /^(20[0-9]{2})(Q[1-3]|H1|FY)$/.exec(value)
  if (match) return value
  match = /^FY(20[0-9]{2})$/.exec(value)
  if (match) return `${match[1]}FY`
  match = /^H1-FY(20[0-9]{2})$/.exec(value)
  if (match) return `${match[1]}H1`
  match = /^Q([1-3])-FY(20[0-9]{2})$/.exec(value)
  if (match) return `${match[2]}Q${match[1]}`
  match = /^(20[0-9]{2})A$/.exec(value)
  return match ? `${match[1]}FY` : null
}

function isCanonicalCalendarDate(value) {
  if (typeof value !== 'string') return false
  const match = /^(20[0-9]{2})-([0-9]{2})-([0-9]{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
}

function isStrictTimestamp(value) {
  if (typeof value !== 'string') return false
  const match = /^(20[0-9]{2}-[0-9]{2}-[0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{3})?(Z|([+-])([0-9]{2}):([0-9]{2}))$/.exec(value)
  if (!match || !isCanonicalCalendarDate(match[1])) return false
  const hour = Number(match[2])
  const minute = Number(match[3])
  const second = Number(match[4])
  if (hour > 23 || minute > 59 || second > 59) return false
  if (match[5] !== 'Z') {
    const offsetHour = Number(match[7])
    const offsetMinute = Number(match[8])
    if (offsetHour > 14 || offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)) return false
  }
  return Number.isFinite(Date.parse(value))
}

function validateCatalogCase(caseId, value) {
  try {
    if (!value || types.isProxy(value)) throw new Error('invalid')
    validateLiveRequestManifestDefinition(value)
    const observedCaseId = ownDataValue(value, 'caseId')
    const liveReady = ownDataValue(value, 'liveReady')
    const parserId = ownDataValue(value, 'parserId')
    const listingId = ownDataValue(value, 'listingId')
    const displayCode = ownDataValue(value, 'displayCode')
    const expectedTradingCurrency = ownDataValue(value, 'expectedTradingCurrency')
    if (!observedCaseId.present || observedCaseId.value !== caseId ||
      !liveReady.present || liveReady.value !== true ||
      !parserId.present || parserId.value !== FIXED_PARSER_IDS[caseId] ||
      !listingId.present || typeof listingId.value !== 'string' ||
      !displayCode.present || typeof displayCode.value !== 'string' ||
      !expectedTradingCurrency.present ||
      typeof expectedTradingCurrency.value !== 'string') throw new Error('invalid')
    return value
  } catch {
    throw new SafeFailure(
      'IFIND_MARKET_CASE_UNVERIFIED', 'CONFIG', 'catalog', null, 'rejected'
    )
  }
}

function validateCurrencyEvidence(value, caseId, listingId) {
  const fields = [
    'caseId', 'listingId', 'currency', 'evidenceStatus', 'sourceIdentity',
    'sourceReference', 'verifiedAt'
  ]
  const snapshot = exactDataObject(value, fields)
  if (!snapshot || snapshot.caseId !== caseId || snapshot.listingId !== listingId ||
    typeof snapshot.currency !== 'string' || !/^[A-Z]{3}$/.test(snapshot.currency) ||
    snapshot.evidenceStatus !== 'verified' ||
    typeof snapshot.sourceIdentity !== 'string' ||
    typeof snapshot.sourceReference !== 'string' ||
    typeof snapshot.verifiedAt !== 'string' ||
    !Number.isFinite(Date.parse(snapshot.verifiedAt)) ||
    /token|secret|password|authorization|cookie|requestid/i.test(
      snapshot.sourceIdentity + snapshot.sourceReference
    )) {
    throw new SafeFailure(
      'IFIND_MARKET_CASE_UNVERIFIED', 'CONFIG', 'catalog', null, 'rejected'
    )
  }
  return deepFreeze({ ...snapshot })
}

function validateManifestBundle(caseId, catalogCase, value) {
  const bundle = exactDataObject(value, [
    'manifest', 'quoteVerification', 'financialVerification',
    'financialReportingCurrencyEvidence'
  ])
  const manifest = bundle && exactDataObject(bundle.manifest, [
    'caseId', 'vendorCode', 'requestTemplates', 'indicators', 'periodRules',
    'parserId'
  ])
  if (!bundle || !manifest || !getVerifiedMarketManifest(value, caseId)) throw new SafeFailure(
    'IFIND_MARKET_CASE_UNVERIFIED', 'CONFIG', 'catalog', null, 'rejected'
  )
  try {
    const vendorCodes = ownDataValue(catalogCase, 'vendorCodes').value
    const ifind = ownDataValue(vendorCodes, 'ifind').value
    const expectedVendorCode = ownDataValue(ifind, 'code').value
    const requestTemplates = ownDataValue(catalogCase, 'requestTemplates').value
    const indicators = ownDataValue(catalogCase, 'indicators').value
    const periodRules = ownDataValue(catalogCase, 'periodRules').value
    if (manifest.caseId !== caseId || manifest.parserId !== FIXED_PARSER_IDS[caseId] ||
      manifest.vendorCode !== expectedVendorCode ||
      !isDeepStrictEqual(manifest.requestTemplates, requestTemplates) ||
      !isDeepStrictEqual(manifest.indicators, indicators) ||
      !isDeepStrictEqual(manifest.periodRules, periodRules)) throw new Error('invalid')
    const listingId = ownDataValue(catalogCase, 'listingId').value
    validateVerification(bundle.quoteVerification)
    validateVerification(bundle.financialVerification)
    validateCurrencyEvidence(bundle.financialReportingCurrencyEvidence, caseId, listingId)
    return value
  } catch (error) {
    if (error instanceof SafeFailure && error.stage === 'catalog') throw error
    throw new SafeFailure(
      'IFIND_MARKET_CASE_UNVERIFIED', 'CONFIG', 'catalog', null, 'rejected'
    )
  }
}

function buildFixedRequests(manifest) {
  try {
    const quoteTemplate = manifest.requestTemplates.quote
    const financialTemplate = manifest.requestTemplates.financial
    const vendorParameters = manifest.periodRules.vendorParameters
    return {
      quote: deepFreeze({
        vendorCode: manifest.vendorCode,
        fields: [...quoteTemplate.fields]
      }),
      financial: deepFreeze({
        vendorCode: manifest.vendorCode,
        indicatorIds: [...financialTemplate.indicatorIds],
        periodParameters: {
          fullFiscalYears: materializeParserInput(snapshotTree(
            vendorParameters.fullFiscalYears.requestParameters
          )),
          latestDisclosedInterim: materializeParserInput(snapshotTree(
            vendorParameters.latestDisclosedInterim.requestParameters
          ))
        }
      })
    }
  } catch {
    throw new SafeFailure(
      'IFIND_MARKET_CASE_UNVERIFIED', 'CONFIG', 'catalog', null, 'rejected'
    )
  }
}

function validQuotaSnapshot(value) {
  return isCanonicalCalendarDate(value.localDayKey) &&
    Number.isSafeInteger(value.caseAttemptCount) && value.caseAttemptCount >= 0 &&
    Number.isSafeInteger(value.globalAttemptCount) && value.globalAttemptCount >= 0 &&
    Number.isSafeInteger(value.caseRemaining) && value.caseRemaining >= 0 &&
    Number.isSafeInteger(value.globalRemaining) && value.globalRemaining >= 0 &&
    (value.cooldownUntil === null ||
      (Number.isSafeInteger(value.cooldownUntil) && value.cooldownUntil >= 0)) &&
    typeof value.inFlight === 'boolean' &&
    (value.inFlightCaseId === null ||
      (typeof value.inFlightCaseId === 'string' &&
        CASE_ID_PATTERN.test(value.inFlightCaseId))) &&
    (value.inFlightExpiresAt === null ||
      (Number.isSafeInteger(value.inFlightExpiresAt) && value.inFlightExpiresAt >= 0))
}

function validateReservation(expected, value) {
  const result = exactDataObject(value, [
    'status', 'reservation', 'localDayKey', 'caseAttemptCount',
    'globalAttemptCount'
  ])
  const reservation = result && exactDataObject(result.reservation, [
    'runId', 'caseId', 'createdAt', 'tokenVersionId', 'leaseExpiresAt'
  ])
  if (!result || result.status !== 'reserved' || !reservation ||
    !isCanonicalCalendarDate(result.localDayKey) ||
    !Number.isSafeInteger(result.caseAttemptCount) || result.caseAttemptCount < 1 ||
    !Number.isSafeInteger(result.globalAttemptCount) || result.globalAttemptCount < 1 ||
    reservation.runId !== expected.runId || reservation.caseId !== expected.caseId ||
    reservation.createdAt !== expected.createdAt ||
    reservation.tokenVersionId !== expected.tokenVersionId ||
    reservation.leaseExpiresAt !== expected.createdAt + LEASE_DURATION_MS) {
    throw repositoryFailure()
  }
  return { ...reservation }
}

function reservationRejection(value) {
  const statuses = new Set([
    'busy', 'cooldown', 'case-daily-limit', 'global-daily-limit'
  ])
  const fields = [
    'status', 'retryAt', 'localDayKey', 'caseAttemptCount',
    'globalAttemptCount', 'caseRemaining', 'globalRemaining', 'cooldownUntil',
    'inFlight', 'inFlightCaseId', 'inFlightExpiresAt'
  ]
  const result = exactDataObject(value, fields)
  if (result && statuses.has(result.status) && Number.isSafeInteger(result.retryAt) &&
    result.retryAt >= 0 && validQuotaSnapshot(result)) {
    if (result.status === 'busy') {
      return new SafeFailure(
        'IFIND_MARKET_LEASE_CONFLICT', 'BUSY', 'reserve', null, 'busy'
      )
    }
    const codes = {
      cooldown: 'IFIND_MARKET_COOLDOWN',
      'case-daily-limit': 'IFIND_MARKET_CASE_DAILY_LIMIT',
      'global-daily-limit': 'IFIND_MARKET_GLOBAL_DAILY_LIMIT'
    }
    return new SafeFailure(codes[result.status], 'RATE_LIMITED', 'reserve', null, result.status)
  }
  const stableResult = exactDataObject(value, [
    'status', 'localDayKey', 'caseAttemptCount', 'globalAttemptCount',
    'caseRemaining', 'globalRemaining', 'cooldownUntil', 'inFlight',
    'inFlightCaseId', 'inFlightExpiresAt'
  ])
  if (stableResult && validQuotaSnapshot(stableResult) && stableResult.status === 'duplicate') {
    return new SafeFailure(
      'IFIND_MARKET_RESERVATION_DUPLICATE', 'CONFIG', 'reserve', null, 'rejected'
    )
  }
  if (stableResult && validQuotaSnapshot(stableResult) &&
    stableResult.status === 'clock-rollback') {
    return new SafeFailure(
      'IFIND_MARKET_CLOCK_ROLLBACK', 'CONFIG', 'reserve', null, 'clock-rollback'
    )
  }
  return null
}

function validateSettlement(value) {
  let result = exactDataObject(value, ['status', 'cooldownUntil'])
  if (result && result.status === 'completed' && Number.isSafeInteger(result.cooldownUntil)) {
    return true
  }
  result = exactDataObject(value, ['status'])
  return Boolean(result && (result.status === 'not-found' || result.status === 'conflict'))
}

function readClientFailure(error, stage) {
  const fallback = new SafeFailure('IFIND_CLIENT_FAILED', 'API', stage)
  try {
    if (!isObjectLike(error) || types.isProxy(error)) return fallback
    const read = (key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(error, key)
      return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
    }
    const requestCount = read('requestCount')
    if (requestCount !== undefined && requestCount !== 1) {
      return new SafeFailure(
        'IFIND_MARKET_CLIENT_CONTRACT_INVALID', 'RESPONSE_SHAPE', stage
      )
    }
    const metadata = {
      failureCode: read('failureCode'),
      errorClass: read('class'),
      stage: read('stage'),
      vendorErrorCode: read('vendorErrorCode')
    }
    if (!isClientFailureMetadata(metadata)) {
      return fallback
    }
    return new SafeFailure(
      metadata.failureCode,
      metadata.errorClass,
      metadata.stage || stage,
      metadata.vendorErrorCode
    )
  } catch {
    return fallback
  }
}

function decodeAuthResult(value) {
  let result = exactDataObject(value, ['accessToken'])
  if (!result) result = exactDataObject(value, ['accessToken', 'requestCount'])
  if (!result || (result.requestCount !== undefined && result.requestCount !== 1)) {
    throw new SafeFailure(
      result
        ? 'IFIND_MARKET_CLIENT_CONTRACT_INVALID'
        : 'IFIND_MARKET_CLIENT_OUTPUT_INVALID',
      'RESPONSE_SHAPE', 'auth'
    )
  }
  if (types.isProxy(result.accessToken) || !Buffer.isBuffer(result.accessToken) ||
    result.accessToken.length < 1 || result.accessToken.length > 4096) {
    throw new SafeFailure(
      'IFIND_MARKET_CLIENT_OUTPUT_INVALID', 'RESPONSE_SHAPE', 'auth'
    )
  }
  return result
}

function decodeMarketResult(value, stage) {
  let result = exactDataObject(value, ['payload', 'dataVol'])
  if (!result) result = exactDataObject(value, ['payload', 'requestCount', 'dataVol'])
  if (!result || (result.requestCount !== undefined && result.requestCount !== 1) ||
    (result.dataVol !== null &&
      (!Number.isSafeInteger(result.dataVol) || result.dataVol < 0))) {
    throw new SafeFailure(
      result
        ? 'IFIND_MARKET_CLIENT_CONTRACT_INVALID'
        : 'IFIND_MARKET_CLIENT_OUTPUT_INVALID',
      'RESPONSE_SHAPE', stage
    )
  }
  let payload
  try {
    payload = snapshotTree(result.payload)
  } catch {
    throw new SafeFailure(
      'IFIND_MARKET_CLIENT_OUTPUT_INVALID', 'RESPONSE_SHAPE', stage
    )
  }
  return { payload, dataVol: result.dataVol }
}

function parseQuote(quoteParser, caseId, catalogCase, payload, manifestBundle) {
  let parsed
  try {
    parsed = snapshotParserTree(
      quoteParser({
        caseId,
        payload: materializeParserInput(payload),
        verification: manifestBundle.quoteVerification,
        manifestBundle
      }),
      'IFIND_MARKET_QUOTE_UNAVAILABLE',
      'quote-parser'
    )
  } catch {
    throw new SafeFailure(
      'IFIND_MARKET_QUOTE_UNAVAILABLE', 'RESPONSE_SHAPE', 'quote-parser'
    )
  }
  const result = exactDataObject(parsed, QUOTE_RESULT_FIELDS)
  const listingId = ownDataValue(catalogCase, 'listingId').value
  const displayCode = ownDataValue(catalogCase, 'displayCode').value
  const currency = ownDataValue(catalogCase, 'expectedTradingCurrency').value
  if (result) validateParserVerification(
    result.verification,
    'IFIND_MARKET_QUOTE_UNAVAILABLE',
    'quote-parser'
  )
  if (!result || result.caseId !== caseId || result.listingId !== listingId ||
    result.displayCode !== displayCode || result.source !== 'real' ||
    result.currency !== currency || !Array.isArray(result.missingFields) ||
    result.missingFields.length !== 0 ||
    !['trading', 'halted', 'closed'].includes(result.tradingStatus) ||
    !isStrictTimestamp(result.quoteTime)) {
    throw new SafeFailure(
      'IFIND_MARKET_QUOTE_UNAVAILABLE', 'RESPONSE_SHAPE', 'quote-parser'
    )
  }
  for (const field of [
    'latestPrice', 'previousClose', 'open', 'high', 'low', 'volume', 'turnover'
  ]) {
    if (typeof result[field] !== 'number' || !Number.isFinite(result[field]) ||
      result[field] < 0) throw new SafeFailure(
      'IFIND_MARKET_QUOTE_UNAVAILABLE', 'RESPONSE_SHAPE', 'quote-parser'
    )
  }
  return {
    listingId: result.listingId,
    displayCode: result.displayCode,
    latestPrice: result.latestPrice,
    previousClose: result.previousClose,
    open: result.open,
    high: result.high,
    low: result.low,
    volume: result.volume,
    turnover: result.turnover,
    quoteTime: result.quoteTime,
    tradingStatus: result.tradingStatus,
    currency: result.currency
  }
}

function parseFinancials(
  financialParser,
  caseId,
  catalogCase,
  payload,
  verification,
  financialReportingCurrencyEvidence,
  manifestBundle,
  fetchTime
) {
  const manifest = manifestBundle.manifest
  let parserOutput
  try {
    parserOutput = financialParser({
      caseId,
      payload: materializeParserInput(payload),
      verification,
      financialReportingCurrencyEvidence,
      manifestBundle,
      fetchTime
    })
  } catch {
    throw new SafeFailure(
      'IFIND_MARKET_FINANCIAL_UNAVAILABLE', 'RESPONSE_SHAPE', 'financial-parser'
    )
  }
  const invalidOutput = () => {
    throw new SafeFailure(
      'IFIND_MARKET_FINANCIAL_UNAVAILABLE', 'RESPONSE_SHAPE', 'financial-parser'
    )
  }
  let parsed
  try {
    parsed = snapshotParserTree(
      parserOutput,
      'IFIND_MARKET_FINANCIAL_UNAVAILABLE',
      'financial-parser'
    )
  } catch {
    invalidOutput()
  }
  const result = exactDataObject(parsed, FINANCIAL_RESULT_FIELDS)
  const listingId = ownDataValue(catalogCase, 'listingId').value
  const displayCode = ownDataValue(catalogCase, 'displayCode').value
  if (result && (result.caseId !== caseId || result.listingId !== listingId ||
    result.displayCode !== displayCode)) {
    throw new SafeFailure(
      'IFIND_MARKET_IDENTITY_CONFLICT', 'IDENTITY_CONFLICT', 'financial-parser'
    )
  }
  if (result && result.caseId === caseId && result.listingId === listingId &&
    result.displayCode === displayCode && result.source === 'unavailable' &&
    result.availability === 'unavailable' && Array.isArray(result.points) &&
    result.points.length === 0) {
    throw new SafeFailure(
      'IFIND_MARKET_FINANCIAL_UNAVAILABLE', 'RESPONSE_SHAPE', 'financial-parser'
    )
  }
  try {
    if (result) validateParserVerification(
      result.verification,
      'IFIND_MARKET_FINANCIAL_UNAVAILABLE',
      'financial-parser'
    )
  } catch {
    invalidOutput()
  }
  if (!result || result.caseId !== caseId || result.listingId !== listingId ||
    result.displayCode !== displayCode || result.source !== 'real' ||
    result.availability !== 'available' || !Array.isArray(result.points) ||
    result.points.length !== 21 || types.isProxy(result.points)) invalidOutput()
  const financialIndicators = manifest && manifest.indicators &&
    manifest.indicators.financial
  if (!Array.isArray(financialIndicators) || financialIndicators.length !== 7) invalidOutput()
  const indicatorByMetric = new Map()
  for (const indicator of financialIndicators) {
    const value = exactDataObject(indicator, [
      'metric', 'vendorIndicatorId', 'evidenceStatus'
    ])
    if (!value || !FINANCIAL_METRIC_KEYS.has(value.metric) ||
      typeof value.vendorIndicatorId !== 'string' ||
      value.evidenceStatus !== 'verified' || indicatorByMetric.has(value.metric)) invalidOutput()
    indicatorByMetric.set(value.metric, value.vendorIndicatorId)
  }
  if (indicatorByMetric.size !== FINANCIAL_METRIC_KEYS.size) invalidOutput()
  const expectedCurrency = financialReportingCurrencyEvidence.currency
  const expectedScope = FINANCIAL_DISCLOSURE_SCOPES[caseId]
  const points = []
  const identities = new Set()
  const periods = new Map()
  for (const point of result.points) {
    const value = exactDataObject(point, FINANCIAL_POINT_FIELDS)
    try {
      if (value) validateParserVerification(
        value.verification,
        'IFIND_MARKET_FINANCIAL_UNAVAILABLE',
        'financial-parser'
      )
    } catch {
      invalidOutput()
    }
    const availableValue = value && value.availability === 'available' &&
      typeof value.value === 'number' && Number.isFinite(value.value)
    const missingValue = value && value.availability === 'missing' && value.value === null
    const reportPeriod = value && canonicalReportPeriod(value.reportPeriod)
    if (!value || value.indicatorId !== indicatorByMetric.get(value.metricKey) ||
      !FINANCIAL_METRIC_KEYS.has(value.metricKey) ||
      !reportPeriod ||
      !isCanonicalCalendarDate(value.reportDate) ||
      !['annual', 'interim'].includes(value.periodType) ||
      (!availableValue && !missingValue) ||
      value.currency !== expectedCurrency || value.unit !== 'million' ||
      value.disclosureScope !== expectedScope ||
      !isStrictTimestamp(value.sourceTime) || !isStrictTimestamp(value.fetchTime) ||
      value.fetchTime !== fetchTime) {
      invalidOutput()
    }
    const identity = `${value.metricKey}\u0000${reportPeriod}`
    if (identities.has(identity)) invalidOutput()
    identities.add(identity)
    const period = periods.get(reportPeriod)
    if (period && (period.reportDate !== value.reportDate ||
      period.periodType !== value.periodType ||
      period.disclosureScope !== value.disclosureScope ||
      period.sourceTime !== value.sourceTime ||
      period.fetchTime !== value.fetchTime)) invalidOutput()
    if (!period) {
      periods.set(reportPeriod, {
        reportDate: value.reportDate,
        periodType: value.periodType,
        disclosureScope: value.disclosureScope,
        sourceTime: value.sourceTime,
        fetchTime: value.fetchTime,
        metrics: new Set()
      })
    }
    periods.get(reportPeriod).metrics.add(value.metricKey)
    points.push({
      indicatorId: value.indicatorId,
      metricKey: value.metricKey,
      reportPeriod,
      periodEnd: value.reportDate,
      periodType: value.periodType,
      value: value.value,
      availability: value.availability,
      currency: value.currency,
      unit: value.unit,
      disclosureScope: value.disclosureScope,
      sourceTime: value.sourceTime,
      fetchTime: value.fetchTime
    })
  }
  const observedPeriods = [...periods.values()]
  if (periods.size !== 3 || observedPeriods.filter((period) =>
    period.periodType === 'annual').length !== 2 || observedPeriods.filter((period) =>
    period.periodType === 'interim').length !== 1 || observedPeriods.some((period) =>
    period.metrics.size !== FINANCIAL_METRIC_KEYS.size)) invalidOutput()
  return points
}

function terminalTimestamp(clock, reservation) {
  const observedAt = readTimestamp(clock)
  if (observedAt > reservation.leaseExpiresAt) {
    throw new SafeFailure('IFIND_MARKET_LEASE_EXPIRED', 'API', 'lease')
  }
  if (observedAt < reservation.createdAt) {
    throw new SafeFailure(
      'IFIND_MARKET_CLOCK_ROLLBACK', 'CONFIG', 'lease', null, 'clock-rollback'
    )
  }
  return observedAt
}

function createTerminalResult(reservation, clock, values) {
  const completedAt = terminalTimestamp(clock, reservation)
  let safeErrorClass = null
  if (values.failure) {
    safeErrorClass = REPOSITORY_SAFE_CLASSES.has(values.failure.safeErrorClass)
      ? values.failure.safeErrorClass
      : 'API'
  }
  return {
    status: values.status,
    quoteStatus: values.quoteStatus,
    financeStatus: values.financeStatus,
    requestCount: values.requestCount,
    dataVol: values.dataVol,
    elapsedMs: Math.max(0, completedAt - reservation.createdAt),
    safeErrorClass,
    failureCode: values.failure ? values.failure.failureCode : null,
    vendorErrorCode: values.failure ? values.failure.vendorErrorCode : null,
    completedAt
  }
}

function createIfindMarketDiagnosticService(options) {
  const config = exactDataObject(options, [
    'tokenVersionId', 'clock', 'idGenerator', 'catalogLookup',
    'manifestLookup', 'client', 'quoteParser', 'financialParser', 'repository',
    'secretProvider'
  ])
  if (!config || !VERSION_ID_PATTERN.test(config.tokenVersionId) ||
    typeof config.clock !== 'function' || typeof config.idGenerator !== 'function' ||
    typeof config.catalogLookup !== 'function' || typeof config.manifestLookup !== 'function' ||
    typeof config.quoteParser !== 'function' || typeof config.financialParser !== 'function') {
    failConfig()
  }

  const clientAuthenticate = methodReference(config.client, 'authenticate')
  const clientQuote = methodReference(config.client, 'quote')
  const clientFinancial = methodReference(config.client, 'financial')
  const clientClear = methodReference(config.client, 'clear')
  const repositoryReserve = methodReference(config.repository, 'reserve')
  const repositoryComplete = methodReference(config.repository, 'complete')
  const repositoryFail = methodReference(config.repository, 'fail')
  const repositoryLatest = methodReference(config.repository, 'latest')
  const repositoryHistory = methodReference(config.repository, 'history')
  const repositoryQuotaStatus = methodReference(config.repository, 'quotaStatus')
  const readRefreshToken = methodReference(config.secretProvider, 'readRefreshToken')

  function bestEffortFail(reservation, failure, requestCount, dataVol) {
    const persistedFailure = REPOSITORY_SAFE_CLASSES.has(failure.safeErrorClass)
      ? failure
      : new SafeFailure(failure.failureCode, 'API', failure.stage, failure.vendorErrorCode)
    if (failure.stage === 'lease') return failure
    let result
    try {
      result = createTerminalResult(reservation, config.clock, {
        status: 'failed',
        quoteStatus: 'not_run',
        financeStatus: 'not_run',
        requestCount,
        dataVol,
        failure: persistedFailure
      })
    } catch (error) {
      return error instanceof SafeFailure
        ? error
        : new SafeFailure('IFIND_MARKET_INTERNAL_FAILED', 'API', 'service')
    }
    try {
      validateSettlement(repositoryFail.call(config.repository, { reservation, result }))
    } catch {
      // Cleanup failure must not replace the originating safe failure.
    }
    return null
  }

  async function run(input) {
    const owner = {}
    let refreshToken = null
    let accessToken = null
    let quotePayload
    let financialPayload = null
    let financialFetchTime = null
    let reservation = null
    let requestCount = 0
    let dataVol = 0
    let hasDataVol = false
    function grantPermit(stage) {
      if (requestCount >= MAX_REQUEST_COUNT) throw budgetFailure(stage)
      requestCount += 1
    }
    try {
      const request = exactDataObject(input, ['caseId'])
      if (!request || typeof request.caseId !== 'string' ||
        !CASE_ID_PATTERN.test(request.caseId) ||
        !Object.hasOwn(FIXED_PARSER_IDS, request.caseId)) {
        throw new SafeFailure(
          'IFIND_MARKET_CASE_ID_INVALID', 'CONFIG', 'input', null, 'rejected'
        )
      }
      const caseId = request.caseId

      let catalogCase
      try {
        catalogCase = validateCatalogCase(caseId, config.catalogLookup(caseId))
      } catch (error) {
        if (error instanceof SafeFailure) throw error
        throw new SafeFailure(
          'IFIND_MARKET_CASE_UNVERIFIED', 'CONFIG', 'catalog', null, 'rejected'
        )
      }

      let manifestBundle
      try {
        manifestBundle = validateManifestBundle(
          caseId,
          catalogCase,
          config.manifestLookup(caseId)
        )
      } catch (error) {
        if (error instanceof SafeFailure) throw error
        throw new SafeFailure(
          'IFIND_MARKET_CASE_UNVERIFIED', 'CONFIG', 'catalog', null, 'rejected'
        )
      }
      const fixedRequests = buildFixedRequests(manifestBundle.manifest)
      if (CLIENT_OWNERS.has(config.client)) {
        throw new SafeFailure('IFIND_MARKET_LEASE_CONFLICT', 'BUSY', 'reserve', null, 'busy')
      }

      let createdAt
      let runId
      try {
        createdAt = readTimestamp(config.clock)
        runId = config.idGenerator()
        if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) failConfig()
      } catch {
        throw new SafeFailure('IFIND_MARKET_CONFIG_INVALID', 'API', 'configuration')
      }

      const reserveRequest = {
        runId,
        caseId,
        createdAt,
        tokenVersionId: config.tokenVersionId
      }
      let reserveResult
      try {
        reserveResult = config.repository && repositoryReserve.call(
          config.repository,
          reserveRequest
        )
      } catch {
        throw repositoryFailure()
      }
      const rejected = reservationRejection(reserveResult)
      if (rejected) throw rejected
      reservation = validateReservation(reserveRequest, reserveResult)
      CLIENT_OWNERS.set(config.client, owner)

      try {
        refreshToken = readRefreshToken.call(config.secretProvider)
        if (types.isProxy(refreshToken) || !Buffer.isBuffer(refreshToken) ||
          refreshToken.length < 1 || refreshToken.length > 4096) throw new Error('invalid')
      } catch {
        throw new SafeFailure(
          'IFIND_MARKET_SECRET_UNAVAILABLE', 'AUTH', 'provider'
        )
      }

      let authResult
      try {
        grantPermit('auth')
        const authOutput = await clientAuthenticate.call(
          config.client,
          refreshToken
        )
        accessToken = ownBufferReference(authOutput, 'accessToken')
        authResult = decodeAuthResult(authOutput)
        accessToken = authResult.accessToken
      } catch (error) {
        if (error instanceof SafeFailure) throw error
        throw readClientFailure(error, 'auth')
      }

      let quoteResult
      try {
        grantPermit('quote')
        quoteResult = decodeMarketResult(await clientQuote.call(
          config.client,
          accessToken,
          fixedRequests.quote
        ), 'quote')
        quotePayload = quoteResult.payload
        if (quoteResult.dataVol !== null) {
          dataVol += quoteResult.dataVol
          hasDataVol = true
        }
      } catch (error) {
        if (error instanceof SafeFailure) throw error
        throw readClientFailure(error, 'quote')
      }

      let financialFailure = null
      try {
        grantPermit('financial')
        const financialResult = decodeMarketResult(await clientFinancial.call(
          config.client,
          accessToken,
          fixedRequests.financial
        ), 'financial')
        financialPayload = financialResult.payload
        if (financialResult.dataVol !== null) {
          dataVol += financialResult.dataVol
          hasDataVol = true
        }
        financialFetchTime = new Date(terminalTimestamp(config.clock, reservation)).toISOString()
      } catch (error) {
        if (error instanceof SafeFailure) {
          financialFailure = error
        } else {
          financialFailure = readClientFailure(error, 'financial')
        }
      }

      const quoteSnapshot = parseQuote(
        config.quoteParser,
        caseId,
        catalogCase,
        quotePayload,
        manifestBundle
      )

      if (financialFailure && financialFailure.safeErrorClass === 'IDENTITY_CONFLICT') {
        throw financialFailure
      }

      let financialPoints = []
      if (!financialFailure) {
        try {
          financialPoints = parseFinancials(
            config.financialParser,
            caseId,
            catalogCase,
            financialPayload,
            manifestBundle.financialVerification,
            manifestBundle.financialReportingCurrencyEvidence,
            manifestBundle,
            financialFetchTime
          )
        } catch (error) {
          if (error instanceof SafeFailure &&
            error.safeErrorClass === 'IDENTITY_CONFLICT') throw error
          financialFailure = error instanceof SafeFailure
            ? error
            : new SafeFailure(
              'IFIND_MARKET_FINANCIAL_UNAVAILABLE',
              'RESPONSE_SHAPE',
              'financial-parser'
            )
        }
      }

      const status = financialFailure ? 'partial' : 'complete'
      const result = createTerminalResult(reservation, config.clock, {
        status,
        quoteStatus: 'available',
        financeStatus: financialFailure ? 'unavailable' : 'available',
        requestCount,
        dataVol: hasDataVol ? dataVol : null,
        failure: financialFailure
      })
      try {
        const settlement = repositoryComplete.call(config.repository, {
          reservation,
          result,
          quoteSnapshot,
          financialPoints: financialFailure ? [] : financialPoints
        })
        if (!validateSettlement(settlement) || settlement.status !== 'completed') {
          throw new Error('settlement conflict')
        }
      } catch {
        throw repositoryFailure()
      }

      if (financialFailure) {
        return {
          status: 'partial',
          caseId,
          runId: reservation.runId,
          quoteStatus: 'available',
          financeStatus: 'unavailable',
          requestCount: result.requestCount,
          failureCode: financialFailure.failureCode,
          safeErrorClass: financialFailure.safeErrorClass,
          stage: financialFailure.stage,
          vendorErrorCode: financialFailure.vendorErrorCode
        }
      }
      return {
        status: 'complete',
        caseId,
        runId: reservation.runId,
        quoteStatus: 'available',
        financeStatus: 'available',
        requestCount: result.requestCount
      }
    } catch (error) {
      const failure = error instanceof SafeFailure
        ? error
        : new SafeFailure('IFIND_MARKET_INTERNAL_FAILED', 'API', 'service')
      if (reservation) {
        const terminalFailure = bestEffortFail(
          reservation,
          failure,
          requestCount,
          hasDataVol ? dataVol : null
        )
        if (terminalFailure) return safeResult(terminalFailure)
      }
      return safeResult(failure)
    } finally {
      clearBuffer(refreshToken)
      clearBuffer(accessToken)
      // eslint-disable-next-line no-useless-assignment -- Release the provider payload reference before client cleanup.
      quotePayload = null
      // eslint-disable-next-line no-useless-assignment -- Keep explicit cleanup on every terminal path.
      financialPayload = null
      if (CLIENT_OWNERS.get(config.client) === owner) {
        try {
          clientClear.call(config.client)
        } catch {
          // Cleanup failure must not replace the originating safe result.
        } finally {
          CLIENT_OWNERS.delete(config.client)
        }
      }
    }
  }

  return Object.freeze({
    run,
    latest(input) {
      return repositoryLatest.call(config.repository, input)
    },
    history(input) {
      return repositoryHistory.call(config.repository, input)
    },
    quotaStatus(input) {
      return repositoryQuotaStatus.call(config.repository, input)
    }
  })
}

module.exports = {
  IfindMarketDiagnosticServiceError,
  createIfindMarketDiagnosticService
}

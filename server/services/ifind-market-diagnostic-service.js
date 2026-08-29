'use strict'

const { types, isDeepStrictEqual } = require('node:util')
const {
  validateLiveRequestManifestDefinition
} = require('../domain/ifind-market-manifest-validator')
const { isClientFailureMetadata } = require('../contracts/ifind-diagnostic-errors')

const MAX_REQUEST_COUNT = 5
const AUTH_REQUEST_BUDGET = 1
const QUOTE_REQUEST_BUDGET = 1
const MAX_FINANCIAL_REQUEST_BUDGET = 3
const RUN_ID_PATTERN = /^market_run_[a-f0-9]{24,64}$/
const VERSION_ID_PATTERN = /^v[0-9]{8}-[0-9]{3}$/
const CASE_ID_PATTERN = /^(?:HK|US|CN)_[A-Z][A-Z0-9]{0,31}_[A-Z0-9]{1,16}$/
const FAILURE_CODE_PATTERN = /^IFIND_[A-Z0-9_]{1,90}$/
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

function snapshotTree(value, state = { depth: 0, work: 0, active: new Set() }) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SafeFailure(
      'IFIND_MARKET_CLIENT_OUTPUT_INVALID', 'RESPONSE_SHAPE', 'client'
    )
    return value
  }
  if (typeof value !== 'object' || types.isProxy(value) || state.depth > 12 || state.work > 4096) {
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
  state.work += 1
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
        result.push(snapshotTree(descriptor.value, {
          depth: state.depth + 1,
          work: state.work,
          active: state.active
        }))
      }
      return Object.freeze(result)
    }
    if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid')
    const result = {}
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('invalid')
      result[key] = snapshotTree(descriptor.value, {
        depth: state.depth + 1,
        work: state.work,
        active: state.active
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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || Object.isFrozen(value)) {
    return value
  }
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function clearBuffer(value) {
  try {
    if (!types.isProxy(value) && Buffer.isBuffer(value)) value.fill(0)
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
  if (!bundle || !manifest) throw new SafeFailure(
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
    const manifestSnapshot = snapshotTree({ ...manifest })
    const listingId = ownDataValue(catalogCase, 'listingId').value
    return {
      manifest: manifestSnapshot,
      quoteVerification: validateVerification(bundle.quoteVerification),
      financialVerification: validateVerification(bundle.financialVerification),
      financialReportingCurrencyEvidence: validateCurrencyEvidence(
        bundle.financialReportingCurrencyEvidence,
        caseId,
        listingId
      )
    }
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
          fullFiscalYears: snapshotTree(
            vendorParameters.fullFiscalYears.requestParameters
          ),
          latestDisclosedInterim: snapshotTree(
            vendorParameters.latestDisclosedInterim.requestParameters
          )
        }
      })
    }
  } catch {
    throw new SafeFailure(
      'IFIND_MARKET_CASE_UNVERIFIED', 'CONFIG', 'catalog', null, 'rejected'
    )
  }
}

function validateReservation(caseId, value) {
  const result = exactDataObject(value, [
    'status', 'reservation', 'localDayKey', 'caseAttemptCount',
    'globalAttemptCount'
  ])
  const reservation = result && exactDataObject(result.reservation, [
    'runId', 'caseId', 'createdAt', 'tokenVersionId', 'leaseExpiresAt'
  ])
  if (!result || result.status !== 'reserved' || !reservation ||
    reservation.caseId !== caseId || !RUN_ID_PATTERN.test(reservation.runId) ||
    !VERSION_ID_PATTERN.test(reservation.tokenVersionId) ||
    !Number.isSafeInteger(reservation.createdAt) ||
    !Number.isSafeInteger(reservation.leaseExpiresAt) ||
    reservation.leaseExpiresAt <= reservation.createdAt) throw repositoryFailure()
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
  if (result && statuses.has(result.status) && Number.isSafeInteger(result.retryAt)) {
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

function readClientFailure(error, stage, budget) {
  const fallback = new SafeFailure('IFIND_CLIENT_FAILED', 'API', stage)
  try {
    if (!isObjectLike(error) || types.isProxy(error)) return { failure: fallback, requestCount: 1 }
    const read = (key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(error, key)
      return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
    }
    const requestCount = read('requestCount')
    if (!Number.isSafeInteger(requestCount) || requestCount < 0) {
      return { failure: fallback, requestCount: 1 }
    }
    if (requestCount > budget) {
      return { failure: budgetFailure(stage), requestCount: budget }
    }
    const metadata = {
      failureCode: read('failureCode'),
      errorClass: read('class'),
      stage: read('stage'),
      vendorErrorCode: read('vendorErrorCode')
    }
    if (!isClientFailureMetadata(metadata)) {
      return { failure: fallback, requestCount: Math.max(1, requestCount) }
    }
    return {
      failure: new SafeFailure(
        metadata.failureCode,
        metadata.errorClass,
        metadata.stage || stage,
        metadata.vendorErrorCode
      ),
      requestCount
    }
  } catch {
    return { failure: fallback, requestCount: 1 }
  }
}

function decodeAuthResult(value, budget) {
  const result = exactDataObject(value, ['accessToken', 'requestCount'])
  if (!result || !Number.isSafeInteger(result.requestCount) || result.requestCount < 1) {
    throw new SafeFailure(
      'IFIND_MARKET_CLIENT_OUTPUT_INVALID', 'RESPONSE_SHAPE', 'auth'
    )
  }
  if (result.requestCount > budget) throw budgetFailure('auth')
  if (types.isProxy(result.accessToken) || !Buffer.isBuffer(result.accessToken) ||
    result.accessToken.length < 1 || result.accessToken.length > 4096) {
    throw new SafeFailure(
      'IFIND_MARKET_CLIENT_OUTPUT_INVALID', 'RESPONSE_SHAPE', 'auth'
    )
  }
  return result
}

function decodeMarketResult(value, stage, budget) {
  const result = exactDataObject(value, ['payload', 'requestCount', 'dataVol'])
  if (!result || !Number.isSafeInteger(result.requestCount) || result.requestCount < 1 ||
    (result.dataVol !== null &&
      (!Number.isSafeInteger(result.dataVol) || result.dataVol < 0))) {
    throw new SafeFailure(
      'IFIND_MARKET_CLIENT_OUTPUT_INVALID', 'RESPONSE_SHAPE', stage
    )
  }
  if (result.requestCount > budget) {
    const failure = budgetFailure(stage)
    failure.observedRequestCount = result.requestCount
    throw failure
  }
  let payload
  try {
    payload = snapshotTree(result.payload)
  } catch {
    throw new SafeFailure(
      'IFIND_MARKET_CLIENT_OUTPUT_INVALID', 'RESPONSE_SHAPE', stage
    )
  }
  return { payload, requestCount: result.requestCount, dataVol: result.dataVol }
}

function parseQuote(quoteParser, caseId, catalogCase, payload, verification) {
  let parsed
  try {
    parsed = quoteParser({ caseId, payload, verification })
  } catch {
    throw new SafeFailure(
      'IFIND_MARKET_QUOTE_UNAVAILABLE', 'RESPONSE_SHAPE', 'quote-parser'
    )
  }
  const result = exactDataObject(parsed, QUOTE_RESULT_FIELDS)
  const listingId = ownDataValue(catalogCase, 'listingId').value
  const displayCode = ownDataValue(catalogCase, 'displayCode').value
  const currency = ownDataValue(catalogCase, 'expectedTradingCurrency').value
  if (!result || result.caseId !== caseId || result.listingId !== listingId ||
    result.displayCode !== displayCode || result.source !== 'real' ||
    result.currency !== currency || !Array.isArray(result.missingFields) ||
    result.missingFields.length !== 0 ||
    !['trading', 'halted', 'closed'].includes(result.tradingStatus) ||
    typeof result.quoteTime !== 'string' || !Number.isFinite(Date.parse(result.quoteTime))) {
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
  financialReportingCurrencyEvidence
) {
  let parsed
  try {
    parsed = financialParser({
      caseId,
      payload,
      verification,
      financialReportingCurrencyEvidence
    })
  } catch {
    throw new SafeFailure(
      'IFIND_MARKET_FINANCIAL_UNAVAILABLE', 'RESPONSE_SHAPE', 'financial-parser'
    )
  }
  const result = exactDataObject(parsed, FINANCIAL_RESULT_FIELDS)
  const listingId = ownDataValue(catalogCase, 'listingId').value
  const displayCode = ownDataValue(catalogCase, 'displayCode').value
  if (!result || result.caseId !== caseId || result.listingId !== listingId ||
    result.displayCode !== displayCode || result.source !== 'real' ||
    result.availability !== 'available' || !Array.isArray(result.points) ||
    result.points.length < 1 || result.points.length > 64 || types.isProxy(result.points)) {
    throw new SafeFailure(
      'IFIND_MARKET_FINANCIAL_UNAVAILABLE', 'RESPONSE_SHAPE', 'financial-parser'
    )
  }
  const points = []
  for (const point of result.points) {
    const value = exactDataObject(point, FINANCIAL_POINT_FIELDS)
    if (!value || typeof value.reportDate !== 'string') throw new SafeFailure(
      'IFIND_MARKET_FINANCIAL_UNAVAILABLE', 'RESPONSE_SHAPE', 'financial-parser'
    )
    points.push({
      indicatorId: value.indicatorId,
      metricKey: value.metricKey,
      reportPeriod: value.reportPeriod,
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
  return points
}

function terminalTimestamp(clock, reservation) {
  try {
    return Math.min(
      reservation.leaseExpiresAt,
      Math.max(reservation.createdAt, readTimestamp(clock))
    )
  } catch {
    return reservation.createdAt
  }
}

function createTerminalResult(reservation, clock, values) {
  const completedAt = terminalTimestamp(clock, reservation)
  return {
    status: values.status,
    quoteStatus: values.quoteStatus,
    financeStatus: values.financeStatus,
    requestCount: Math.min(MAX_REQUEST_COUNT, Math.max(0, values.requestCount)),
    dataVol: values.dataVol,
    elapsedMs: Math.max(0, completedAt - reservation.createdAt),
    safeErrorClass: values.failure ? values.failure.safeErrorClass : null,
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
  const readRefreshToken = methodReference(config.secretProvider, 'readRefreshToken')

  function bestEffortFail(reservation, failure, requestCount, dataVol) {
    const persistedFailure = REPOSITORY_SAFE_CLASSES.has(failure.safeErrorClass)
      ? failure
      : new SafeFailure(failure.failureCode, 'API', failure.stage, failure.vendorErrorCode)
    const result = createTerminalResult(reservation, config.clock, {
      status: 'failed',
      quoteStatus: 'not_run',
      financeStatus: 'not_run',
      requestCount,
      dataVol,
      failure: persistedFailure
    })
    try {
      validateSettlement(repositoryFail.call(config.repository, { reservation, result }))
    } catch {
      // Cleanup failure must not replace the originating safe failure.
    }
  }

  async function run(input) {
    let refreshToken = null
    let accessToken = null
    let quotePayload = null
    let financialPayload = null
    let reservation = null
    let requestCount = 0
    let dataVol = 0
    let hasDataVol = false
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

      let createdAt
      let runId
      try {
        createdAt = readTimestamp(config.clock)
        runId = config.idGenerator()
        if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) failConfig()
      } catch {
        throw new SafeFailure('IFIND_MARKET_CONFIG_INVALID', 'API', 'configuration')
      }

      let reserveResult
      try {
        reserveResult = config.repository && repositoryReserve.call(config.repository, {
          runId,
          caseId,
          createdAt,
          tokenVersionId: config.tokenVersionId
        })
      } catch {
        throw repositoryFailure()
      }
      const rejected = reservationRejection(reserveResult)
      if (rejected) throw rejected
      reservation = validateReservation(caseId, reserveResult)

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
        authResult = decodeAuthResult(await clientAuthenticate.call(
          config.client,
          Object.freeze({
            refreshToken,
            requestBudget: AUTH_REQUEST_BUDGET
          })
        ), AUTH_REQUEST_BUDGET)
        requestCount += authResult.requestCount
        accessToken = authResult.accessToken
      } catch (error) {
        if (error instanceof SafeFailure) {
          if (error.failureCode === 'IFIND_MARKET_REQUEST_BUDGET_EXHAUSTED') {
            requestCount = Math.min(MAX_REQUEST_COUNT, requestCount + AUTH_REQUEST_BUDGET)
          }
          throw error
        }
        const observed = readClientFailure(error, 'auth', AUTH_REQUEST_BUDGET)
        requestCount += observed.requestCount
        throw observed.failure
      }

      let quoteResult
      try {
        quoteResult = decodeMarketResult(await clientQuote.call(
          config.client,
          Object.freeze({
            accessToken,
            request: fixedRequests.quote,
            requestBudget: QUOTE_REQUEST_BUDGET
          })
        ), 'quote', QUOTE_REQUEST_BUDGET)
        requestCount += quoteResult.requestCount
        quotePayload = quoteResult.payload
        if (quoteResult.dataVol !== null) {
          dataVol += quoteResult.dataVol
          hasDataVol = true
        }
      } catch (error) {
        if (error instanceof SafeFailure) {
          requestCount = Math.min(MAX_REQUEST_COUNT, requestCount + QUOTE_REQUEST_BUDGET)
          throw error
        }
        const observed = readClientFailure(error, 'quote', QUOTE_REQUEST_BUDGET)
        requestCount += observed.requestCount
        throw observed.failure
      }

      let financialFailure = null
      const financialBudget = Math.min(
        MAX_FINANCIAL_REQUEST_BUDGET,
        MAX_REQUEST_COUNT - requestCount
      )
      try {
        if (financialBudget < 1) throw budgetFailure('financial')
        const financialResult = decodeMarketResult(await clientFinancial.call(
          config.client,
          Object.freeze({
            accessToken,
            request: fixedRequests.financial,
            requestBudget: financialBudget
          })
        ), 'financial', financialBudget)
        requestCount += financialResult.requestCount
        financialPayload = financialResult.payload
        if (financialResult.dataVol !== null) {
          dataVol += financialResult.dataVol
          hasDataVol = true
        }
      } catch (error) {
        if (error instanceof SafeFailure) {
          const observed = Number.isSafeInteger(error.observedRequestCount)
            ? error.observedRequestCount
            : 1
          requestCount = Math.min(MAX_REQUEST_COUNT, requestCount + observed)
          financialFailure = error
        } else {
          const observed = readClientFailure(error, 'financial', financialBudget)
          requestCount = Math.min(MAX_REQUEST_COUNT, requestCount + observed.requestCount)
          financialFailure = observed.failure
        }
      }

      const quoteSnapshot = parseQuote(
        config.quoteParser,
        caseId,
        catalogCase,
        quotePayload,
        manifestBundle.quoteVerification
      )

      let financialPoints = []
      if (!financialFailure) {
        try {
          financialPoints = parseFinancials(
            config.financialParser,
            caseId,
            catalogCase,
            financialPayload,
            manifestBundle.financialVerification,
            manifestBundle.financialReportingCurrencyEvidence
          )
        } catch (error) {
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
        bestEffortFail(
          reservation,
          failure,
          requestCount,
          hasDataVol ? dataVol : null
        )
      }
      return safeResult(failure)
    } finally {
      clearBuffer(refreshToken)
      clearBuffer(accessToken)
      quotePayload = null
      financialPayload = null
      try {
        clientClear.call(config.client)
      } catch {
        // Cleanup failure must not replace the originating safe result.
      }
    }
  }

  return Object.freeze({ run })
}

module.exports = {
  IfindMarketDiagnosticServiceError,
  createIfindMarketDiagnosticService
}

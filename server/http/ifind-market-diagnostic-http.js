'use strict'

const { types } = require('node:util')

const {
  HttpBoundaryError,
  parseStrictJsonBody
} = require('./auth-http')
const {
  canonicalIp,
  resolveClientIdentity
} = require('./trusted-client')
const { listIfindMarketCases } = require('../domain/ifind-market-cases')

const ADMIN_COOKIE = '__Host-kinvest-admin'
const COOKIE_HEADER_LIMIT = 4096
const JSON_BODY_LIMIT = 4096
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const VERSION_ID_PATTERN = /^v[0-9]{8}-[0-9]{3}$/
const RUN_ID_PATTERN = /^market_run_[a-f0-9]{24,64}$/
const FAILURE_CODE_PATTERN = /^IFIND_[A-Z0-9_]{1,90}$/
const CASE_ID_PATTERN = /^(?:HK|US|CN)_[A-Z][A-Z0-9]{0,31}_[A-Z0-9]{1,16}$/
const REPORT_PERIOD_PATTERN = /^20[0-9]{2}(?:Q[1-3]|H1|FY)$/
const CALENDAR_DATE_PATTERN = /^20[0-9]{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/
const ISO_TIMESTAMP_PATTERN = /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/
const FIXED_CASE_IDS = new Set([
  'HK_ALIBABA_9988',
  'US_APPLE_AAPL',
  'CN_MOUTAI_600519'
])
const METRIC_KEYS = new Set([
  'revenue',
  'grossProfit',
  'attributableNetProfit',
  'operatingCashFlow',
  'receivables',
  'inventory',
  'interestBearingDebt'
])
const SAFE_ERROR_CLASSES = new Set([
  'AUTH',
  'PERMISSION',
  'INDICATOR',
  'QUOTA',
  'NETWORK',
  'API',
  'RESPONSE_SHAPE',
  'IDENTITY_CONFLICT',
  'CURRENCY_MISMATCH',
  'UNIT_UNVERIFIED',
  'PERIOD_UNVERIFIED',
  'BUSY',
  'RATE_LIMITED',
  'CONFIG'
])
const RUN_STATUSES = new Set(['complete', 'partial', 'failed'])
const BLOCK_STATUSES = new Set([
  'busy',
  'cooldown',
  'case-daily-limit',
  'global-daily-limit',
  'rejected',
  'clock-rollback',
  'failed'
])
const DATA_STATUSES = new Set(['available', 'unavailable', 'not_run'])
const TRADING_STATUSES = new Set(['trading', 'halted', 'closed'])
const PERIOD_TYPES = new Set(['annual', 'interim'])
const AVAILABILITY = new Set(['available', 'missing'])
const DUPLICATE_SENSITIVE_HEADERS = Object.freeze([
  'cookie',
  'origin',
  'x-kinvest-csrf',
  'content-type',
  'content-length',
  'transfer-encoding',
  'x-real-ip',
  'x-forwarded-for'
])
const LOCAL_BOUNDARY_STATUS = new Map([
  ['ACCESS_CONTROL_DISABLED', 503],
  ['ADMIN_AUTH_REQUIRED', 401],
  ['ADMIN_CSRF_INVALID', 403],
  ['BODY_TOO_LARGE', 413],
  ['CLIENT_IDENTITY_INVALID', 400],
  ['COOKIE_INVALID', 400],
  ['HEADER_INVALID', 400],
  ['IFIND_MARKET_CASE_NOT_FOUND', 404],
  ['INTERNAL_ERROR', 500],
  ['JSON_INVALID', 400],
  ['JSON_REQUIRED', 415],
  ['NOT_FOUND', 404],
  ['ORIGIN_INVALID', 403],
  ['TRUSTED_CLIENT_REQUIRED', 403]
])
const LOCAL_BOUNDARY_ERRORS = new WeakSet()

function createBoundaryError(code, status) {
  const allowedStatus = LOCAL_BOUNDARY_STATUS.get(code)
  const safeCode = allowedStatus === status ? code : 'INTERNAL_ERROR'
  const safeStatus = allowedStatus === status ? status : 500
  const error = new HttpBoundaryError(safeCode, safeStatus)
  LOCAL_BOUNDARY_ERRORS.add(error)
  return error
}

function isLocalBoundaryError(value) {
  return LOCAL_BOUNDARY_ERRORS.has(value)
}

function boundaryError(code, status) {
  throw createBoundaryError(code, status)
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(body))
}

function appendCookie(res, value) {
  const current = res.getHeader('Set-Cookie')
  const values = current === undefined
    ? []
    : Array.isArray(current) ? current : [current]
  res.setHeader('Set-Cookie', [...values, value])
}

function clearAdminCookie(res) {
  appendCookie(
    res,
    `${ADMIN_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Strict`
  )
}

function refreshAdminCookie(res, token, authenticated, now) {
  const idle = ownDataValue(authenticated, 'idleExpiresAt')
  const absolute = ownDataValue(authenticated, 'absoluteExpiresAt')
  if (!isTimestamp(idle) || !isTimestamp(absolute)) {
    boundaryError('INTERNAL_ERROR', 500)
  }
  const maxAge = Math.max(1000, Math.min(idle, absolute) - now())
  appendCookie(
    res,
    `${ADMIN_COOKIE}=${token}; Path=/; Max-Age=${Math.max(1, Math.floor(maxAge / 1000))}; Secure; HttpOnly; SameSite=Strict`
  )
}

function rawHeaderCount(req, expectedName) {
  if (!Array.isArray(req.rawHeaders)) return 0
  let count = 0
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (String(req.rawHeaders[index]).toLowerCase() === expectedName) count += 1
  }
  return count
}

function assertNoDuplicateHeaders(req) {
  for (const name of DUPLICATE_SENSITIVE_HEADERS) {
    if (rawHeaderCount(req, name) > 1) boundaryError('HEADER_INVALID', 400)
  }
}

function parseCookies(req) {
  const header = req.headers.cookie
  if (header === undefined) return new Map()
  if (typeof header !== 'string' ||
    Buffer.byteLength(header, 'utf8') > COOKIE_HEADER_LIMIT) {
    boundaryError('COOKIE_INVALID', 400)
  }
  const cookies = new Map()
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const separator = trimmed.indexOf('=')
    if (separator < 1) boundaryError('COOKIE_INVALID', 400)
    const name = trimmed.slice(0, separator)
    const value = trimmed.slice(separator + 1)
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      value.length > 256 || cookies.has(name)) {
      boundaryError('COOKIE_INVALID', 400)
    }
    cookies.set(name, value)
  }
  return cookies
}

function rawAdminToken(req) {
  const token = parseCookies(req).get(ADMIN_COOKIE)
  if (token === undefined) boundaryError('ADMIN_AUTH_REQUIRED', 401)
  if (!TOKEN_PATTERN.test(token)) boundaryError('COOKIE_INVALID', 400)
  return token
}

function ownDataValue(value, key) {
  try {
    if (types.isProxy(value) || value === null || typeof value !== 'object' ||
      Array.isArray(value)) boundaryError('INTERNAL_ERROR', 500)
    const prototype = Reflect.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      boundaryError('INTERNAL_ERROR', 500)
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')) boundaryError('INTERNAL_ERROR', 500)
    return descriptor.value
  } catch (error) {
    if (isLocalBoundaryError(error)) throw error
    boundaryError('INTERNAL_ERROR', 500)
  }
}

function optionalOwnDataValue(value, key) {
  try {
    if (types.isProxy(value) || value === null || typeof value !== 'object' ||
      Array.isArray(value)) return { found: false, value: undefined }
    const prototype = Reflect.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      return { found: false, value: undefined }
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')) return { found: false, value: undefined }
    return { found: true, value: descriptor.value }
  } catch {
    return { found: false, value: undefined }
  }
}

function methodReference(value, name) {
  try {
    if (types.isProxy(value) || value === null ||
      (typeof value !== 'object' && typeof value !== 'function')) return null
    let owner = value
    for (let depth = 0; owner !== null && depth < 4; depth += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(owner, name)
      if (descriptor) {
        return Object.hasOwn(descriptor, 'value') &&
          typeof descriptor.value === 'function'
          ? descriptor.value
          : null
      }
      owner = Reflect.getPrototypeOf(owner)
    }
    return null
  } catch {
    return null
  }
}

function exactData(value, keys) {
  try {
    if (types.isProxy(value) || value === null || typeof value !== 'object' ||
      Array.isArray(value)) boundaryError('INTERNAL_ERROR', 500)
    const prototype = Reflect.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      boundaryError('INTERNAL_ERROR', 500)
    }
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
      boundaryError('INTERNAL_ERROR', 500)
    }
    const result = Object.create(null)
    for (const key of keys) result[key] = ownDataValue(value, key)
    return result
  } catch (error) {
    if (isLocalBoundaryError(error)) throw error
    boundaryError('INTERNAL_ERROR', 500)
  }
}

function exactArray(value, maximumLength) {
  try {
    if (types.isProxy(value) || !Array.isArray(value) ||
      Reflect.getPrototypeOf(value) !== Array.prototype ||
      !Number.isSafeInteger(value.length) || value.length < 0 ||
      value.length > maximumLength) boundaryError('INTERNAL_ERROR', 500)
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== value.length + 1 ||
      ownKeys.some((key) => key !== 'length' &&
        (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key) ||
          Number(key) >= value.length))) {
      boundaryError('INTERNAL_ERROR', 500)
    }
    const result = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')) boundaryError('INTERNAL_ERROR', 500)
      result.push(descriptor.value)
    }
    return result
  } catch (error) {
    if (isLocalBoundaryError(error)) throw error
    boundaryError('INTERNAL_ERROR', 500)
  }
}

function safeText(value, maximumLength, pattern) {
  return typeof value === 'string' && value.length >= 1 &&
    value.length <= maximumLength && (!pattern || pattern.test(value))
}

function isTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 &&
    value <= 8_640_000_000_000_000
}

function isCount(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum
}

function isFiniteNumber(value, { nonNegative = false } = {}) {
  return typeof value === 'number' && Number.isFinite(value) &&
    (!nonNegative || value >= 0)
}

function isIsoTimestamp(value) {
  return safeText(value, 40, ISO_TIMESTAMP_PATTERN) &&
    Number.isFinite(Date.parse(value))
}

function copyCatalogEntry(value) {
  const caseId = ownDataValue(value, 'caseId')
  const companyName = ownDataValue(value, 'companyName')
  const issuerLegalName = ownDataValue(value, 'issuerLegalName')
  const exchange = ownDataValue(value, 'exchange')
  const displayCode = ownDataValue(value, 'displayCode')
  const expectedTradingCurrency = ownDataValue(value, 'expectedTradingCurrency')
  const marketTimeZone = ownDataValue(value, 'marketTimeZone')
  const liveReady = ownDataValue(value, 'liveReady')
  const listingId = ownDataValue(value, 'listingId')
  if (!FIXED_CASE_IDS.has(caseId) || !CASE_ID_PATTERN.test(caseId) ||
    !safeText(companyName, 80) || !safeText(issuerLegalName, 160) ||
    !safeText(exchange, 16, /^[A-Z]+$/) ||
    !safeText(displayCode, 16, /^[A-Z0-9]+\.(?:HK|US|SH)$/) ||
    !safeText(expectedTradingCurrency, 3, /^[A-Z]{3}$/) ||
    !safeText(marketTimeZone, 64, /^[A-Za-z_]+\/[A-Za-z_]+$/) ||
    typeof liveReady !== 'boolean' ||
    !safeText(listingId, 64, /^listing-[a-z0-9-]+$/)) {
    boundaryError('INTERNAL_ERROR', 500)
  }
  return Object.freeze({
    listingId,
    presentation: Object.freeze({
      caseId,
      companyName,
      issuerLegalName,
      exchange,
      displayCode,
      expectedTradingCurrency,
      marketTimeZone,
      liveReady
    })
  })
}

const CATALOG = Object.freeze(
  exactArray(listIfindMarketCases(), 3).map(copyCatalogEntry)
)
if (CATALOG.length !== FIXED_CASE_IDS.size ||
  new Set(CATALOG.map((entry) => entry.presentation.caseId)).size !== CATALOG.length) {
  boundaryError('INTERNAL_ERROR', 500)
}
const CATALOG_BY_ID = new Map(
  CATALOG.map((entry) => [entry.presentation.caseId, entry])
)

function copyQuote(value, catalogEntry) {
  if (value === null) return null
  const dto = exactData(value, [
    'listingId', 'displayCode', 'latestPrice', 'previousClose', 'open', 'high',
    'low', 'volume', 'turnover', 'quoteTime', 'tradingStatus', 'currency'
  ])
  if (dto.listingId !== catalogEntry.listingId ||
    dto.displayCode !== catalogEntry.presentation.displayCode ||
    dto.currency !== catalogEntry.presentation.expectedTradingCurrency ||
    !TRADING_STATUSES.has(dto.tradingStatus) || !isIsoTimestamp(dto.quoteTime)) {
    boundaryError('INTERNAL_ERROR', 500)
  }
  for (const field of [
    'latestPrice', 'previousClose', 'open', 'high', 'low', 'volume', 'turnover'
  ]) {
    if (!isFiniteNumber(dto[field], { nonNegative: true })) {
      boundaryError('INTERNAL_ERROR', 500)
    }
  }
  return {
    displayCode: dto.displayCode,
    latestPrice: dto.latestPrice,
    previousClose: dto.previousClose,
    open: dto.open,
    high: dto.high,
    low: dto.low,
    volume: dto.volume,
    turnover: dto.turnover,
    quoteTime: dto.quoteTime,
    tradingStatus: dto.tradingStatus,
    currency: dto.currency
  }
}

function copyFinancialPoint(value, catalogEntry) {
  const dto = exactData(value, [
    'indicatorId', 'metricKey', 'reportPeriod', 'periodEnd', 'periodType',
    'value', 'availability', 'currency', 'unit', 'disclosureScope',
    'sourceTime', 'fetchTime'
  ])
  if (!safeText(dto.indicatorId, 128, /^[A-Z0-9_]+$/) ||
    !METRIC_KEYS.has(dto.metricKey) ||
    typeof dto.reportPeriod !== 'string' ||
    !REPORT_PERIOD_PATTERN.test(dto.reportPeriod) ||
    typeof dto.periodEnd !== 'string' ||
    !CALENDAR_DATE_PATTERN.test(dto.periodEnd) ||
    !PERIOD_TYPES.has(dto.periodType) || !AVAILABILITY.has(dto.availability) ||
    dto.currency !== catalogEntry.presentation.expectedTradingCurrency ||
    dto.unit !== 'million' ||
    !safeText(dto.disclosureScope, 32, /^[a-z][a-z_]*$/) ||
    !isIsoTimestamp(dto.sourceTime) || !isIsoTimestamp(dto.fetchTime) ||
    (dto.availability === 'missing' && dto.value !== null) ||
    (dto.availability === 'available' && !isFiniteNumber(dto.value))) {
    boundaryError('INTERNAL_ERROR', 500)
  }
  return {
    metricKey: dto.metricKey,
    reportPeriod: dto.reportPeriod,
    periodEnd: dto.periodEnd,
    periodType: dto.periodType,
    value: dto.value,
    availability: dto.availability,
    currency: dto.currency,
    unit: dto.unit,
    disclosureScope: dto.disclosureScope,
    sourceTime: dto.sourceTime,
    fetchTime: dto.fetchTime
  }
}

function copyRun(value, expectedCaseId) {
  if (value === null) return null
  const dto = exactData(value, [
    'runId', 'caseId', 'status', 'quoteStatus', 'financeStatus', 'requestCount',
    'dataVol', 'elapsedMs', 'safeErrorClass', 'failureCode', 'vendorErrorCode',
    'tokenVersionId', 'createdAt', 'leaseExpiresAt', 'completedAt',
    'quoteSnapshot', 'financialPoints'
  ])
  const catalogEntry = CATALOG_BY_ID.get(expectedCaseId)
  if (!catalogEntry || dto.caseId !== expectedCaseId ||
    typeof dto.runId !== 'string' || !RUN_ID_PATTERN.test(dto.runId) ||
    !RUN_STATUSES.has(dto.status) ||
    !DATA_STATUSES.has(dto.quoteStatus) || !DATA_STATUSES.has(dto.financeStatus) ||
    !isCount(dto.requestCount, 5) ||
    (dto.dataVol !== null && !isCount(dto.dataVol)) || !isCount(dto.elapsedMs) ||
    (dto.safeErrorClass !== null && !SAFE_ERROR_CLASSES.has(dto.safeErrorClass)) ||
    (dto.failureCode !== null &&
      (typeof dto.failureCode !== 'string' || !FAILURE_CODE_PATTERN.test(dto.failureCode))) ||
    (dto.vendorErrorCode !== null && !safeText(dto.vendorErrorCode, 128)) ||
    typeof dto.tokenVersionId !== 'string' ||
    !VERSION_ID_PATTERN.test(dto.tokenVersionId) || !isTimestamp(dto.createdAt) ||
    !isTimestamp(dto.leaseExpiresAt) || !isTimestamp(dto.completedAt) ||
    dto.createdAt > dto.completedAt || dto.completedAt > dto.leaseExpiresAt) {
    boundaryError('INTERNAL_ERROR', 500)
  }
  const complete = dto.status === 'complete' && dto.quoteStatus === 'available' &&
    dto.financeStatus === 'available' && dto.safeErrorClass === null &&
    dto.failureCode === null && dto.vendorErrorCode === null
  const partial = dto.status === 'partial' && dto.safeErrorClass !== null &&
    ((dto.quoteStatus === 'available' && dto.financeStatus === 'unavailable') ||
      (dto.quoteStatus === 'unavailable' && dto.financeStatus === 'available'))
  const failed = dto.status === 'failed' && dto.quoteStatus !== 'available' &&
    dto.financeStatus !== 'available' && dto.safeErrorClass !== null &&
    dto.failureCode !== null
  if (!complete && !partial && !failed) boundaryError('INTERNAL_ERROR', 500)

  const quote = copyQuote(dto.quoteSnapshot, catalogEntry)
  const financial = exactArray(dto.financialPoints, 64)
    .map((point) => copyFinancialPoint(point, catalogEntry))
  if ((dto.quoteStatus === 'available') !== (quote !== null) ||
    ((dto.financeStatus === 'available') !== (financial.length > 0))) {
    boundaryError('INTERNAL_ERROR', 500)
  }
  return {
    status: dto.status,
    quoteStatus: dto.quoteStatus,
    financeStatus: dto.financeStatus,
    requestCount: dto.requestCount,
    dataVol: dto.dataVol,
    elapsedMs: dto.elapsedMs,
    safeErrorClass: dto.safeErrorClass,
    createdAt: dto.createdAt,
    completedAt: dto.completedAt,
    quote,
    financial
  }
}

function unavailableQuota() {
  return {
    officialStatus: 'unavailable',
    localStatus: 'unavailable',
    localDayKey: null,
    caseAttemptCount: null,
    globalAttemptCount: null,
    caseRemaining: null,
    globalRemaining: null,
    cooldownUntil: null,
    inFlight: false,
    inFlightExpiresAt: null
  }
}

function copyQuota(value) {
  const dto = exactData(value, [
    'localDayKey', 'caseAttemptCount', 'globalAttemptCount', 'caseRemaining',
    'globalRemaining', 'cooldownUntil', 'inFlight', 'inFlightCaseId',
    'inFlightExpiresAt'
  ])
  if (typeof dto.localDayKey !== 'string' ||
    !CALENDAR_DATE_PATTERN.test(dto.localDayKey) ||
    !isCount(dto.caseAttemptCount, 5) || !isCount(dto.globalAttemptCount, 12) ||
    !isCount(dto.caseRemaining, 5) || !isCount(dto.globalRemaining, 12) ||
    dto.caseAttemptCount + dto.caseRemaining !== 5 ||
    dto.globalAttemptCount + dto.globalRemaining !== 12 ||
    (dto.cooldownUntil !== null && !isTimestamp(dto.cooldownUntil)) ||
    typeof dto.inFlight !== 'boolean' ||
    (dto.inFlightCaseId !== null && !FIXED_CASE_IDS.has(dto.inFlightCaseId)) ||
    (dto.inFlightExpiresAt !== null && !isTimestamp(dto.inFlightExpiresAt)) ||
    (dto.inFlight && (dto.inFlightCaseId === null || dto.inFlightExpiresAt === null)) ||
    (!dto.inFlight &&
      (dto.inFlightCaseId !== null || dto.inFlightExpiresAt !== null))) {
    boundaryError('INTERNAL_ERROR', 500)
  }
  return {
    officialStatus: 'unavailable',
    localStatus: 'available',
    localDayKey: dto.localDayKey,
    caseAttemptCount: dto.caseAttemptCount,
    globalAttemptCount: dto.globalAttemptCount,
    caseRemaining: dto.caseRemaining,
    globalRemaining: dto.globalRemaining,
    cooldownUntil: dto.cooldownUntil,
    inFlight: dto.inFlight,
    inFlightExpiresAt: dto.inFlightExpiresAt
  }
}

function runtimeAccess(runtime) {
  const statusProperty = optionalOwnDataValue(runtime, 'status')
  if (!statusProperty.found) {
    return { status: 'disabled', service: null, run: null, reader: null }
  }
  const modeProperty = optionalOwnDataValue(statusProperty.value, 'mode')
  const configuredProperty = optionalOwnDataValue(statusProperty.value, 'configured')
  const versionProperty = optionalOwnDataValue(statusProperty.value, 'versionId')
  if (!modeProperty.found || modeProperty.value === 'disabled') {
    return { status: 'disabled', service: null, run: null, reader: null }
  }
  if (modeProperty.value !== 'admin-diagnostic' ||
    !configuredProperty.found || configuredProperty.value !== true ||
    !versionProperty.found ||
    typeof versionProperty.value !== 'string' ||
    !VERSION_ID_PATTERN.test(versionProperty.value)) {
    return { status: 'unavailable', service: null, run: null, reader: null }
  }
  const serviceProperty = optionalOwnDataValue(runtime, 'marketService')
  if (!serviceProperty.found || types.isProxy(serviceProperty.value) ||
    serviceProperty.value === null || typeof serviceProperty.value !== 'object') {
    return { status: 'unavailable', service: null, run: null, reader: null }
  }
  const runProperty = optionalOwnDataValue(serviceProperty.value, 'run')
  const latestProperty = optionalOwnDataValue(serviceProperty.value, 'latest')
  const historyProperty = optionalOwnDataValue(serviceProperty.value, 'history')
  const quotaProperty = optionalOwnDataValue(serviceProperty.value, 'quotaStatus')
  const run = runProperty.found && typeof runProperty.value === 'function'
    ? runProperty.value : null
  const reader = latestProperty.found && typeof latestProperty.value === 'function' &&
    historyProperty.found && typeof historyProperty.value === 'function' &&
    quotaProperty.found && typeof quotaProperty.value === 'function'
    ? {
        latest: latestProperty.value,
        history: historyProperty.value,
        quotaStatus: quotaProperty.value
      }
    : null
  if (!run || !reader) {
    return { status: 'unavailable', service: null, run: null, reader: null }
  }
  return {
    status: 'available',
    service: serviceProperty.value,
    run,
    reader
  }
}

function safeError(error) {
  return isLocalBoundaryError(error)
    ? error
    : createBoundaryError('INTERNAL_ERROR', 500)
}

function createIfindMarketDiagnosticHttpController({
  accessRuntime,
  ifindDiagnosticRuntime,
  now = Date.now,
  publicOrigin = 'https://dearmina.cn',
  trustedProxyAddresses = []
}) {
  const enabled = accessRuntime && accessRuntime.status &&
    accessRuntime.status.mode === 'device-approval'
  const admin = enabled ? accessRuntime.adminAuth : null
  const trustedDirectAddresses = new Set(trustedProxyAddresses.map(canonicalIp))

  function requireEnabled() {
    if (!enabled || !admin) boundaryError('ACCESS_CONTROL_DISABLED', 503)
  }

  function adminMethod(name) {
    const method = methodReference(admin, name)
    if (!method) {
      boundaryError('ADMIN_AUTH_REQUIRED', 401)
    }
    return method
  }

  function authenticateAdmin(req, res) {
    requireEnabled()
    const token = rawAdminToken(req)
    const authenticate = adminMethod('authenticate')
    let authenticated
    try {
      authenticated = authenticate.call(admin, token)
    } catch {
      boundaryError('ADMIN_AUTH_REQUIRED', 401)
    }
    refreshAdminCookie(res, token, authenticated, now)
  }

  function authenticateMutation(req, res) {
    requireEnabled()
    const token = rawAdminToken(req)
    const csrf = req.headers['x-kinvest-csrf']
    if (typeof csrf !== 'string' || !TOKEN_PATTERN.test(csrf)) {
      boundaryError('ADMIN_CSRF_INVALID', 403)
    }
    const authenticate = adminMethod('authenticateMutation')
    let authenticated
    try {
      authenticated = authenticate.call(admin, token, csrf)
    } catch {
      boundaryError('ADMIN_AUTH_REQUIRED', 401)
    }
    const status = ownDataValue(authenticated, 'status')
    if (status === 'csrf-invalid') boundaryError('ADMIN_CSRF_INVALID', 403)
    if (status === 'session-invalid' || status === 'session-expired') {
      boundaryError('ADMIN_AUTH_REQUIRED', 401)
    }
    if (status !== 'authenticated') boundaryError('ADMIN_AUTH_REQUIRED', 401)
    refreshAdminCookie(res, token, exactData(authenticated, [
      'status', 'sessionId', 'idleExpiresAt', 'absoluteExpiresAt'
    ]), now)
  }

  function requireOrigin(req) {
    if (req.headers.origin !== publicOrigin) boundaryError('ORIGIN_INVALID', 403)
  }

  function requireExactTarget(req, expectedPath) {
    if (typeof req.url !== 'string' || req.url !== expectedPath) {
      boundaryError('NOT_FOUND', 404)
    }
  }

  function requireTrustedClient(req) {
    let directAddress
    try {
      directAddress = canonicalIp(req && req.socket && req.socket.remoteAddress)
    } catch {
      boundaryError('CLIENT_IDENTITY_INVALID', 400)
    }
    if (!trustedDirectAddresses.has(directAddress)) {
      boundaryError('TRUSTED_CLIENT_REQUIRED', 403)
    }
    try {
      resolveClientIdentity(req, { trustedProxyAddresses })
    } catch {
      boundaryError('CLIENT_IDENTITY_INVALID', 400)
    }
  }

  async function parseLocalStrictJson(req) {
    const type = req.headers['content-type']
    if (typeof type !== 'string' ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) {
      boundaryError('JSON_REQUIRED', 415)
    }
    const declared = req.headers['content-length']
    if (declared !== undefined &&
      (typeof declared !== 'string' || !/^\d+$/.test(declared) ||
        Number(declared) > JSON_BODY_LIMIT)) {
      boundaryError('BODY_TOO_LARGE', 413)
    }
    let receivedBytes = 0
    const countBytes = (chunk) => {
      const size = Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk)
        ? chunk.byteLength
        : typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : JSON_BODY_LIMIT + 1
      receivedBytes = Math.min(JSON_BODY_LIMIT + 1, receivedBytes + size)
    }
    req.prependListener('data', countBytes)
    try {
      return await parseStrictJsonBody(req, { allowEmpty: false })
    } catch {
      if (receivedBytes > JSON_BODY_LIMIT) boundaryError('BODY_TOO_LARGE', 413)
      boundaryError('JSON_INVALID', 400)
    } finally {
      req.removeListener('data', countBytes)
    }
  }

  function requireExactEmptyObject(value) {
    try {
      if (types.isProxy(value) || value === null || typeof value !== 'object' ||
        Array.isArray(value) || Reflect.getPrototypeOf(value) !== Object.prototype) {
        boundaryError('JSON_INVALID', 400)
      }
      if (Reflect.ownKeys(value).length !== 0) boundaryError('JSON_INVALID', 400)
    } catch (error) {
      if (isLocalBoundaryError(error)) throw error
      boundaryError('JSON_INVALID', 400)
    }
  }

  function requireCase(caseId) {
    const entry = CATALOG_BY_ID.get(caseId)
    if (!entry) boundaryError('IFIND_MARKET_CASE_NOT_FOUND', 404)
    return entry
  }

  function readLatest(access, caseId) {
    if (!access.reader) return null
    return copyRun(access.reader.latest.call(access.service, { caseId }), caseId)
  }

  function readHistory(access, caseId) {
    if (!access.reader) return []
    const values = access.reader.history.call(access.service, { caseId, limit: 10 })
    return exactArray(values, 10).map((value) => copyRun(value, caseId))
  }

  function readQuota(access, caseId) {
    if (!access.reader) return unavailableQuota()
    return copyQuota(access.reader.quotaStatus.call(access.service, {
      caseId,
      now: now()
    }))
  }

  function readCase(access, catalogEntry, includeHistory) {
    const caseId = catalogEntry.presentation.caseId
    return {
      case: catalogEntry.presentation,
      latest: readLatest(access, caseId),
      ...(includeHistory ? { history: readHistory(access, caseId) } : {}),
      quota: readQuota(access, caseId)
    }
  }

  function copyOutcome(value, expectedCaseId) {
    const statusProperty = optionalOwnDataValue(value, 'status')
    if (!statusProperty.found) boundaryError('INTERNAL_ERROR', 500)
    if (statusProperty.value === 'complete') {
      const dto = exactData(value, [
        'status', 'caseId', 'runId', 'quoteStatus', 'financeStatus', 'requestCount'
      ])
      if (dto.caseId !== expectedCaseId || typeof dto.runId !== 'string' ||
        !RUN_ID_PATTERN.test(dto.runId) ||
        dto.quoteStatus !== 'available' || dto.financeStatus !== 'available' ||
        !isCount(dto.requestCount, 5) || dto.requestCount < 1) {
        boundaryError('INTERNAL_ERROR', 500)
      }
      return { status: 'complete', safeErrorClass: null }
    }
    if (statusProperty.value === 'partial') {
      const dto = exactData(value, [
        'status', 'caseId', 'runId', 'quoteStatus', 'financeStatus', 'requestCount',
        'failureCode', 'safeErrorClass', 'stage', 'vendorErrorCode'
      ])
      if (dto.caseId !== expectedCaseId || typeof dto.runId !== 'string' ||
        !RUN_ID_PATTERN.test(dto.runId) ||
        dto.quoteStatus !== 'available' || dto.financeStatus !== 'unavailable' ||
        !isCount(dto.requestCount, 5) || dto.requestCount < 1 ||
        typeof dto.failureCode !== 'string' ||
        !FAILURE_CODE_PATTERN.test(dto.failureCode) ||
        !SAFE_ERROR_CLASSES.has(dto.safeErrorClass) ||
        !safeText(dto.stage, 32, /^[a-z][a-z-]*$/) ||
        (dto.vendorErrorCode !== null && !safeText(dto.vendorErrorCode, 128))) {
        boundaryError('INTERNAL_ERROR', 500)
      }
      return { status: 'partial', safeErrorClass: dto.safeErrorClass }
    }
    if (!BLOCK_STATUSES.has(statusProperty.value)) {
      boundaryError('INTERNAL_ERROR', 500)
    }
    const dto = exactData(value, [
      'status', 'failureCode', 'safeErrorClass', 'stage', 'vendorErrorCode'
    ])
    if (typeof dto.failureCode !== 'string' ||
      !FAILURE_CODE_PATTERN.test(dto.failureCode) ||
      !SAFE_ERROR_CLASSES.has(dto.safeErrorClass) ||
      !safeText(dto.stage, 32, /^[a-z][a-z-]*$/) ||
      (dto.vendorErrorCode !== null && !safeText(dto.vendorErrorCode, 128))) {
      boundaryError('INTERNAL_ERROR', 500)
    }
    return {
      status: dto.status,
      safeErrorClass: dto.safeErrorClass,
      failureCode: dto.failureCode
    }
  }

  function sendOutcome(res, outcome, access, catalogEntry) {
    const mappings = {
      busy: [409, 'IFIND_MARKET_DIAGNOSTIC_BUSY'],
      cooldown: [429, 'IFIND_MARKET_DIAGNOSTIC_COOLDOWN'],
      'case-daily-limit': [429, 'IFIND_MARKET_CASE_DAILY_LIMIT'],
      'global-daily-limit': [429, 'IFIND_MARKET_GLOBAL_DAILY_LIMIT'],
      'clock-rollback': [409, 'IFIND_MARKET_DIAGNOSTIC_UNAVAILABLE']
    }
    if (outcome.status === 'rejected') {
      const error = outcome.failureCode === 'IFIND_MARKET_CASE_UNVERIFIED'
        ? 'IFIND_MARKET_CASE_UNAVAILABLE'
        : 'IFIND_MARKET_DIAGNOSTIC_UNAVAILABLE'
      sendJson(res, { error }, 503)
      return
    }
    if (mappings[outcome.status]) {
      const [status, error] = mappings[outcome.status]
      sendJson(res, { error }, status)
      return
    }
    sendJson(res, {
      data: {
        status: outcome.status,
        safeErrorClass: outcome.safeErrorClass,
        case: readCase(access, catalogEntry, true)
      }
    })
  }

  async function route(req, res, segments) {
    if (segments[1] !== 'admin' || segments[2] !== 'ifind' ||
      segments[3] !== 'market-cases') return false

    assertNoDuplicateHeaders(req)

    if (segments.length === 4 && req.method === 'GET') {
      if (req.headers.origin !== undefined) requireOrigin(req)
      authenticateAdmin(req, res)
      requireExactTarget(req, '/api/admin/ifind/market-cases')
      const access = runtimeAccess(ifindDiagnosticRuntime)
      sendJson(res, {
        data: {
          runtimeStatus: access.status,
          cases: CATALOG.map((entry) => readCase(access, entry, false))
        }
      })
      return true
    }

    if (segments.length === 5 && req.method === 'GET') {
      if (req.headers.origin !== undefined) requireOrigin(req)
      authenticateAdmin(req, res)
      requireExactTarget(
        req,
        `/api/admin/ifind/market-cases/${segments[4]}`
      )
      const catalogEntry = requireCase(segments[4])
      const access = runtimeAccess(ifindDiagnosticRuntime)
      sendJson(res, {
        data: {
          runtimeStatus: access.status,
          ...readCase(access, catalogEntry, true)
        }
      })
      return true
    }

    if (segments.length === 6 && segments[5] === 'run' &&
      req.method === 'POST') {
      requireOrigin(req)
      authenticateMutation(req, res)
      requireTrustedClient(req)
      requireExactTarget(
        req,
        `/api/admin/ifind/market-cases/${segments[4]}/run`
      )
      const catalogEntry = requireCase(segments[4])
      const body = await parseLocalStrictJson(req)
      requireExactEmptyObject(body)
      const access = runtimeAccess(ifindDiagnosticRuntime)
      if (!access.run) {
        const error = access.status === 'disabled'
          ? 'IFIND_MARKET_DIAGNOSTIC_DISABLED'
          : 'IFIND_MARKET_DIAGNOSTIC_UNAVAILABLE'
        sendJson(res, { error }, 503)
        return true
      }
      const outcome = copyOutcome(
        await access.run.call(access.service, { caseId: catalogEntry.presentation.caseId }),
        catalogEntry.presentation.caseId
      )
      sendOutcome(res, outcome, access, catalogEntry)
      return true
    }

    sendJson(res, { error: 'NOT_FOUND' }, 404)
    return true
  }

  return Object.freeze({
    async handle(req, res, segments) {
      try {
        return await route(req, res, segments)
      } catch (error) {
        const safe = safeError(error)
        if (safe.code === 'COOKIE_INVALID' ||
          safe.code === 'ADMIN_AUTH_REQUIRED') clearAdminCookie(res)
        sendJson(res, { error: safe.code }, safe.status)
        return true
      }
    }
  })
}

module.exports = {
  createIfindMarketDiagnosticHttpController
}

'use strict'

const { DatabaseSync } = require('node:sqlite')
const { types } = require('node:util')
const {
  DeviceAuthDatabaseIdentityError,
  KINVEST_SQLITE_APPLICATION_ID,
  hasStrictLegacyDeviceSchema,
  readApplicationId,
  setKinvestApplicationId
} = require('./database-identity')
const { listIfindMarketCases } = require('../domain/ifind-market-cases')

const IFIND_MARKET_CASE_COOLDOWN_MS = 5 * 60_000
const IFIND_MARKET_CASE_DAILY_LIMIT = 5
const IFIND_MARKET_GLOBAL_DAILY_LIMIT = 12
const IFIND_MARKET_DIAGNOSTIC_LEASE_MS = 30_000
const IFIND_MARKET_HISTORY_LIMIT = 50
const SHANGHAI_DAY_MS = 24 * 60 * 60_000
const IFIND_MARKET_MIN_DERIVED_TIMESTAMP = Date.parse('1999-12-31T00:00:00.000Z')
const IFIND_MARKET_MIN_CREATED_AT = Date.parse('2000-01-01T00:00:00.000Z')
const IFIND_MARKET_MAX_DERIVED_TIMESTAMP =
  Date.parse('2100-01-02T00:00:00.000Z') - 1
const IFIND_MARKET_MAX_CREATED_AT = IFIND_MARKET_MAX_DERIVED_TIMESTAMP -
  SHANGHAI_DAY_MS - IFIND_MARKET_CASE_COOLDOWN_MS -
  IFIND_MARKET_DIAGNOSTIC_LEASE_MS

const CATALOG_CASES = listIfindMarketCases()
const CASES = Object.freeze(Object.fromEntries(CATALOG_CASES.map((marketCase) => [
  marketCase.caseId,
  Object.freeze({
    listingId: marketCase.listingId,
    displayCode: marketCase.displayCode,
    expectedTradingCurrency: marketCase.expectedTradingCurrency
  })
])))
const CASE_IDS = new Set(Object.keys(CASES))
const METRIC_KEYS = Object.freeze(
  CATALOG_CASES[0].indicators.financial.map((indicator) => indicator.metric)
)
for (const marketCase of CATALOG_CASES) {
  const metrics = marketCase.indicators.financial.map((indicator) => indicator.metric)
  if (JSON.stringify(metrics) !== JSON.stringify(METRIC_KEYS)) {
    throw new Error('Fixed iFinD market cases have inconsistent financial metrics')
  }
}
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
  'PERIOD_UNVERIFIED'
])
const DATA_STATUSES = new Set(['available', 'unavailable', 'not_run'])
const TRADING_STATUSES = new Set(['trading', 'halted', 'closed'])
const PERIOD_TYPES = new Set(['annual', 'interim'])
const RUN_ID_PATTERN = /^market_run_[a-f0-9]{24,64}$/
const VERSION_ID_PATTERN = /^v[0-9]{8}-[0-9]{3}$/
const FAILURE_CODE_PATTERN = /^IFIND_[A-Z0-9_]{1,90}$/
const INDICATOR_ID_PATTERN = /^[A-Z0-9_]{1,80}$/
const REPORT_PERIOD_PATTERN = /^20[0-9]{2}(?:Q[1-3]|H1|FY)$/
const CALENDAR_DATE_PATTERN = /^(20[0-9]{2})-([0-9]{2})-([0-9]{2})$/
const ISO_TIMESTAMP_PATTERN = /^(20[0-9]{2})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{3}))?(Z|([+-])([0-9]{2}):([0-9]{2}))$/

function sqlList(values) {
  return values.map((value) => `'${String(value).replaceAll("'", "''")}'`).join(', ')
}

const CASE_ID_SQL = sqlList(Object.keys(CASES))
const TRADING_CURRENCY_SQL = sqlList([
  ...new Set(Object.values(CASES).map((identity) =>
    identity.expectedTradingCurrency))
])
const METRIC_KEY_SQL = sqlList(METRIC_KEYS)

const RECOGNIZED_KINVEST_TABLES = new Set([
  'admin_sessions',
  'auth_rate_limits',
  'admin_auth_audit',
  'refresh_counters',
  'manual_refresh_events',
  'device_auth_requests',
  'device_credentials',
  'device_auth_audit',
  'device_request_rate_limits',
  'ifind_diagnostic_runs',
  'ifind_diagnostic_control',
  'ifind_market_case_runs',
  'ifind_market_quote_snapshots',
  'ifind_market_financial_points'
])
const RECOGNIZED_KINVEST_INDEXES = new Set([
  'idx_device_credentials_hmac_version',
  'idx_device_credentials_device',
  'ifind_market_case_runs_one_pending',
  'ifind_market_case_runs_case_created',
  'ifind_market_case_runs_created'
])

const RUN_COLUMNS = [
  ['run_id', 'TEXT', 1, 1],
  ['case_id', 'TEXT', 1, 0],
  ['status', 'TEXT', 1, 0],
  ['quote_status', 'TEXT', 1, 0],
  ['finance_status', 'TEXT', 1, 0],
  ['request_count', 'INTEGER', 0, 0],
  ['data_vol', 'INTEGER', 0, 0],
  ['elapsed_ms', 'INTEGER', 0, 0],
  ['safe_error_class', 'TEXT', 0, 0],
  ['failure_code', 'TEXT', 0, 0],
  ['vendor_error_code', 'INTEGER', 0, 0],
  ['token_version_id', 'TEXT', 1, 0],
  ['created_at', 'INTEGER', 1, 0],
  ['lease_expires_at', 'INTEGER', 1, 0],
  ['completed_at', 'INTEGER', 0, 0]
]
const QUOTE_COLUMNS = [
  ['run_id', 'TEXT', 1, 1],
  ['listing_id', 'TEXT', 1, 0],
  ['display_code', 'TEXT', 1, 0],
  ['latest_price', 'REAL', 1, 0],
  ['previous_close', 'REAL', 1, 0],
  ['open_price', 'REAL', 1, 0],
  ['high_price', 'REAL', 1, 0],
  ['low_price', 'REAL', 1, 0],
  ['volume', 'REAL', 1, 0],
  ['turnover', 'REAL', 1, 0],
  ['quote_time', 'TEXT', 1, 0],
  ['trading_status', 'TEXT', 1, 0],
  ['currency', 'TEXT', 1, 0]
]
const FINANCIAL_COLUMNS = [
  ['run_id', 'TEXT', 1, 1],
  ['indicator_id', 'TEXT', 1, 2],
  ['metric_key', 'TEXT', 1, 0],
  ['report_period', 'TEXT', 1, 0],
  ['period_end', 'TEXT', 1, 3],
  ['period_type', 'TEXT', 1, 4],
  ['value', 'REAL', 0, 0],
  ['availability', 'TEXT', 1, 0],
  ['currency', 'TEXT', 1, 0],
  ['unit', 'TEXT', 1, 0],
  ['disclosure_scope', 'TEXT', 1, 0],
  ['source_time', 'TEXT', 1, 0],
  ['fetch_time', 'TEXT', 1, 0]
]

const RUN_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS ifind_market_case_runs (
    run_id TEXT PRIMARY KEY NOT NULL,
    case_id TEXT NOT NULL CHECK (case_id IN (${CASE_ID_SQL})),
    status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'partial', 'failed')),
    quote_status TEXT NOT NULL CHECK (quote_status IN ('pending', 'available', 'unavailable', 'not_run')),
    finance_status TEXT NOT NULL CHECK (finance_status IN ('pending', 'available', 'unavailable', 'not_run')),
    request_count INTEGER CHECK (request_count IS NULL OR request_count BETWEEN 0 AND 5),
    data_vol INTEGER CHECK (data_vol IS NULL OR data_vol >= 0),
    elapsed_ms INTEGER CHECK (elapsed_ms IS NULL OR elapsed_ms >= 0),
    safe_error_class TEXT CHECK (safe_error_class IS NULL OR safe_error_class IN (
      'AUTH', 'PERMISSION', 'INDICATOR', 'QUOTA', 'NETWORK', 'API',
      'RESPONSE_SHAPE', 'IDENTITY_CONFLICT', 'CURRENCY_MISMATCH',
      'UNIT_UNVERIFIED', 'PERIOD_UNVERIFIED'
    )),
    failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 96),
    vendor_error_code INTEGER,
    token_version_id TEXT NOT NULL CHECK (length(token_version_id) BETWEEN 1 AND 32),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    lease_expires_at INTEGER NOT NULL CHECK (lease_expires_at > created_at),
    completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= created_at),
    CHECK (
      (status = 'pending' AND quote_status = 'pending' AND finance_status = 'pending'
        AND request_count IS NULL AND data_vol IS NULL AND elapsed_ms IS NULL
        AND safe_error_class IS NULL AND failure_code IS NULL
        AND vendor_error_code IS NULL AND completed_at IS NULL)
      OR
      (status <> 'pending' AND quote_status <> 'pending' AND finance_status <> 'pending'
        AND request_count IS NOT NULL AND elapsed_ms IS NOT NULL
        AND completed_at IS NOT NULL)
    ),
    CHECK (
      status = 'pending'
      OR (status = 'complete' AND quote_status = 'available'
        AND finance_status = 'available' AND safe_error_class IS NULL
        AND failure_code IS NULL AND vendor_error_code IS NULL)
      OR (status = 'partial'
        AND ((quote_status = 'available' AND finance_status = 'unavailable')
          OR (quote_status = 'unavailable' AND finance_status = 'available'))
        AND safe_error_class IS NOT NULL AND failure_code IS NOT NULL)
      OR (status = 'failed' AND quote_status <> 'available'
        AND finance_status <> 'available' AND safe_error_class IS NOT NULL
        AND failure_code IS NOT NULL)
    )
  )
`
const QUOTE_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS ifind_market_quote_snapshots (
    run_id TEXT PRIMARY KEY NOT NULL,
    listing_id TEXT NOT NULL CHECK (length(listing_id) BETWEEN 1 AND 64),
    display_code TEXT NOT NULL CHECK (length(display_code) BETWEEN 1 AND 16),
    latest_price REAL NOT NULL CHECK (latest_price >= 0),
    previous_close REAL NOT NULL CHECK (previous_close >= 0),
    open_price REAL NOT NULL CHECK (open_price >= 0),
    high_price REAL NOT NULL CHECK (high_price >= 0),
    low_price REAL NOT NULL CHECK (low_price >= 0),
    volume REAL NOT NULL CHECK (volume >= 0),
    turnover REAL NOT NULL CHECK (turnover >= 0),
    quote_time TEXT NOT NULL CHECK (length(quote_time) BETWEEN 20 AND 35),
    trading_status TEXT NOT NULL CHECK (trading_status IN ('trading', 'halted', 'closed')),
    currency TEXT NOT NULL CHECK (currency IN (${TRADING_CURRENCY_SQL})),
    FOREIGN KEY (run_id) REFERENCES ifind_market_case_runs(run_id) ON DELETE CASCADE
  )
`
const FINANCIAL_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS ifind_market_financial_points (
    run_id TEXT NOT NULL,
    indicator_id TEXT NOT NULL CHECK (length(indicator_id) BETWEEN 1 AND 80),
    metric_key TEXT NOT NULL CHECK (metric_key IN (${METRIC_KEY_SQL})),
    report_period TEXT NOT NULL CHECK (length(report_period) BETWEEN 4 AND 8),
    period_end TEXT NOT NULL CHECK (length(period_end) = 10),
    period_type TEXT NOT NULL CHECK (period_type IN ('annual', 'interim')),
    value REAL,
    availability TEXT NOT NULL CHECK (availability IN ('available', 'missing')),
    currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'),
    unit TEXT NOT NULL CHECK (unit = 'million'),
    disclosure_scope TEXT NOT NULL CHECK (length(disclosure_scope) BETWEEN 1 AND 32),
    source_time TEXT NOT NULL CHECK (length(source_time) BETWEEN 20 AND 35),
    fetch_time TEXT NOT NULL CHECK (length(fetch_time) BETWEEN 20 AND 35),
    PRIMARY KEY (run_id, indicator_id, period_end, period_type),
    FOREIGN KEY (run_id) REFERENCES ifind_market_case_runs(run_id) ON DELETE CASCADE,
    CHECK ((availability = 'missing' AND value IS NULL)
      OR (availability = 'available' AND value IS NOT NULL))
  )
`

class IfindMarketDiagnosticRepositoryError extends Error {
  constructor() {
    super('The iFinD market diagnostic repository input is invalid')
    this.name = 'IfindMarketDiagnosticRepositoryError'
    this.code = 'IFIND_MARKET_DIAGNOSTIC_REPOSITORY_INVALID'
  }
}

class IfindMarketDiagnosticRepositorySchemaError extends Error {
  constructor() {
    super('The iFinD market diagnostic repository schema is incompatible')
    this.name = 'IfindMarketDiagnosticRepositorySchemaError'
    this.code = 'IFIND_MARKET_DIAGNOSTIC_SCHEMA_INCOMPATIBLE'
  }
}

function failInput() {
  throw new IfindMarketDiagnosticRepositoryError()
}

function failSchema() {
  throw new IfindMarketDiagnosticRepositorySchemaError()
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

function snapshotExactDataArray(value, maximumLength) {
  try {
    if (types.isProxy(value) || !Array.isArray(value) ||
        Reflect.getPrototypeOf(value) !== Array.prototype) return null
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
        lengthDescriptor.value > maximumLength) return null
    const length = lengthDescriptor.value
    const keys = Reflect.ownKeys(value)
    if (keys.length !== length + 1 || keys.some((key) => {
      if (key === 'length') return false
      return typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= length
    })) return null
    const snapshot = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        return null
      }
      snapshot.push(descriptor.value)
    }
    return snapshot
  } catch {
    return null
  }
}

function isDerivedTimestamp(value) {
  return Number.isSafeInteger(value) &&
    value >= IFIND_MARKET_MIN_DERIVED_TIMESTAMP &&
    value <= IFIND_MARKET_MAX_DERIVED_TIMESTAMP
}

function isRunTimestamp(value) {
  return Number.isSafeInteger(value) &&
    value >= IFIND_MARKET_MIN_CREATED_AT &&
    value <= IFIND_MARKET_MAX_CREATED_AT
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function isFiniteNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isCalendarDate(value) {
  if (typeof value !== 'string') return false
  const match = CALENDAR_DATE_PATTERN.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string' || value.length > 35) return false
  const match = ISO_TIMESTAMP_PATTERN.exec(value)
  if (!match || !isCalendarDate(`${match[1]}-${match[2]}-${match[3]}`)) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const millisecond = match[7] === undefined ? 0 : Number(match[7])
  if (hour > 23 || minute > 59 || second > 59) return false
  let offsetMinutes = 0
  if (match[8] !== 'Z') {
    const offsetHour = Number(match[10])
    const offsetMinute = Number(match[11])
    if (offsetHour > 14 || offsetMinute > 59 ||
        (offsetHour === 14 && offsetMinute !== 0)) return false
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (match[9] === '+' ? 1 : -1)
  }
  const localMilliseconds = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    millisecond
  )
  const instantMilliseconds = localMilliseconds - offsetMinutes * 60_000
  const roundTrip = new Date(instantMilliseconds + offsetMinutes * 60_000)
  return roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 && roundTrip.getUTCDate() === day &&
    roundTrip.getUTCHours() === hour && roundTrip.getUTCMinutes() === minute &&
    roundTrip.getUTCSeconds() === second &&
    roundTrip.getUTCMilliseconds() === millisecond
}

function validateCaseId(value) {
  if (typeof value !== 'string' || !CASE_IDS.has(value)) failInput()
  return value
}

function validateRunId(value) {
  if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value)) failInput()
  return value
}

function validateVersionId(value) {
  if (typeof value !== 'string' || !VERSION_ID_PATTERN.test(value)) failInput()
  return value
}

function validateReservationInput(input) {
  const value = snapshotExactDataObject(input, [
    'runId', 'caseId', 'createdAt', 'tokenVersionId'
  ])
  if (!value) failInput()
  validateRunId(value.runId)
  validateCaseId(value.caseId)
  if (!isRunTimestamp(value.createdAt)) failInput()
  validateVersionId(value.tokenVersionId)
  return value
}

function validateReservation(input) {
  const value = snapshotExactDataObject(input, [
    'runId', 'caseId', 'createdAt', 'tokenVersionId', 'leaseExpiresAt'
  ])
  if (!value) failInput()
  validateRunId(value.runId)
  validateCaseId(value.caseId)
  if (!isRunTimestamp(value.createdAt) ||
      !isDerivedTimestamp(value.leaseExpiresAt) ||
      value.leaseExpiresAt !== value.createdAt + IFIND_MARKET_DIAGNOSTIC_LEASE_MS) {
    failInput()
  }
  validateVersionId(value.tokenVersionId)
  return value
}

function validateTerminalResult(input) {
  const result = snapshotExactDataObject(input, [
    'status', 'quoteStatus', 'financeStatus', 'requestCount', 'dataVol',
    'elapsedMs', 'safeErrorClass', 'failureCode', 'vendorErrorCode',
    'completedAt'
  ])
  if (!result || !['complete', 'partial', 'failed'].includes(result.status) ||
      !DATA_STATUSES.has(result.quoteStatus) ||
      !DATA_STATUSES.has(result.financeStatus) ||
      !Number.isSafeInteger(result.requestCount) || result.requestCount < 0 ||
      result.requestCount > 5 ||
      (result.dataVol !== null && !isNonNegativeInteger(result.dataVol)) ||
      !isNonNegativeInteger(result.elapsedMs) ||
      !isDerivedTimestamp(result.completedAt) ||
      (result.vendorErrorCode !== null && !Number.isSafeInteger(result.vendorErrorCode))) {
    failInput()
  }

  if (result.status === 'complete') {
    if (result.quoteStatus !== 'available' || result.financeStatus !== 'available' ||
        result.safeErrorClass !== null || result.failureCode !== null ||
        result.vendorErrorCode !== null) failInput()
  } else {
    if (!SAFE_ERROR_CLASSES.has(result.safeErrorClass) ||
        typeof result.failureCode !== 'string' ||
        !FAILURE_CODE_PATTERN.test(result.failureCode)) failInput()
    if (result.status === 'partial') {
      const quoteOnly = result.quoteStatus === 'available' &&
        result.financeStatus === 'unavailable'
      const financeOnly = result.quoteStatus === 'unavailable' &&
        result.financeStatus === 'available'
      if (!quoteOnly && !financeOnly) failInput()
    } else if (result.quoteStatus === 'available' ||
        result.financeStatus === 'available') failInput()
  }
  return result
}

function validateQuoteSnapshot(input, caseId) {
  const quote = snapshotExactDataObject(input, [
    'listingId', 'displayCode', 'latestPrice', 'previousClose', 'open', 'high',
    'low', 'volume', 'turnover', 'quoteTime', 'tradingStatus', 'currency'
  ])
  const identity = CASES[caseId]
  if (!quote || quote.listingId !== identity.listingId ||
      quote.displayCode !== identity.displayCode ||
      quote.currency !== identity.expectedTradingCurrency ||
      !TRADING_STATUSES.has(quote.tradingStatus) || !isIsoTimestamp(quote.quoteTime)) {
    failInput()
  }
  for (const field of [
    'latestPrice', 'previousClose', 'open', 'high', 'low', 'volume', 'turnover'
  ]) {
    if (!isFiniteNonNegativeNumber(quote[field])) failInput()
  }
  return quote
}

function validateFinancialPoint(input) {
  const point = snapshotExactDataObject(input, [
    'indicatorId', 'metricKey', 'reportPeriod', 'periodEnd', 'periodType',
    'value', 'availability', 'currency', 'unit', 'disclosureScope',
    'sourceTime', 'fetchTime'
  ])
  if (!point || typeof point.indicatorId !== 'string' ||
      !INDICATOR_ID_PATTERN.test(point.indicatorId) ||
      !METRIC_KEYS.includes(point.metricKey) ||
      typeof point.reportPeriod !== 'string' ||
      !REPORT_PERIOD_PATTERN.test(point.reportPeriod) ||
      !isCalendarDate(point.periodEnd) || !PERIOD_TYPES.has(point.periodType) ||
      !['available', 'missing'].includes(point.availability) ||
      typeof point.currency !== 'string' || !/^[A-Z]{3}$/.test(point.currency) ||
      point.unit !== 'million' ||
      typeof point.disclosureScope !== 'string' ||
      !/^[a-z][a-z_]{0,31}$/.test(point.disclosureScope) ||
      !isIsoTimestamp(point.sourceTime) || !isIsoTimestamp(point.fetchTime)) failInput()
  if ((point.availability === 'missing' && point.value !== null) ||
      (point.availability === 'available' &&
        !isFiniteNumber(point.value))) failInput()
  return point
}

function validateFinancialPoints(input) {
  const values = snapshotExactDataArray(input, 64)
  if (!values) failInput()
  const points = []
  const identities = new Set()
  for (const value of values) {
    const point = validateFinancialPoint(value)
    const identity = `${point.indicatorId}\u0000${point.periodEnd}\u0000${point.periodType}`
    if (identities.has(identity)) failInput()
    identities.add(identity)
    points.push(point)
  }
  return points
}

function validateCompletionInput(input) {
  const value = snapshotExactDataObject(input, [
    'reservation', 'result', 'quoteSnapshot', 'financialPoints'
  ])
  if (!value) failInput()
  const reservation = validateReservation(value.reservation)
  const result = validateTerminalResult(value.result)
  if (result.status === 'failed' || result.completedAt < reservation.createdAt ||
      result.completedAt > reservation.leaseExpiresAt) failInput()
  const quoteSnapshot = result.quoteStatus === 'available'
    ? validateQuoteSnapshot(value.quoteSnapshot, reservation.caseId)
    : value.quoteSnapshot === null ? null : failInput()
  const financialPoints = validateFinancialPoints(value.financialPoints)
  if ((result.financeStatus === 'available' && financialPoints.length === 0) ||
      (result.financeStatus !== 'available' && financialPoints.length !== 0)) failInput()
  return { reservation, result, quoteSnapshot, financialPoints }
}

function validateFailureInput(input) {
  const value = snapshotExactDataObject(input, ['reservation', 'result'])
  if (!value) failInput()
  const reservation = validateReservation(value.reservation)
  const result = validateTerminalResult(value.result)
  if (result.status !== 'failed' || result.completedAt < reservation.createdAt ||
      result.completedAt > reservation.leaseExpiresAt) failInput()
  return { reservation, result, quoteSnapshot: null, financialPoints: [] }
}

function normalizedColumns(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`).all().map((row) => [
    String(row.name), String(row.type).toUpperCase(), Number(row.notnull), Number(row.pk)
  ])
}

function normalizeSql(value) {
  const sql = String(value || '')
  let normalized = ''
  let inString = false
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]
    if (character === "'") {
      normalized += character
      if (inString && sql[index + 1] === "'") {
        normalized += sql[index + 1]
        index += 1
      } else {
        inString = !inString
      }
    } else if (inString) {
      normalized += character
    } else if (!/\s/.test(character)) {
      normalized += character.toLowerCase()
    }
  }
  if (!inString && normalized.endsWith(';')) normalized = normalized.slice(0, -1)
  return normalized.replace('ifnotexists', '')
}

function indexColumnNames(database, indexName) {
  return database.prepare(`PRAGMA index_info(${indexName})`).all().map((row) =>
    String(row.name))
}

function validateForeignKey(database, table) {
  const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${table})`).all()
  if (foreignKeys.length !== 1 ||
      foreignKeys[0].table !== 'ifind_market_case_runs' ||
      foreignKeys[0].from !== 'run_id' || foreignKeys[0].to !== 'run_id' ||
      foreignKeys[0].on_update !== 'NO ACTION' ||
      foreignKeys[0].on_delete !== 'CASCADE') failSchema()
}

function validateIndexes(database) {
  const indexes = database.prepare('PRAGMA index_list(ifind_market_case_runs)').all()
  if (indexes.length !== 4) failSchema()
  const byName = new Map(indexes.map((row) => [row.name, row]))
  const pending = byName.get('ifind_market_case_runs_one_pending')
  const perCase = byName.get('ifind_market_case_runs_case_created')
  const global = byName.get('ifind_market_case_runs_created')
  const primary = indexes.find((row) => row.origin === 'pk')
  if (!pending || pending.unique !== 1 || pending.partial !== 1 ||
      !perCase || perCase.unique !== 0 || perCase.partial !== 0 ||
      !global || global.unique !== 0 || global.partial !== 0 ||
      !primary || primary.unique !== 1 || primary.partial !== 0 ||
      JSON.stringify(indexColumnNames(database, pending.name)) !==
        JSON.stringify(['status']) ||
      JSON.stringify(indexColumnNames(database, perCase.name)) !==
        JSON.stringify(['case_id', 'created_at', 'run_id']) ||
      JSON.stringify(indexColumnNames(database, global.name)) !==
        JSON.stringify(['created_at']) ||
      JSON.stringify(indexColumnNames(database, primary.name)) !==
        JSON.stringify(['run_id'])) failSchema()

  const quoteIndexes = database.prepare(
    'PRAGMA index_list(ifind_market_quote_snapshots)'
  ).all()
  if (quoteIndexes.length !== 1 || quoteIndexes[0].origin !== 'pk' ||
      JSON.stringify(indexColumnNames(database, quoteIndexes[0].name)) !==
        JSON.stringify(['run_id'])) failSchema()
  const financialIndexes = database.prepare(
    'PRAGMA index_list(ifind_market_financial_points)'
  ).all()
  if (financialIndexes.length !== 1 || financialIndexes[0].origin !== 'pk' ||
      JSON.stringify(indexColumnNames(database, financialIndexes[0].name)) !==
        JSON.stringify(['run_id', 'indicator_id', 'period_end', 'period_type'])) {
    failSchema()
  }
}

function validateSchema(database) {
  if (JSON.stringify(normalizedColumns(database, 'ifind_market_case_runs')) !==
      JSON.stringify(RUN_COLUMNS) ||
      JSON.stringify(normalizedColumns(database, 'ifind_market_quote_snapshots')) !==
      JSON.stringify(QUOTE_COLUMNS) ||
      JSON.stringify(normalizedColumns(database, 'ifind_market_financial_points')) !==
      JSON.stringify(FINANCIAL_COLUMNS)) failSchema()
  validateIndexes(database)
  validateForeignKey(database, 'ifind_market_quote_snapshots')
  validateForeignKey(database, 'ifind_market_financial_points')

  const rows = database.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'ifind_market_case_runs',
      'ifind_market_quote_snapshots',
      'ifind_market_financial_points'
    )
  `).all()
  if (rows.length !== 3) failSchema()
  const sqlByName = new Map(rows.map((row) => [row.name, normalizeSql(row.sql)]))
  const expectedTables = new Map([
    ['ifind_market_case_runs', normalizeSql(RUN_TABLE_DDL)],
    ['ifind_market_quote_snapshots', normalizeSql(QUOTE_TABLE_DDL)],
    ['ifind_market_financial_points', normalizeSql(FINANCIAL_TABLE_DDL)]
  ])
  for (const [name, expectedSql] of expectedTables) {
    if (sqlByName.get(name) !== expectedSql) failSchema()
  }

  const indexRows = database.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'index' AND name IN (
      'ifind_market_case_runs_one_pending',
      'ifind_market_case_runs_case_created',
      'ifind_market_case_runs_created'
    )
  `).all()
  const indexSqlByName = new Map(indexRows.map((row) => [
    row.name,
    normalizeSql(row.sql)
  ]))
  const expectedIndexes = new Map([
    [
      'ifind_market_case_runs_one_pending',
      normalizeSql(`CREATE UNIQUE INDEX ifind_market_case_runs_one_pending
        ON ifind_market_case_runs(status) WHERE status = 'pending'`)
    ],
    [
      'ifind_market_case_runs_case_created',
      normalizeSql(`CREATE INDEX ifind_market_case_runs_case_created
        ON ifind_market_case_runs(case_id, created_at DESC, run_id DESC)`)
    ],
    [
      'ifind_market_case_runs_created',
      normalizeSql(`CREATE INDEX ifind_market_case_runs_created
        ON ifind_market_case_runs(created_at)`)
    ]
  ])
  if (indexRows.length !== expectedIndexes.size) failSchema()
  for (const [name, expectedSql] of expectedIndexes) {
    if (indexSqlByName.get(name) !== expectedSql) failSchema()
  }
  const sql = rows.map((row) => String(row.sql || '')).join('\n')
  for (const fragment of [
    `case_id IN (${CASE_ID_SQL})`,
    "status IN ('pending', 'complete', 'partial', 'failed')",
    'request_count BETWEEN 0 AND 5',
    "availability = 'missing' AND value IS NULL",
    'FOREIGN KEY (run_id) REFERENCES ifind_market_case_runs(run_id) ON DELETE CASCADE'
  ]) {
    if (!sql.includes(fragment)) failSchema()
  }

  const triggers = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name IN (
      'ifind_market_case_runs',
      'ifind_market_quote_snapshots',
      'ifind_market_financial_points'
    )
    UNION ALL
    SELECT name FROM sqlite_temp_master
    WHERE type = 'trigger' AND tbl_name IN (
      'ifind_market_case_runs',
      'ifind_market_quote_snapshots',
      'ifind_market_financial_points'
    )
  `).all()
  if (triggers.length !== 0) failSchema()
}

const SHANGHAI_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})

function shanghaiDay(timestamp) {
  if (!isDerivedTimestamp(timestamp)) failInput()
  const values = Object.create(null)
  for (const part of SHANGHAI_FORMATTER.formatToParts(new Date(timestamp))) {
    values[part.type] = part.value
  }
  const dayKey = `${values.year}-${values.month}-${values.day}`
  const dayStart = Date.parse(`${dayKey}T00:00:00+08:00`)
  const nextDayStart = dayStart + SHANGHAI_DAY_MS
  if (!isDerivedTimestamp(dayStart) || !isDerivedTimestamp(nextDayStart)) failInput()
  return { dayKey, dayStart, nextDayStart }
}

function canClaimZeroApplicationId(database) {
  const objects = database.prepare(`
    SELECT type, name FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
  `).all()
  if (objects.length === 0) return true
  if (!hasStrictLegacyDeviceSchema(database)) return false
  return objects.every((object) =>
    (object.type === 'table' && RECOGNIZED_KINVEST_TABLES.has(object.name)) ||
    (object.type === 'index' && RECOGNIZED_KINVEST_INDEXES.has(object.name)))
}

function mapQuote(row) {
  if (!row) return null
  return {
    listingId: row.listing_id,
    displayCode: row.display_code,
    latestPrice: row.latest_price,
    previousClose: row.previous_close,
    open: row.open_price,
    high: row.high_price,
    low: row.low_price,
    volume: row.volume,
    turnover: row.turnover,
    quoteTime: row.quote_time,
    tradingStatus: row.trading_status,
    currency: row.currency
  }
}

function mapFinancialPoint(row) {
  return {
    indicatorId: row.indicator_id,
    metricKey: row.metric_key,
    reportPeriod: row.report_period,
    periodEnd: row.period_end,
    periodType: row.period_type,
    value: row.value,
    availability: row.availability,
    currency: row.currency,
    unit: row.unit,
    disclosureScope: row.disclosure_scope,
    sourceTime: row.source_time,
    fetchTime: row.fetch_time
  }
}

function mapRun(row, quoteSnapshot, financialPoints) {
  return {
    runId: row.run_id,
    caseId: row.case_id,
    status: row.status,
    quoteStatus: row.quote_status,
    financeStatus: row.finance_status,
    requestCount: row.request_count,
    dataVol: row.data_vol,
    elapsedMs: row.elapsed_ms,
    safeErrorClass: row.safe_error_class,
    failureCode: row.failure_code,
    vendorErrorCode: row.vendor_error_code,
    tokenVersionId: row.token_version_id,
    createdAt: row.created_at,
    leaseExpiresAt: row.lease_expires_at,
    completedAt: row.completed_at,
    quoteSnapshot,
    financialPoints
  }
}

class IfindMarketDiagnosticRepository {
  #database

  constructor(database) {
    if (!(database instanceof DatabaseSync)) failInput()
    this.#database = database
  }

  #withImmediateTransaction(operation) {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.#database.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK')
      } catch {
        // Best-effort cleanup must not replace the stable repository result.
      }
      throw error
    }
  }

  #withDeferredReadTransaction(operation) {
    this.#database.exec('BEGIN DEFERRED')
    try {
      const result = operation()
      this.#database.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK')
      } catch {
        // Best-effort cleanup must not replace the stable repository result.
      }
      throw error
    }
  }

  initialize() {
    this.#database.exec('PRAGMA busy_timeout = 5000')
    this.#database.exec('PRAGMA foreign_keys = ON')
    this.#withImmediateTransaction(() => {
      const applicationId = readApplicationId(this.#database)
      if (applicationId === 0) {
        if (!canClaimZeroApplicationId(this.#database)) {
          throw new DeviceAuthDatabaseIdentityError()
        }
        setKinvestApplicationId(this.#database)
      } else if (applicationId !== KINVEST_SQLITE_APPLICATION_ID) {
        throw new DeviceAuthDatabaseIdentityError()
      }
      try {
        this.#database.exec(`
          ${RUN_TABLE_DDL};
          ${QUOTE_TABLE_DDL};
          ${FINANCIAL_TABLE_DDL};
          CREATE UNIQUE INDEX IF NOT EXISTS ifind_market_case_runs_one_pending
            ON ifind_market_case_runs(status) WHERE status = 'pending';
          CREATE INDEX IF NOT EXISTS ifind_market_case_runs_case_created
            ON ifind_market_case_runs(case_id, created_at DESC, run_id DESC);
          CREATE INDEX IF NOT EXISTS ifind_market_case_runs_created
            ON ifind_market_case_runs(created_at);
        `)
      } catch {
        failSchema()
      }
      validateSchema(this.#database)
    })
  }

  #readRun(runId) {
    return this.#database.prepare(`
      SELECT run_id, case_id, status, quote_status, finance_status,
             request_count, data_vol, elapsed_ms, safe_error_class,
             failure_code, vendor_error_code, token_version_id, created_at,
             lease_expires_at, completed_at
      FROM ifind_market_case_runs WHERE run_id = ?
    `).get(runId)
  }

  #readPending() {
    return this.#database.prepare(`
      SELECT run_id, case_id, status, quote_status, finance_status,
             request_count, data_vol, elapsed_ms, safe_error_class,
             failure_code, vendor_error_code, token_version_id, created_at,
             lease_expires_at, completed_at
      FROM ifind_market_case_runs WHERE status = 'pending' LIMIT 1
    `).get()
  }

  #recoverStale(row, recoveredAt) {
    const completedAt = row.lease_expires_at
    if (!isDerivedTimestamp(completedAt)) failSchema()
    const update = this.#database.prepare(`
      UPDATE ifind_market_case_runs
      SET status = 'failed', quote_status = 'not_run',
          finance_status = 'not_run', request_count = 0, data_vol = NULL,
          elapsed_ms = ?, safe_error_class = 'NETWORK',
          failure_code = 'IFIND_MARKET_DIAGNOSTIC_STALE_LEASE',
          vendor_error_code = NULL, completed_at = ?
      WHERE run_id = ? AND status = 'pending' AND lease_expires_at <= ?
    `).run(
      completedAt - row.created_at,
      completedAt,
      row.run_id,
      recoveredAt
    )
    if (update.changes !== 1) failSchema()
  }

  #readQuota(caseId, now, day = shanghaiDay(now)) {
    const caseAttemptCount = Number(this.#database.prepare(`
      SELECT COUNT(*) AS count FROM ifind_market_case_runs
      WHERE case_id = ? AND created_at >= ? AND created_at < ?
    `).get(caseId, day.dayStart, day.nextDayStart).count)
    const globalAttemptCount = Number(this.#database.prepare(`
      SELECT COUNT(*) AS count FROM ifind_market_case_runs
      WHERE created_at >= ? AND created_at < ?
    `).get(day.dayStart, day.nextDayStart).count)
    const latestTerminal = this.#database.prepare(`
      SELECT completed_at FROM ifind_market_case_runs
      WHERE case_id = ? AND completed_at IS NOT NULL
      ORDER BY completed_at DESC, run_id DESC LIMIT 1
    `).get(caseId)
    const cooldownCandidate = latestTerminal
      ? latestTerminal.completed_at + IFIND_MARKET_CASE_COOLDOWN_MS
      : null
    if (cooldownCandidate !== null && !isDerivedTimestamp(cooldownCandidate)) {
      failSchema()
    }
    const pending = this.#readPending()
    const activePending = pending && now < pending.lease_expires_at ? pending : null
    return {
      localDayKey: day.dayKey,
      caseAttemptCount,
      globalAttemptCount,
      caseRemaining: Math.max(0, IFIND_MARKET_CASE_DAILY_LIMIT - caseAttemptCount),
      globalRemaining: Math.max(0, IFIND_MARKET_GLOBAL_DAILY_LIMIT - globalAttemptCount),
      cooldownUntil: cooldownCandidate !== null && now < cooldownCandidate
        ? cooldownCandidate
        : null,
      inFlight: activePending !== null,
      inFlightCaseId: activePending ? activePending.case_id : null,
      inFlightExpiresAt: activePending ? activePending.lease_expires_at : null
    }
  }

  reserve(input) {
    const request = validateReservationInput(input)
    const incomingDay = shanghaiDay(request.createdAt)
    return this.#withImmediateTransaction(() => {
      if (this.#readRun(request.runId)) {
        const quota = this.#readQuota(request.caseId, request.createdAt, incomingDay)
        return { status: 'duplicate', ...quota }
      }

      const latest = this.#database.prepare(`
        SELECT created_at FROM ifind_market_case_runs
        ORDER BY created_at DESC, run_id DESC LIMIT 1
      `).get()
      if (latest) {
        const latestDay = shanghaiDay(latest.created_at)
        if (incomingDay.dayStart < latestDay.dayStart) {
          const quota = this.#readQuota(request.caseId, latest.created_at, latestDay)
          return { status: 'clock-rollback', ...quota }
        }
      }

      let pending = this.#readPending()
      if (pending && request.createdAt >= pending.lease_expires_at) {
        this.#recoverStale(pending, request.createdAt)
        pending = this.#readPending()
      }
      const quota = this.#readQuota(request.caseId, request.createdAt, incomingDay)
      if (pending) {
        return {
          status: 'busy',
          retryAt: pending.lease_expires_at,
          ...quota
        }
      }
      if (quota.cooldownUntil !== null) {
        return { status: 'cooldown', retryAt: quota.cooldownUntil, ...quota }
      }
      if (quota.caseAttemptCount >= IFIND_MARKET_CASE_DAILY_LIMIT) {
        return {
          status: 'case-daily-limit',
          retryAt: incomingDay.nextDayStart,
          ...quota
        }
      }
      if (quota.globalAttemptCount >= IFIND_MARKET_GLOBAL_DAILY_LIMIT) {
        return {
          status: 'global-daily-limit',
          retryAt: incomingDay.nextDayStart,
          ...quota
        }
      }

      const leaseExpiresAt = request.createdAt + IFIND_MARKET_DIAGNOSTIC_LEASE_MS
      if (!isDerivedTimestamp(leaseExpiresAt)) failInput()
      const insert = this.#database.prepare(`
        INSERT INTO ifind_market_case_runs (
          run_id, case_id, status, quote_status, finance_status,
          token_version_id, created_at, lease_expires_at
        ) VALUES (?, ?, 'pending', 'pending', 'pending', ?, ?, ?)
      `).run(
        request.runId,
        request.caseId,
        request.tokenVersionId,
        request.createdAt,
        leaseExpiresAt
      )
      if (insert.changes !== 1) failSchema()
      return {
        status: 'reserved',
        reservation: {
          runId: request.runId,
          caseId: request.caseId,
          createdAt: request.createdAt,
          tokenVersionId: request.tokenVersionId,
          leaseExpiresAt
        },
        localDayKey: quota.localDayKey,
        caseAttemptCount: quota.caseAttemptCount + 1,
        globalAttemptCount: quota.globalAttemptCount + 1
      }
    })
  }

  #insertQuote(runId, quote) {
    this.#database.prepare(`
      INSERT INTO ifind_market_quote_snapshots (
        run_id, listing_id, display_code, latest_price, previous_close,
        open_price, high_price, low_price, volume, turnover, quote_time,
        trading_status, currency
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      quote.listingId,
      quote.displayCode,
      quote.latestPrice,
      quote.previousClose,
      quote.open,
      quote.high,
      quote.low,
      quote.volume,
      quote.turnover,
      quote.quoteTime,
      quote.tradingStatus,
      quote.currency
    )
  }

  #insertFinancialPoints(runId, points) {
    const insert = this.#database.prepare(`
      INSERT INTO ifind_market_financial_points (
        run_id, indicator_id, metric_key, report_period, period_end,
        period_type, value, availability, currency, unit, disclosure_scope,
        source_time, fetch_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const point of points) {
      insert.run(
        runId,
        point.indicatorId,
        point.metricKey,
        point.reportPeriod,
        point.periodEnd,
        point.periodType,
        point.value,
        point.availability,
        point.currency,
        point.unit,
        point.disclosureScope,
        point.sourceTime,
        point.fetchTime
      )
    }
  }

  #settle(value) {
    const { reservation, result, quoteSnapshot, financialPoints } = value
    return this.#withImmediateTransaction(() => {
      const row = this.#readRun(reservation.runId)
      if (!row || row.case_id !== reservation.caseId ||
          row.created_at !== reservation.createdAt ||
          row.lease_expires_at !== reservation.leaseExpiresAt ||
          row.token_version_id !== reservation.tokenVersionId) {
        return { status: 'not-found' }
      }
      if (row.status !== 'pending') return { status: 'conflict' }

      const update = this.#database.prepare(`
        UPDATE ifind_market_case_runs
        SET status = ?, quote_status = ?, finance_status = ?, request_count = ?,
            data_vol = ?, elapsed_ms = ?, safe_error_class = ?, failure_code = ?,
            vendor_error_code = ?, completed_at = ?
        WHERE run_id = ? AND status = 'pending' AND lease_expires_at >= ?
      `).run(
        result.status,
        result.quoteStatus,
        result.financeStatus,
        result.requestCount,
        result.dataVol,
        result.elapsedMs,
        result.safeErrorClass,
        result.failureCode,
        result.vendorErrorCode,
        result.completedAt,
        reservation.runId,
        result.completedAt
      )
      if (update.changes !== 1) failSchema()
      if (quoteSnapshot) this.#insertQuote(reservation.runId, quoteSnapshot)
      this.#insertFinancialPoints(reservation.runId, financialPoints)
      const cooldownUntil = result.completedAt + IFIND_MARKET_CASE_COOLDOWN_MS
      if (!isDerivedTimestamp(cooldownUntil)) failSchema()
      return {
        status: 'completed',
        cooldownUntil
      }
    })
  }

  complete(input) {
    return this.#settle(validateCompletionInput(input))
  }

  fail(input) {
    return this.#settle(validateFailureInput(input))
  }

  #hydrateRun(row) {
    const quoteSnapshot = mapQuote(this.#database.prepare(`
      SELECT listing_id, display_code, latest_price, previous_close,
             open_price, high_price, low_price, volume, turnover, quote_time,
             trading_status, currency
      FROM ifind_market_quote_snapshots WHERE run_id = ?
    `).get(row.run_id))
    const financialPoints = this.#database.prepare(`
      SELECT indicator_id, metric_key, report_period, period_end, period_type,
             value, availability, currency, unit, disclosure_scope,
             source_time, fetch_time
      FROM ifind_market_financial_points WHERE run_id = ?
      ORDER BY period_end DESC, indicator_id ASC, period_type ASC
    `).all(row.run_id).map(mapFinancialPoint)
    return mapRun(row, quoteSnapshot, financialPoints)
  }

  latest(input) {
    const value = snapshotExactDataObject(input, ['caseId'])
    if (!value) failInput()
    validateCaseId(value.caseId)
    const row = this.#database.prepare(`
      SELECT run_id, case_id, status, quote_status, finance_status,
             request_count, data_vol, elapsed_ms, safe_error_class,
             failure_code, vendor_error_code, token_version_id, created_at,
             lease_expires_at, completed_at
      FROM ifind_market_case_runs
      WHERE case_id = ? AND completed_at IS NOT NULL
      ORDER BY completed_at DESC, run_id DESC LIMIT 1
    `).get(value.caseId)
    return row ? this.#hydrateRun(row) : null
  }

  history(input) {
    const value = snapshotExactDataObject(input, ['caseId', 'limit'])
    if (!value) failInput()
    validateCaseId(value.caseId)
    if (!Number.isSafeInteger(value.limit) || value.limit < 1 ||
        value.limit > IFIND_MARKET_HISTORY_LIMIT) failInput()
    return this.#database.prepare(`
      SELECT run_id, case_id, status, quote_status, finance_status,
             request_count, data_vol, elapsed_ms, safe_error_class,
             failure_code, vendor_error_code, token_version_id, created_at,
             lease_expires_at, completed_at
      FROM ifind_market_case_runs
      WHERE case_id = ? AND completed_at IS NOT NULL
      ORDER BY completed_at DESC, run_id DESC LIMIT ?
    `).all(value.caseId, value.limit).map((row) => this.#hydrateRun(row))
  }

  quotaStatus(input) {
    const value = snapshotExactDataObject(input, ['caseId', 'now'])
    if (!value) failInput()
    validateCaseId(value.caseId)
    if (!isRunTimestamp(value.now)) failInput()
    return this.#withDeferredReadTransaction(() =>
      this.#readQuota(value.caseId, value.now))
  }
}

module.exports = {
  IFIND_MARKET_CASE_COOLDOWN_MS,
  IFIND_MARKET_CASE_DAILY_LIMIT,
  IFIND_MARKET_DIAGNOSTIC_LEASE_MS,
  IFIND_MARKET_GLOBAL_DAILY_LIMIT,
  IFIND_MARKET_MAX_CREATED_AT,
  IFIND_MARKET_MAX_DERIVED_TIMESTAMP,
  IfindMarketDiagnosticRepository,
  IfindMarketDiagnosticRepositoryError,
  IfindMarketDiagnosticRepositorySchemaError
}

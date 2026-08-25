const { DatabaseSync } = require('node:sqlite')
const { types } = require('node:util')
const {
  DeviceAuthDatabaseIdentityError,
  KINVEST_SQLITE_APPLICATION_ID,
  readApplicationId,
  setKinvestApplicationId
} = require('./database-identity')

const IFIND_DIAGNOSTIC_COOLDOWN_MS = 60_000
const IFIND_DIAGNOSTIC_DAILY_LIMIT = 20
const IFIND_DIAGNOSTIC_LEASE_MS = 30_000
const IFIND_DIAGNOSTIC_ROUTE = '/api/v1/get_trade_dates'
const VERSION_ID_PATTERN = /^v[0-9]{8}-[0-9]{3}$/
const DIAGNOSTIC_ID_PATTERN = /^diag_[a-f0-9]{24,64}$/
const AUTH_STATUSES = new Set(['success', 'failed', 'unknown'])
const PROBE_STATUSES = new Set(['success', 'failed', 'not_run'])
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
const COMPLETENESS_VALUES = new Set(['complete', 'partial', 'unavailable'])

class IfindDiagnosticRepositoryError extends Error {
  constructor() {
    super('The iFinD diagnostic repository input is invalid')
    this.name = 'IfindDiagnosticRepositoryError'
    this.code = 'IFIND_DIAGNOSTIC_REPOSITORY_INVALID'
  }
}

function failInput() {
  throw new IfindDiagnosticRepositoryError()
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

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function validateDiagnosticId(value) {
  if (typeof value !== 'string' || !DIAGNOSTIC_ID_PATTERN.test(value)) failInput()
}

function validateVersionId(value) {
  if (typeof value !== 'string' || !VERSION_ID_PATTERN.test(value)) failInput()
}

function shanghaiDayKey(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(timestamp))
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  return `${values.year}-${values.month}-${values.day}`
}

function nextShanghaiDayStart(dayKey) {
  return Date.parse(`${dayKey}T16:00:00.000Z`)
}

function mapRun(row) {
  if (!row) return null
  return {
    diagnosticId: row.diagnostic_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    authStatus: row.auth_status,
    probeStatus: row.probe_status,
    safeErrorClass: row.safe_error_class,
    route: row.route,
    requestCount: row.request_count,
    dataVol: row.data_vol,
    elapsedMs: row.elapsed_ms,
    completeness: row.completeness,
    tokenVersionId: row.token_version_id
  }
}

function validateReservationInput(input) {
  const value = snapshotExactDataObject(input, [
    'diagnosticId',
    'startedAt',
    'tokenVersionId'
  ])
  if (!value) failInput()
  validateDiagnosticId(value.diagnosticId)
  if (!isTimestamp(value.startedAt)) failInput()
  validateVersionId(value.tokenVersionId)
  return value
}

function validateReservation(value) {
  const reservation = snapshotExactDataObject(value, [
    'diagnosticId',
    'startedAt',
    'tokenVersionId',
    'inFlightExpiresAt'
  ])
  if (!reservation) failInput()
  validateDiagnosticId(reservation.diagnosticId)
  if (!isTimestamp(reservation.startedAt) ||
      !isTimestamp(reservation.inFlightExpiresAt) ||
      reservation.inFlightExpiresAt <= reservation.startedAt) failInput()
  validateVersionId(reservation.tokenVersionId)
  return reservation
}

function validateTerminalResult(value) {
  const result = snapshotExactDataObject(value, [
    'completedAt',
    'authStatus',
    'probeStatus',
    'safeErrorClass',
    'route',
    'requestCount',
    'dataVol',
    'elapsedMs',
    'completeness'
  ])
  if (!result || !isTimestamp(result.completedAt) ||
      !AUTH_STATUSES.has(result.authStatus) ||
      !PROBE_STATUSES.has(result.probeStatus) ||
      (result.safeErrorClass !== null && !SAFE_ERROR_CLASSES.has(result.safeErrorClass)) ||
      result.route !== IFIND_DIAGNOSTIC_ROUTE ||
      !isNonNegativeInteger(result.requestCount) ||
      (result.dataVol !== null && !isNonNegativeInteger(result.dataVol)) ||
      !isNonNegativeInteger(result.elapsedMs) ||
      !COMPLETENESS_VALUES.has(result.completeness)) failInput()
  if (result.authStatus === 'success' && result.probeStatus === 'success') {
    if (result.safeErrorClass !== null || result.completeness === 'unavailable') failInput()
  } else if (result.safeErrorClass === null) {
    failInput()
  }
  return result
}

class IfindDiagnosticRepository {
  constructor(database) {
    if (!(database instanceof DatabaseSync)) failInput()
    this.database = database
  }

  withImmediateTransaction(operation) {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      try { this.database.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  initialize() {
    this.database.exec('PRAGMA busy_timeout = 5000')
    this.withImmediateTransaction(() => {
      const applicationId = readApplicationId(this.database)
      if (applicationId === 0) {
        setKinvestApplicationId(this.database)
      } else if (applicationId !== KINVEST_SQLITE_APPLICATION_ID) {
        throw new DeviceAuthDatabaseIdentityError()
      }
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS ifind_diagnostic_runs (
          diagnostic_id TEXT PRIMARY KEY,
          started_at INTEGER NOT NULL,
          completed_at INTEGER NOT NULL,
          auth_status TEXT NOT NULL,
          probe_status TEXT NOT NULL,
          safe_error_class TEXT,
          route TEXT NOT NULL,
          request_count INTEGER NOT NULL,
          data_vol INTEGER,
          elapsed_ms INTEGER NOT NULL,
          completeness TEXT NOT NULL,
          token_version_id TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ifind_diagnostic_control (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          day_key TEXT NOT NULL,
          daily_attempt_count INTEGER NOT NULL,
          cooldown_until INTEGER,
          in_flight_id TEXT,
          in_flight_started_at INTEGER,
          in_flight_expires_at INTEGER,
          in_flight_token_version_id TEXT
        );

        INSERT INTO ifind_diagnostic_control (
          singleton_id, day_key, daily_attempt_count, cooldown_until,
          in_flight_id, in_flight_started_at, in_flight_expires_at,
          in_flight_token_version_id
        ) VALUES (1, '', 0, NULL, NULL, NULL, NULL, NULL)
        ON CONFLICT(singleton_id) DO NOTHING;
      `)
    })
  }

  readControl() {
    return this.database.prepare(`
      SELECT day_key, daily_attempt_count, cooldown_until, in_flight_id,
             in_flight_started_at, in_flight_expires_at,
             in_flight_token_version_id
      FROM ifind_diagnostic_control
      WHERE singleton_id = 1
    `).get()
  }

  insertRun(run) {
    this.database.prepare(`
      INSERT INTO ifind_diagnostic_runs (
        diagnostic_id, started_at, completed_at, auth_status, probe_status,
        safe_error_class, route, request_count, data_vol, elapsed_ms,
        completeness, token_version_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.diagnosticId,
      run.startedAt,
      run.completedAt,
      run.authStatus,
      run.probeStatus,
      run.safeErrorClass,
      run.route,
      run.requestCount,
      run.dataVol,
      run.elapsedMs,
      run.completeness,
      run.tokenVersionId
    )
  }

  reserve(input) {
    const request = validateReservationInput(input)
    const localDayKey = shanghaiDayKey(request.startedAt)
    return this.withImmediateTransaction(() => {
      let control = this.readControl()
      if (!control) throw new IfindDiagnosticRepositoryError()

      if (control.in_flight_id !== null &&
          control.in_flight_expires_at !== null &&
          request.startedAt >= control.in_flight_expires_at) {
        const staleStartedAt = control.in_flight_started_at ?? control.in_flight_expires_at
        this.insertRun({
          diagnosticId: control.in_flight_id,
          startedAt: staleStartedAt,
          completedAt: request.startedAt,
          authStatus: 'unknown',
          probeStatus: 'not_run',
          safeErrorClass: 'CONFIG',
          route: IFIND_DIAGNOSTIC_ROUTE,
          requestCount: 0,
          dataVol: null,
          elapsedMs: Math.max(0, request.startedAt - staleStartedAt),
          completeness: 'unavailable',
          tokenVersionId: control.in_flight_token_version_id
        })
        this.database.prepare(`
          UPDATE ifind_diagnostic_control
          SET cooldown_until = ?, in_flight_id = NULL,
              in_flight_started_at = NULL, in_flight_expires_at = NULL,
              in_flight_token_version_id = NULL
          WHERE singleton_id = 1 AND in_flight_id = ?
        `).run(request.startedAt + IFIND_DIAGNOSTIC_COOLDOWN_MS, control.in_flight_id)
        control = this.readControl()
      }

      if (control.day_key !== localDayKey) {
        this.database.prepare(`
          UPDATE ifind_diagnostic_control
          SET day_key = ?, daily_attempt_count = 0
          WHERE singleton_id = 1
        `).run(localDayKey)
        control = this.readControl()
      }

      if (control.in_flight_id !== null) {
        return {
          status: 'busy',
          retryAt: control.in_flight_expires_at,
          localDayKey,
          localAttemptCount: control.daily_attempt_count
        }
      }
      if (control.cooldown_until !== null && request.startedAt < control.cooldown_until) {
        return {
          status: 'cooldown',
          retryAt: control.cooldown_until,
          localDayKey,
          localAttemptCount: control.daily_attempt_count
        }
      }
      if (control.daily_attempt_count >= IFIND_DIAGNOSTIC_DAILY_LIMIT) {
        return {
          status: 'daily-limit',
          retryAt: nextShanghaiDayStart(localDayKey),
          localDayKey,
          localAttemptCount: control.daily_attempt_count
        }
      }

      const inFlightExpiresAt = request.startedAt + IFIND_DIAGNOSTIC_LEASE_MS
      this.database.prepare(`
        UPDATE ifind_diagnostic_control
        SET daily_attempt_count = daily_attempt_count + 1,
            cooldown_until = NULL,
            in_flight_id = ?,
            in_flight_started_at = ?,
            in_flight_expires_at = ?,
            in_flight_token_version_id = ?
        WHERE singleton_id = 1 AND in_flight_id IS NULL
      `).run(
        request.diagnosticId,
        request.startedAt,
        inFlightExpiresAt,
        request.tokenVersionId
      )
      return {
        status: 'reserved',
        reservation: {
          diagnosticId: request.diagnosticId,
          startedAt: request.startedAt,
          tokenVersionId: request.tokenVersionId,
          inFlightExpiresAt
        },
        localDayKey,
        localAttemptCount: control.daily_attempt_count + 1
      }
    })
  }

  settle(input) {
    const value = snapshotExactDataObject(input, ['reservation', 'result'])
    if (!value) failInput()
    const reservation = validateReservation(value.reservation)
    const result = validateTerminalResult(value.result)
    if (result.completedAt < reservation.startedAt) failInput()

    return this.withImmediateTransaction(() => {
      const control = this.readControl()
      if (!control || control.in_flight_id !== reservation.diagnosticId ||
          control.in_flight_started_at !== reservation.startedAt ||
          control.in_flight_expires_at !== reservation.inFlightExpiresAt ||
          control.in_flight_token_version_id !== reservation.tokenVersionId) {
        return { status: 'not-found' }
      }
      const cooldownUntil = result.completedAt + IFIND_DIAGNOSTIC_COOLDOWN_MS
      this.insertRun({
        diagnosticId: reservation.diagnosticId,
        startedAt: reservation.startedAt,
        completedAt: result.completedAt,
        authStatus: result.authStatus,
        probeStatus: result.probeStatus,
        safeErrorClass: result.safeErrorClass,
        route: result.route,
        requestCount: result.requestCount,
        dataVol: result.dataVol,
        elapsedMs: result.elapsedMs,
        completeness: result.completeness,
        tokenVersionId: reservation.tokenVersionId
      })
      this.database.prepare(`
        UPDATE ifind_diagnostic_control
        SET cooldown_until = ?, in_flight_id = NULL,
            in_flight_started_at = NULL, in_flight_expires_at = NULL,
            in_flight_token_version_id = NULL
        WHERE singleton_id = 1 AND in_flight_id = ?
      `).run(cooldownUntil, reservation.diagnosticId)
      return { status: 'completed', cooldownUntil }
    })
  }

  complete(input) {
    return this.settle(input)
  }

  fail(input) {
    return this.settle(input)
  }

  list(limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) failInput()
    return this.database.prepare(`
      SELECT diagnostic_id, started_at, completed_at, auth_status, probe_status,
             safe_error_class, route, request_count, data_vol, elapsed_ms,
             completeness, token_version_id
      FROM ifind_diagnostic_runs
      ORDER BY completed_at DESC, diagnostic_id DESC
      LIMIT ?
    `).all(limit).map(mapRun)
  }

  latest() {
    return mapRun(this.database.prepare(`
      SELECT diagnostic_id, started_at, completed_at, auth_status, probe_status,
             safe_error_class, route, request_count, data_vol, elapsed_ms,
             completeness, token_version_id
      FROM ifind_diagnostic_runs
      ORDER BY completed_at DESC, diagnostic_id DESC
      LIMIT 1
    `).get())
  }

  status(now) {
    if (!isTimestamp(now)) failInput()
    const control = this.readControl()
    if (!control) throw new IfindDiagnosticRepositoryError()
    const localDayKey = shanghaiDayKey(now)
    const sameDay = control.day_key === localDayKey
    const activeInFlight = control.in_flight_id !== null &&
      control.in_flight_expires_at !== null && now < control.in_flight_expires_at
    return {
      localDayKey,
      localAttemptCount: sameDay ? control.daily_attempt_count : 0,
      cooldownUntil: control.cooldown_until !== null && now < control.cooldown_until
        ? control.cooldown_until
        : null,
      inFlight: activeInFlight,
      inFlightExpiresAt: activeInFlight ? control.in_flight_expires_at : null
    }
  }
}

module.exports = {
  IFIND_DIAGNOSTIC_COOLDOWN_MS,
  IFIND_DIAGNOSTIC_DAILY_LIMIT,
  IFIND_DIAGNOSTIC_LEASE_MS,
  IFIND_DIAGNOSTIC_ROUTE,
  IfindDiagnosticRepository,
  IfindDiagnosticRepositoryError
}

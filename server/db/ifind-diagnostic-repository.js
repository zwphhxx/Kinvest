const { DatabaseSync } = require('node:sqlite')
const { types } = require('node:util')
const {
  isPersistableFailureMetadata,
  isSafeErrorClass
} = require('../contracts/ifind-diagnostic-errors')
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
const DAY_KEY_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const AUTH_STATUSES = new Set(['success', 'failed', 'unknown'])
const PROBE_STATUSES = new Set(['success', 'failed', 'not_run'])
const COMPLETENESS_VALUES = new Set(['complete', 'partial', 'unavailable'])

const LEGACY_RUN_COLUMNS = [
  ['diagnostic_id', 'TEXT', 1, 1],
  ['started_at', 'INTEGER', 1, 0],
  ['completed_at', 'INTEGER', 0, 0],
  ['auth_status', 'TEXT', 0, 0],
  ['probe_status', 'TEXT', 0, 0],
  ['safe_error_class', 'TEXT', 0, 0],
  ['route', 'TEXT', 0, 0],
  ['request_count', 'INTEGER', 0, 0],
  ['data_vol', 'INTEGER', 0, 0],
  ['elapsed_ms', 'INTEGER', 0, 0],
  ['completeness', 'TEXT', 0, 0],
  ['token_version_id', 'TEXT', 1, 0]
]
const RUN_COLUMNS = [
  ...LEGACY_RUN_COLUMNS,
  ['failure_code', 'TEXT', 0, 0],
  ['vendor_error_code', 'INTEGER', 0, 0]
]
const CONTROL_COLUMNS = [
  ['singleton_id', 'INTEGER', 1, 1],
  ['day_key', 'TEXT', 1, 0],
  ['daily_attempt_count', 'INTEGER', 1, 0],
  ['cooldown_until', 'INTEGER', 0, 0],
  ['in_flight_id', 'TEXT', 0, 0],
  ['in_flight_started_at', 'INTEGER', 0, 0],
  ['in_flight_expires_at', 'INTEGER', 0, 0],
  ['in_flight_token_version_id', 'TEXT', 0, 0]
]
const LEGACY_RUN_DDL = `
  CREATE TABLE ifind_diagnostic_runs (
    diagnostic_id TEXT PRIMARY KEY NOT NULL,
    started_at INTEGER NOT NULL CHECK (started_at >= 0),
    completed_at INTEGER,
    auth_status TEXT CHECK (auth_status IS NULL OR auth_status IN ('success', 'failed', 'unknown')),
    probe_status TEXT CHECK (probe_status IS NULL OR probe_status IN ('success', 'failed', 'not_run')),
    safe_error_class TEXT CHECK (safe_error_class IS NULL OR safe_error_class IN ('AUTH', 'PERMISSION', 'QUOTA', 'NETWORK', 'API', 'CONFIG', 'BUSY', 'RATE_LIMITED')),
    route TEXT CHECK (route IS NULL OR route = '/api/v1/get_trade_dates'),
    request_count INTEGER CHECK (request_count IS NULL OR request_count BETWEEN 0 AND 4),
    data_vol INTEGER CHECK (data_vol IS NULL OR data_vol >= 0),
    elapsed_ms INTEGER CHECK (elapsed_ms IS NULL OR elapsed_ms >= 0),
    completeness TEXT CHECK (completeness IS NULL OR completeness IN ('complete', 'partial', 'unavailable')),
    token_version_id TEXT NOT NULL,
    CHECK (
      (completed_at IS NULL AND auth_status IS NULL AND probe_status IS NULL
        AND safe_error_class IS NULL AND route IS NULL
        AND request_count IS NULL AND data_vol IS NULL
        AND elapsed_ms IS NULL AND completeness IS NULL)
      OR
      (completed_at IS NOT NULL AND auth_status IS NOT NULL
        AND probe_status IS NOT NULL AND route IS NOT NULL
        AND request_count IS NOT NULL AND elapsed_ms IS NOT NULL
        AND completeness IS NOT NULL)
    ),
    CHECK (completed_at IS NULL OR completed_at >= started_at)
  )
`
const LEGACY_CONTROL_DDL = `
  CREATE TABLE ifind_diagnostic_control (
    singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
    day_key TEXT NOT NULL,
    daily_attempt_count INTEGER NOT NULL CHECK (daily_attempt_count BETWEEN 0 AND 20),
    cooldown_until INTEGER CHECK (cooldown_until IS NULL OR cooldown_until >= 0),
    in_flight_id TEXT,
    in_flight_started_at INTEGER,
    in_flight_expires_at INTEGER,
    in_flight_token_version_id TEXT,
    CHECK (
      (in_flight_id IS NULL AND in_flight_started_at IS NULL
        AND in_flight_expires_at IS NULL AND in_flight_token_version_id IS NULL)
      OR
      (in_flight_id IS NOT NULL AND in_flight_started_at IS NOT NULL
        AND in_flight_expires_at IS NOT NULL AND in_flight_token_version_id IS NOT NULL)
    ),
    CHECK (in_flight_expires_at IS NULL OR in_flight_expires_at > in_flight_started_at)
  )
`

class IfindDiagnosticRepositoryError extends Error {
  constructor() {
    super('The iFinD diagnostic repository input is invalid')
    this.name = 'IfindDiagnosticRepositoryError'
    this.code = 'IFIND_DIAGNOSTIC_REPOSITORY_INVALID'
  }
}

class IfindDiagnosticRepositorySchemaError extends Error {
  constructor() {
    super('The iFinD diagnostic repository schema is incompatible')
    this.name = 'IfindDiagnosticRepositorySchemaError'
    this.code = 'IFIND_DIAGNOSTIC_SCHEMA_INCOMPATIBLE'
  }
}

function failInput() {
  throw new IfindDiagnosticRepositoryError()
}

function failSchema() {
  throw new IfindDiagnosticRepositorySchemaError()
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
    failureCode: row.failure_code,
    vendorErrorCode: row.vendor_error_code,
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
    'diagnosticId', 'startedAt', 'tokenVersionId'
  ])
  if (!value) failInput()
  validateDiagnosticId(value.diagnosticId)
  if (!isTimestamp(value.startedAt)) failInput()
  validateVersionId(value.tokenVersionId)
  return value
}

function validateReservation(value) {
  const reservation = snapshotExactDataObject(value, [
    'diagnosticId', 'startedAt', 'tokenVersionId', 'inFlightExpiresAt'
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
    'completedAt', 'authStatus', 'probeStatus', 'safeErrorClass', 'route',
    'requestCount', 'dataVol', 'elapsedMs', 'completeness', 'failureCode',
    'vendorErrorCode'
  ])
  if (!result || !isTimestamp(result.completedAt) ||
      !AUTH_STATUSES.has(result.authStatus) ||
      !PROBE_STATUSES.has(result.probeStatus) ||
      (result.safeErrorClass !== null && !isSafeErrorClass(result.safeErrorClass)) ||
      result.route !== IFIND_DIAGNOSTIC_ROUTE ||
      !Number.isSafeInteger(result.requestCount) || result.requestCount < 0 ||
      result.requestCount > 4 ||
      (result.dataVol !== null && !isNonNegativeInteger(result.dataVol)) ||
      !isNonNegativeInteger(result.elapsedMs) ||
      !COMPLETENESS_VALUES.has(result.completeness)) failInput()
  if (result.authStatus === 'success' && result.probeStatus === 'success') {
    if (result.safeErrorClass !== null || result.failureCode !== null ||
        result.vendorErrorCode !== null || result.completeness === 'unavailable') failInput()
  } else if (result.safeErrorClass === null || !isPersistableFailureMetadata({
    failureCode: result.failureCode,
    errorClass: result.safeErrorClass,
    vendorErrorCode: result.vendorErrorCode
  })) {
    failInput()
  }
  return result
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
  return !inString && normalized.endsWith(';')
    ? normalized.slice(0, -1)
    : normalized
}

function validateLegacySchemaForMigration(database) {
  validateSchema(database, LEGACY_RUN_COLUMNS)
  const rows = database.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'ifind_diagnostic_runs', 'ifind_diagnostic_control'
    )
  `).all()
  const sqlByName = new Map(rows.map((row) => [row.name, normalizeSql(row.sql)]))
  if (sqlByName.get('ifind_diagnostic_runs') !== normalizeSql(LEGACY_RUN_DDL) ||
      sqlByName.get('ifind_diagnostic_control') !== normalizeSql(LEGACY_CONTROL_DDL)) {
    failSchema()
  }
}

function validateNoDiagnosticTriggers(database) {
  const triggers = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name IN (
      'ifind_diagnostic_runs', 'ifind_diagnostic_control'
    )
    UNION ALL
    SELECT name FROM sqlite_temp_master
    WHERE type = 'trigger' AND tbl_name IN (
      'ifind_diagnostic_runs', 'ifind_diagnostic_control'
    )
  `).all()
  if (triggers.length !== 0) failSchema()
}

function validateSchema(database, expectedRunColumns = RUN_COLUMNS) {
  if (JSON.stringify(normalizedColumns(database, 'ifind_diagnostic_runs')) !==
      JSON.stringify(expectedRunColumns)) failSchema()
  if (JSON.stringify(normalizedColumns(database, 'ifind_diagnostic_control')) !==
      JSON.stringify(CONTROL_COLUMNS)) failSchema()

  const runIndexes = database.prepare('PRAGMA index_list(ifind_diagnostic_runs)').all()
  if (runIndexes.length !== 1 || runIndexes[0].unique !== 1 ||
      runIndexes[0].origin !== 'pk' || runIndexes[0].partial !== 0) failSchema()
  const runIndexColumns = database.prepare(
    `PRAGMA index_info(${runIndexes[0].name})`
  ).all()
  if (runIndexColumns.length !== 1 || runIndexColumns[0].name !== 'diagnostic_id') {
    failSchema()
  }
  if (database.prepare('PRAGMA index_list(ifind_diagnostic_control)').all().length !== 0) {
    failSchema()
  }

  const rows = database.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'ifind_diagnostic_runs', 'ifind_diagnostic_control'
    )
  `).all()
  const sqlByName = new Map(rows.map((row) => [row.name, normalizeSql(row.sql)]))
  const runSql = sqlByName.get('ifind_diagnostic_runs') || ''
  const controlSql = sqlByName.get('ifind_diagnostic_control') || ''
  for (const fragment of [
    'check(started_at>=0)',
    "check(routeisnullorroute='/api/v1/get_trade_dates')",
    'check(request_countisnullorrequest_countbetween0and4)',
    'check((completed_atisnullandauth_statusisnull',
    'or(completed_atisnotnullandauth_statusisnotnull'
  ]) {
    if (!runSql.includes(fragment)) failSchema()
  }
  for (const fragment of [
    'check(singleton_id=1)',
    'check(daily_attempt_countbetween0and20)',
    'check((in_flight_idisnullandin_flight_started_atisnull',
    'or(in_flight_idisnotnullandin_flight_started_atisnotnull'
  ]) {
    if (!controlSql.includes(fragment)) failSchema()
  }
}

function runsEqual(row, reservation, result) {
  return row.diagnostic_id === reservation.diagnosticId &&
    row.started_at === reservation.startedAt &&
    row.completed_at === result.completedAt &&
    row.auth_status === result.authStatus &&
    row.probe_status === result.probeStatus &&
    row.safe_error_class === result.safeErrorClass &&
    row.failure_code === result.failureCode &&
    row.vendor_error_code === result.vendorErrorCode &&
    row.route === result.route &&
    row.request_count === result.requestCount &&
    row.data_vol === result.dataVol &&
    row.elapsed_ms === result.elapsedMs &&
    row.completeness === result.completeness &&
    row.token_version_id === reservation.tokenVersionId
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
      try { this.database.exec('ROLLBACK') } catch {
        // Best-effort defensive cleanup must not replace the stable result.
      }
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
          diagnostic_id TEXT PRIMARY KEY NOT NULL,
          started_at INTEGER NOT NULL CHECK (started_at >= 0),
          completed_at INTEGER,
          auth_status TEXT CHECK (auth_status IS NULL OR auth_status IN ('success', 'failed', 'unknown')),
          probe_status TEXT CHECK (probe_status IS NULL OR probe_status IN ('success', 'failed', 'not_run')),
          safe_error_class TEXT CHECK (safe_error_class IS NULL OR safe_error_class IN ('AUTH', 'PERMISSION', 'QUOTA', 'NETWORK', 'API', 'CONFIG', 'BUSY', 'RATE_LIMITED')),
          route TEXT CHECK (route IS NULL OR route = '/api/v1/get_trade_dates'),
          request_count INTEGER CHECK (request_count IS NULL OR request_count BETWEEN 0 AND 4),
          data_vol INTEGER CHECK (data_vol IS NULL OR data_vol >= 0),
          elapsed_ms INTEGER CHECK (elapsed_ms IS NULL OR elapsed_ms >= 0),
          completeness TEXT CHECK (completeness IS NULL OR completeness IN ('complete', 'partial', 'unavailable')),
          token_version_id TEXT NOT NULL,
          failure_code TEXT,
          vendor_error_code INTEGER,
          CHECK (
            (completed_at IS NULL AND auth_status IS NULL AND probe_status IS NULL
              AND safe_error_class IS NULL AND route IS NULL
              AND request_count IS NULL AND data_vol IS NULL
              AND elapsed_ms IS NULL AND completeness IS NULL
              AND failure_code IS NULL AND vendor_error_code IS NULL)
            OR
            (completed_at IS NOT NULL AND auth_status IS NOT NULL
              AND probe_status IS NOT NULL AND route IS NOT NULL
              AND request_count IS NOT NULL AND elapsed_ms IS NOT NULL
              AND completeness IS NOT NULL)
          ),
          CHECK (completed_at IS NULL OR completed_at >= started_at)
        );

        CREATE TABLE IF NOT EXISTS ifind_diagnostic_control (
          singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
          day_key TEXT NOT NULL,
          daily_attempt_count INTEGER NOT NULL CHECK (daily_attempt_count BETWEEN 0 AND 20),
          cooldown_until INTEGER CHECK (cooldown_until IS NULL OR cooldown_until >= 0),
          in_flight_id TEXT,
          in_flight_started_at INTEGER,
          in_flight_expires_at INTEGER,
          in_flight_token_version_id TEXT,
          CHECK (
            (in_flight_id IS NULL AND in_flight_started_at IS NULL
              AND in_flight_expires_at IS NULL
              AND in_flight_token_version_id IS NULL)
            OR
            (in_flight_id IS NOT NULL AND in_flight_started_at IS NOT NULL
              AND in_flight_expires_at IS NOT NULL
              AND in_flight_token_version_id IS NOT NULL)
          ),
          CHECK (in_flight_expires_at IS NULL OR in_flight_expires_at > in_flight_started_at)
        );

      `)
      validateNoDiagnosticTriggers(this.database)
      const runColumns = normalizedColumns(this.database, 'ifind_diagnostic_runs')
      if (JSON.stringify(runColumns) === JSON.stringify(LEGACY_RUN_COLUMNS)) {
        validateLegacySchemaForMigration(this.database)
        this.database.exec(`
          ALTER TABLE ifind_diagnostic_runs ADD COLUMN failure_code TEXT;
          ALTER TABLE ifind_diagnostic_runs ADD COLUMN vendor_error_code INTEGER;
          UPDATE ifind_diagnostic_runs
          SET failure_code = 'IFIND_LEGACY_DIAGNOSTIC_FAILURE'
          WHERE completed_at IS NOT NULL
            AND NOT (auth_status = 'success' AND probe_status = 'success');
        `)
      }
      validateSchema(this.database)
      validateNoDiagnosticTriggers(this.database)
      this.database.prepare(`
        INSERT INTO ifind_diagnostic_control (
          singleton_id, day_key, daily_attempt_count, cooldown_until,
          in_flight_id, in_flight_started_at, in_flight_expires_at,
          in_flight_token_version_id
        ) VALUES (1, '', 0, NULL, NULL, NULL, NULL, NULL)
        ON CONFLICT(singleton_id) DO NOTHING
      `).run()
      const controls = this.database.prepare(
        'SELECT singleton_id FROM ifind_diagnostic_control'
      ).all()
      if (controls.length !== 1 || controls[0].singleton_id !== 1) failSchema()
    })
  }

  readControl() {
    return this.database.prepare(`
      SELECT day_key, daily_attempt_count, cooldown_until, in_flight_id,
             in_flight_started_at, in_flight_expires_at,
             in_flight_token_version_id
      FROM ifind_diagnostic_control WHERE singleton_id = 1
    `).get()
  }

  readClaim(diagnosticId) {
    return this.database.prepare(`
      SELECT diagnostic_id, started_at, completed_at, auth_status, probe_status,
             safe_error_class, route, request_count, data_vol, elapsed_ms,
             completeness, token_version_id, failure_code, vendor_error_code
      FROM ifind_diagnostic_runs WHERE diagnostic_id = ?
    `).get(diagnosticId)
  }

  abandonStale(control, completedAt) {
    const startedAt = control.in_flight_started_at
    const update = this.database.prepare(`
      UPDATE ifind_diagnostic_runs
      SET completed_at = ?, auth_status = 'unknown', probe_status = 'not_run',
          safe_error_class = 'CONFIG', route = ?, request_count = 0,
          data_vol = NULL, elapsed_ms = ?, completeness = 'unavailable',
          failure_code = 'IFIND_DIAGNOSTIC_STALE_RESERVATION',
          vendor_error_code = NULL
      WHERE diagnostic_id = ? AND started_at = ? AND token_version_id = ?
        AND completed_at IS NULL
    `).run(
      completedAt,
      IFIND_DIAGNOSTIC_ROUTE,
      Math.max(0, completedAt - startedAt),
      control.in_flight_id,
      startedAt,
      control.in_flight_token_version_id
    )
    if (update.changes !== 1) failSchema()
    const release = this.database.prepare(`
      UPDATE ifind_diagnostic_control
      SET cooldown_until = ?, in_flight_id = NULL,
          in_flight_started_at = NULL, in_flight_expires_at = NULL,
          in_flight_token_version_id = NULL
      WHERE singleton_id = 1 AND in_flight_id = ?
    `).run(completedAt + IFIND_DIAGNOSTIC_COOLDOWN_MS, control.in_flight_id)
    if (release.changes !== 1) failSchema()
  }

  reserve(input) {
    const request = validateReservationInput(input)
    const incomingDayKey = shanghaiDayKey(request.startedAt)
    return this.withImmediateTransaction(() => {
      let control = this.readControl()
      if (!control || !DAY_KEY_PATTERN.test(control.day_key || incomingDayKey)) failSchema()

      if (control.day_key !== '' && incomingDayKey < control.day_key) {
        return {
          status: 'clock-rollback',
          localDayKey: control.day_key,
          localAttemptCount: control.daily_attempt_count
        }
      }

      if (this.readClaim(request.diagnosticId)) {
        return {
          status: 'duplicate',
          localDayKey: control.day_key || incomingDayKey,
          localAttemptCount: control.daily_attempt_count
        }
      }

      if (control.in_flight_id !== null &&
          request.startedAt >= control.in_flight_expires_at) {
        this.abandonStale(control, request.startedAt)
        control = this.readControl()
      }

      if (control.day_key === '' || incomingDayKey > control.day_key) {
        this.database.prepare(`
          UPDATE ifind_diagnostic_control
          SET day_key = ?, daily_attempt_count = 0
          WHERE singleton_id = 1
        `).run(incomingDayKey)
        control = this.readControl()
      }

      if (control.in_flight_id !== null) {
        return {
          status: 'busy',
          retryAt: control.in_flight_expires_at,
          localDayKey: control.day_key,
          localAttemptCount: control.daily_attempt_count
        }
      }
      if (control.cooldown_until !== null && request.startedAt < control.cooldown_until) {
        return {
          status: 'cooldown',
          retryAt: control.cooldown_until,
          localDayKey: control.day_key,
          localAttemptCount: control.daily_attempt_count
        }
      }
      if (control.daily_attempt_count >= IFIND_DIAGNOSTIC_DAILY_LIMIT) {
        return {
          status: 'daily-limit',
          retryAt: nextShanghaiDayStart(control.day_key),
          localDayKey: control.day_key,
          localAttemptCount: control.daily_attempt_count
        }
      }

      const claim = this.database.prepare(`
        INSERT INTO ifind_diagnostic_runs (
          diagnostic_id, started_at, token_version_id
        ) VALUES (?, ?, ?)
        ON CONFLICT(diagnostic_id) DO NOTHING
      `).run(request.diagnosticId, request.startedAt, request.tokenVersionId)
      if (claim.changes !== 1) {
        return {
          status: 'duplicate',
          localDayKey: control.day_key,
          localAttemptCount: control.daily_attempt_count
        }
      }

      const inFlightExpiresAt = request.startedAt + IFIND_DIAGNOSTIC_LEASE_MS
      const update = this.database.prepare(`
        UPDATE ifind_diagnostic_control
        SET daily_attempt_count = daily_attempt_count + 1,
            cooldown_until = NULL, in_flight_id = ?, in_flight_started_at = ?,
            in_flight_expires_at = ?, in_flight_token_version_id = ?
        WHERE singleton_id = 1 AND in_flight_id IS NULL
      `).run(
        request.diagnosticId,
        request.startedAt,
        inFlightExpiresAt,
        request.tokenVersionId
      )
      if (update.changes !== 1) failSchema()
      return {
        status: 'reserved',
        reservation: {
          diagnosticId: request.diagnosticId,
          startedAt: request.startedAt,
          tokenVersionId: request.tokenVersionId,
          inFlightExpiresAt
        },
        localDayKey: control.day_key,
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
      const row = this.readClaim(reservation.diagnosticId)
      if (!row || row.started_at !== reservation.startedAt ||
          row.token_version_id !== reservation.tokenVersionId) {
        return { status: 'not-found' }
      }
      if (row.completed_at !== null) {
        return runsEqual(row, reservation, result)
          ? {
              status: 'completed',
              cooldownUntil: result.completedAt + IFIND_DIAGNOSTIC_COOLDOWN_MS
            }
          : { status: 'conflict' }
      }

      const control = this.readControl()
      if (!control || control.in_flight_id !== reservation.diagnosticId ||
          control.in_flight_started_at !== reservation.startedAt ||
          control.in_flight_expires_at !== reservation.inFlightExpiresAt ||
          control.in_flight_token_version_id !== reservation.tokenVersionId) {
        return { status: 'not-found' }
      }

      const update = this.database.prepare(`
        UPDATE ifind_diagnostic_runs
        SET completed_at = ?, auth_status = ?, probe_status = ?,
            safe_error_class = ?, route = ?, request_count = ?, data_vol = ?,
            elapsed_ms = ?, completeness = ?, failure_code = ?,
            vendor_error_code = ?
        WHERE diagnostic_id = ? AND completed_at IS NULL
      `).run(
        result.completedAt,
        result.authStatus,
        result.probeStatus,
        result.safeErrorClass,
        result.route,
        result.requestCount,
        result.dataVol,
        result.elapsedMs,
        result.completeness,
        result.failureCode,
        result.vendorErrorCode,
        reservation.diagnosticId
      )
      if (update.changes !== 1) failSchema()
      const cooldownUntil = result.completedAt + IFIND_DIAGNOSTIC_COOLDOWN_MS
      const release = this.database.prepare(`
        UPDATE ifind_diagnostic_control
        SET cooldown_until = ?, in_flight_id = NULL,
            in_flight_started_at = NULL, in_flight_expires_at = NULL,
            in_flight_token_version_id = NULL
        WHERE singleton_id = 1 AND in_flight_id = ?
      `).run(cooldownUntil, reservation.diagnosticId)
      if (release.changes !== 1) failSchema()
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
             completeness, token_version_id, failure_code, vendor_error_code
      FROM ifind_diagnostic_runs
      WHERE completed_at IS NOT NULL
      ORDER BY completed_at DESC, diagnostic_id DESC LIMIT ?
    `).all(limit).map(mapRun)
  }

  latest() {
    return mapRun(this.database.prepare(`
      SELECT diagnostic_id, started_at, completed_at, auth_status, probe_status,
             safe_error_class, route, request_count, data_vol, elapsed_ms,
             completeness, token_version_id, failure_code, vendor_error_code
      FROM ifind_diagnostic_runs
      WHERE completed_at IS NOT NULL
      ORDER BY completed_at DESC, diagnostic_id DESC LIMIT 1
    `).get())
  }

  status(now) {
    if (!isTimestamp(now)) failInput()
    const control = this.readControl()
    if (!control) failSchema()
    const incomingDayKey = shanghaiDayKey(now)
    const sameOrLaterDay = control.day_key === '' || incomingDayKey >= control.day_key
    const displayedDayKey = sameOrLaterDay ? incomingDayKey : control.day_key
    const sameDay = control.day_key === incomingDayKey
    const activeInFlight = control.in_flight_id !== null &&
      control.in_flight_expires_at !== null && now < control.in_flight_expires_at
    return {
      localDayKey: displayedDayKey,
      localAttemptCount: incomingDayKey < control.day_key || sameDay
        ? control.daily_attempt_count
        : 0,
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
  IfindDiagnosticRepositoryError,
  IfindDiagnosticRepositorySchemaError
}

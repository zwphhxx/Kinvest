const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const VERSION_ID = 'v20260826-001'
const ROUTE = '/api/v1/get_trade_dates'

/** @returns {Record<string, any>} */
function errorRecord(error) {
  return error !== null && typeof error === 'object'
    ? /** @type {Record<string, any>} */ (error)
    : Object.create(null)
}

function diagnosticId(number) {
  return `diag_${String(number).padStart(24, '0')}`
}

function terminalResult(overrides = {}) {
  return {
    completedAt: 1_777_777_777_010,
    authStatus: 'success',
    probeStatus: 'success',
    safeErrorClass: null,
    failureCode: null,
    vendorErrorCode: null,
    route: ROUTE,
    requestCount: 2,
    dataVol: 11,
    elapsedMs: 10,
    completeness: 'complete',
    ...overrides
  }
}

function createRepository(database) {
  const { IfindDiagnosticRepository } = require('../db/ifind-diagnostic-repository')
  const repository = new IfindDiagnosticRepository(database)
  repository.initialize()
  return repository
}

async function run() {
  const {
    IFIND_DIAGNOSTIC_LEASE_MS,
    IfindDiagnosticRepository,
    IfindDiagnosticRepositoryError,
    IfindDiagnosticRepositorySchemaError
  } = require('../db/ifind-diagnostic-repository')
  const {
    KINVEST_SQLITE_APPLICATION_ID
  } = require('../db/database-identity')

  assert.equal(IFIND_DIAGNOSTIC_LEASE_MS > 0, true)
  assert.equal(IFIND_DIAGNOSTIC_LEASE_MS <= 5 * 60 * 1000, true)

  const identityDatabase = new DatabaseSync(':memory:')
  identityDatabase.exec('CREATE TABLE existing_data (value TEXT)')
  const identityRepository = createRepository(identityDatabase)
  assert.equal(
    Number(identityDatabase.prepare('PRAGMA application_id').get().application_id),
    KINVEST_SQLITE_APPLICATION_ID
  )
  assert.equal(
    identityDatabase.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'existing_data'").get().count,
    1
  )
  assert.deepEqual(
    identityDatabase.prepare('PRAGMA table_info(ifind_diagnostic_runs)').all().map((row) => row.name),
    [
      'diagnostic_id',
      'started_at',
      'completed_at',
      'auth_status',
      'probe_status',
      'safe_error_class',
      'route',
      'request_count',
      'data_vol',
      'elapsed_ms',
      'completeness',
      'token_version_id',
      'failure_code',
      'vendor_error_code'
    ]
  )
  assert.deepEqual(
    identityDatabase.prepare('PRAGMA table_info(ifind_diagnostic_control)').all().map((row) => row.name),
    [
      'singleton_id',
      'day_key',
      'daily_attempt_count',
      'cooldown_until',
      'in_flight_id',
      'in_flight_started_at',
      'in_flight_expires_at',
      'in_flight_token_version_id'
    ]
  )
  const runColumns = identityDatabase.prepare(
    'PRAGMA table_info(ifind_diagnostic_runs)'
  ).all()
  assert.equal(runColumns.find((row) => row.name === 'started_at').notnull, 1)
  assert.equal(runColumns.find((row) => row.name === 'completed_at').notnull, 0)
  assert.deepEqual(
    identityDatabase.prepare('PRAGMA index_list(ifind_diagnostic_runs)').all().map((row) => ({
      unique: row.unique,
      origin: row.origin,
      partial: row.partial
    })),
    [{ unique: 1, origin: 'pk', partial: 0 }]
  )
  identityRepository.initialize()
  assert.equal(identityDatabase.prepare('SELECT COUNT(*) AS count FROM ifind_diagnostic_control').get().count, 1)
  identityDatabase.close()

  const legacyDatabase = new DatabaseSync(':memory:')
  legacyDatabase.exec(`
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
    );
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
    );
    INSERT INTO ifind_diagnostic_runs (
      diagnostic_id, started_at, token_version_id
    ) VALUES ('diag_000000000000000000000777', 1777777777000, '${VERSION_ID}');
    INSERT INTO ifind_diagnostic_runs (
      diagnostic_id, started_at, completed_at, auth_status, probe_status,
      safe_error_class, route, request_count, data_vol, elapsed_ms,
      completeness, token_version_id
    ) VALUES (
      'diag_000000000000000000000778', 1777777777000, 1777777777010,
      'success', 'failed', 'API', '${ROUTE}', 2, NULL, 10,
      'unavailable', '${VERSION_ID}'
    );
    INSERT INTO ifind_diagnostic_runs (
      diagnostic_id, started_at, completed_at, auth_status, probe_status,
      safe_error_class, route, request_count, data_vol, elapsed_ms,
      completeness, token_version_id
    ) VALUES (
      'diag_000000000000000000000779', 1777777777000, 1777777777005,
      'success', 'success', NULL, '${ROUTE}', 2, 11, 5,
      'complete', '${VERSION_ID}'
    );
  `)
  const legacyRepository = createRepository(legacyDatabase)
  assert.deepEqual(
    legacyDatabase.prepare('PRAGMA table_info(ifind_diagnostic_runs)').all().map((row) => row.name),
    [
      'diagnostic_id', 'started_at', 'completed_at', 'auth_status',
      'probe_status', 'safe_error_class', 'route', 'request_count', 'data_vol',
      'elapsed_ms', 'completeness', 'token_version_id', 'failure_code',
      'vendor_error_code'
    ]
  )
  const migratedPending = legacyDatabase.prepare(`
    SELECT failure_code, vendor_error_code FROM ifind_diagnostic_runs
    WHERE diagnostic_id = 'diag_000000000000000000000777'
  `).get()
  assert.equal(migratedPending.failure_code, null)
  assert.equal(migratedPending.vendor_error_code, null)
  const migratedSuccess = legacyDatabase.prepare(`
    SELECT failure_code, vendor_error_code FROM ifind_diagnostic_runs
    WHERE diagnostic_id = 'diag_000000000000000000000779'
  `).get()
  assert.equal(migratedSuccess.failure_code, null)
  assert.equal(migratedSuccess.vendor_error_code, null)
  assert.deepEqual(legacyRepository.latest(), {
    diagnosticId: 'diag_000000000000000000000778',
    startedAt: 1777777777000,
    completedAt: 1777777777010,
    authStatus: 'success',
    probeStatus: 'failed',
    safeErrorClass: 'API',
    failureCode: 'IFIND_LEGACY_DIAGNOSTIC_FAILURE',
    vendorErrorCode: null,
    route: ROUTE,
    requestCount: 2,
    dataVol: null,
    elapsedMs: 10,
    completeness: 'unavailable',
    tokenVersionId: VERSION_ID
  })
  legacyDatabase.close()

  const wrongIdentity = new DatabaseSync(':memory:')
  wrongIdentity.exec('PRAGMA application_id = 1234')
  assert.throws(
    () => new IfindDiagnosticRepository(wrongIdentity).initialize(),
    (/**  {any} */ error) => errorRecord(error).code === 'DEVICE_AUTH_DATABASE_IDENTITY_INVALID'
  )
  assert.equal(
    wrongIdentity.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'ifind_diagnostic_%'").get().count,
    0
  )
  wrongIdentity.close()

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-ifind-diagnostic-'))
  const databasePath = path.join(directory, 'diagnostics.sqlite')
  const firstDatabase = new DatabaseSync(databasePath)
  const secondDatabase = new DatabaseSync(databasePath)
  try {
    const first = createRepository(firstDatabase)
    const second = createRepository(secondDatabase)
    const startedAt = Date.parse('2026-08-26T02:00:00.000Z')
    const firstReservation = first.reserve({
      diagnosticId: diagnosticId(1),
      startedAt,
      tokenVersionId: VERSION_ID
    })
    assert.deepEqual(firstReservation, {
      status: 'reserved',
      reservation: {
        diagnosticId: diagnosticId(1),
        startedAt,
        tokenVersionId: VERSION_ID,
        inFlightExpiresAt: startedAt + IFIND_DIAGNOSTIC_LEASE_MS
      },
      localDayKey: '2026-08-26',
      localAttemptCount: 1
    })
    assert.deepEqual(second.reserve({
      diagnosticId: diagnosticId(1),
      startedAt: startedAt + 1,
      tokenVersionId: VERSION_ID
    }), {
      status: 'duplicate',
      localDayKey: '2026-08-26',
      localAttemptCount: 1
    })
    assert.deepEqual(first.status(startedAt + 1), {
      localDayKey: '2026-08-26',
      localAttemptCount: 1,
      cooldownUntil: null,
      inFlight: true,
      inFlightExpiresAt: startedAt + IFIND_DIAGNOSTIC_LEASE_MS
    })
    assert.equal(firstDatabase.prepare(`
      SELECT COUNT(*) AS count
      FROM ifind_diagnostic_runs
      WHERE diagnostic_id = ? AND completed_at IS NULL
    `).get(diagnosticId(1)).count, 1)
    const busy = second.reserve({
      diagnosticId: diagnosticId(2),
      startedAt: startedAt + 1,
      tokenVersionId: VERSION_ID
    })
    assert.deepEqual(busy, {
      status: 'busy',
      retryAt: startedAt + IFIND_DIAGNOSTIC_LEASE_MS,
      localDayKey: '2026-08-26',
      localAttemptCount: 1
    })

    const completed = second.complete({
      reservation: firstReservation.reservation,
      result: terminalResult({ completedAt: startedAt + 10 })
    })
    assert.deepEqual(completed, {
      status: 'completed',
      cooldownUntil: startedAt + 10 + 60_000
    })
    assert.deepEqual(second.complete({
      reservation: firstReservation.reservation,
      result: terminalResult({ completedAt: startedAt + 10 })
    }), completed)
    assert.deepEqual(first.complete({
      reservation: firstReservation.reservation,
      result: terminalResult({ completedAt: startedAt + 11 })
    }), { status: 'conflict' })
    assert.deepEqual(first.reserve({
      diagnosticId: diagnosticId(3),
      startedAt: startedAt + 60_009,
      tokenVersionId: VERSION_ID
    }), {
      status: 'cooldown',
      retryAt: startedAt + 60_010,
      localDayKey: '2026-08-26',
      localAttemptCount: 1
    })

    const latest = first.latest()
    assert.deepEqual(latest, {
      diagnosticId: diagnosticId(1),
      startedAt,
      completedAt: startedAt + 10,
      authStatus: 'success',
      probeStatus: 'success',
      safeErrorClass: null,
      route: ROUTE,
      requestCount: 2,
      dataVol: 11,
      elapsedMs: 10,
      completeness: 'complete',
      tokenVersionId: VERSION_ID,
      failureCode: null,
      vendorErrorCode: null
    })
    latest.authStatus = 'failed'
    assert.equal(first.latest().authStatus, 'success')
    assert.equal(Object.getPrototypeOf(first.latest()), Object.prototype)
    assert.equal(Object.getPrototypeOf(first.list()[0]), Object.prototype)
    assert.equal(firstDatabase.prepare('SELECT 1 AS value').get().value, 1)

    firstDatabase.exec('BEGIN IMMEDIATE')
    secondDatabase.exec('PRAGMA busy_timeout = 25')
    const lockStartedAt = Date.now()
    assert.throws(
      () => second.reserve({
        diagnosticId: diagnosticId(90),
        startedAt: startedAt + 120_000,
        tokenVersionId: VERSION_ID
      }),
      (/**  {any} */ error) => errorRecord(error).code === 'ERR_SQLITE_ERROR' && /locked|busy/i.test(errorRecord(error).message)
    )
    assert.equal(Date.now() - lockStartedAt < 1000, true)
    firstDatabase.exec('ROLLBACK')
    const afterLock = second.reserve({
      diagnosticId: diagnosticId(90),
      startedAt: startedAt + 120_000,
      tokenVersionId: VERSION_ID
    })
    assert.equal(afterLock.status, 'reserved')
    assert.equal(firstDatabase.prepare(`
      SELECT COUNT(*) AS count FROM ifind_diagnostic_runs
      WHERE diagnostic_id = ?
    `).get(diagnosticId(90)).count, 1)

    for (const unsafe of [
      { diagnosticId: diagnosticId(4), startedAt, tokenVersionId: VERSION_ID, token: 'secret' },
      { diagnosticId: diagnosticId(4), startedAt, tokenVersionId: 'current' },
      { diagnosticId: 'short', startedAt, tokenVersionId: VERSION_ID },
      { diagnosticId: diagnosticId(4), startedAt: -1, tokenVersionId: VERSION_ID }
    ]) {
      assert.throws(() => first.reserve(unsafe), IfindDiagnosticRepositoryError)
    }
    for (const key of ['rawResponse', 'headers', 'RequestId', 'refreshToken', 'fingerprint']) {
      assert.throws(() => second.complete({
        reservation: firstReservation.reservation,
        result: { ...terminalResult(), [key]: 'sensitive-marker' }
      }), IfindDiagnosticRepositoryError)
    }
    for (const invalidFailure of [
      terminalResult({
        authStatus: 'success',
        probeStatus: 'failed',
        safeErrorClass: 'AUTH',
        failureCode: 'IFIND_PROBE_REJECTED',
        vendorErrorCode: -999,
        dataVol: null,
        completeness: 'unavailable'
      }),
      terminalResult({
        authStatus: 'unknown',
        probeStatus: 'failed',
        safeErrorClass: 'NETWORK',
        failureCode: 'IFIND_NETWORK_FAILED',
        vendorErrorCode: -500,
        dataVol: null,
        completeness: 'unavailable'
      })
    ]) {
      assert.throws(() => second.complete({
        reservation: firstReservation.reservation,
        result: invalidFailure
      }), IfindDiagnosticRepositoryError)
    }
  } finally {
    firstDatabase.close()
    secondDatabase.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }

  const limitDatabase = new DatabaseSync(':memory:')
  const limitRepository = createRepository(limitDatabase)
  const dayStart = Date.parse('2026-08-25T16:00:00.000Z')
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const now = dayStart + attempt * 60_001
    const reservation = limitRepository.reserve({
      diagnosticId: diagnosticId(100 + attempt),
      startedAt: now,
      tokenVersionId: VERSION_ID
    })
    assert.equal(reservation.status, 'reserved')
    assert.equal(reservation.localAttemptCount, attempt + 1)
    assert.equal(limitRepository.fail({
      reservation: reservation.reservation,
      result: terminalResult({
        completedAt: now + 1,
        authStatus: 'failed',
        probeStatus: 'not_run',
        safeErrorClass: 'AUTH',
        failureCode: 'IFIND_AUTH_REJECTED',
        requestCount: 1,
        dataVol: null,
        elapsedMs: 1,
        completeness: 'unavailable'
      })
    }).status, 'completed')
  }
  const limitedAt = dayStart + 20 * 60_001
  assert.deepEqual(limitRepository.reserve({
    diagnosticId: diagnosticId(200),
    startedAt: limitedAt,
    tokenVersionId: VERSION_ID
  }), {
    status: 'daily-limit',
    retryAt: Date.parse('2026-08-26T16:00:00.000Z'),
    localDayKey: '2026-08-26',
    localAttemptCount: 20
  })
  const nextDay = Date.parse('2026-08-26T16:00:00.000Z')
  assert.equal(limitRepository.reserve({
    diagnosticId: diagnosticId(201),
    startedAt: nextDay,
    tokenVersionId: VERSION_ID
  }).localAttemptCount, 1)
  limitDatabase.close()

  const staleDatabase = new DatabaseSync(':memory:')
  const staleRepository = createRepository(staleDatabase)
  const staleStartedAt = Date.parse('2026-08-26T08:00:00.000Z')
  staleRepository.reserve({
    diagnosticId: diagnosticId(300),
    startedAt: staleStartedAt,
    tokenVersionId: VERSION_ID
  })
  const recovered = staleRepository.reserve({
    diagnosticId: diagnosticId(301),
    startedAt: staleStartedAt + IFIND_DIAGNOSTIC_LEASE_MS,
    tokenVersionId: VERSION_ID
  })
  assert.equal(recovered.status, 'cooldown')
  const repeatedRecovery = staleRepository.reserve({
    diagnosticId: diagnosticId(303),
    startedAt: staleStartedAt + IFIND_DIAGNOSTIC_LEASE_MS + 1,
    tokenVersionId: VERSION_ID
  })
  assert.equal(repeatedRecovery.status, 'cooldown')
  assert.equal(staleDatabase.prepare(`
    SELECT COUNT(*) AS count FROM ifind_diagnostic_runs
    WHERE diagnostic_id = ? AND completed_at IS NOT NULL
  `).get(diagnosticId(300)).count, 1)
  const staleRun = staleRepository.latest()
  assert.deepEqual(staleRun, {
    diagnosticId: diagnosticId(300),
    startedAt: staleStartedAt,
    completedAt: staleStartedAt + IFIND_DIAGNOSTIC_LEASE_MS,
    authStatus: 'unknown',
    probeStatus: 'not_run',
    safeErrorClass: 'CONFIG',
    failureCode: 'IFIND_DIAGNOSTIC_STALE_RESERVATION',
    vendorErrorCode: null,
    route: ROUTE,
    requestCount: 0,
    dataVol: null,
    elapsedMs: IFIND_DIAGNOSTIC_LEASE_MS,
    completeness: 'unavailable',
    tokenVersionId: VERSION_ID
  })
  const afterRecoveryCooldown = staleStartedAt + IFIND_DIAGNOSTIC_LEASE_MS + 60_000
  assert.equal(staleRepository.reserve({
    diagnosticId: diagnosticId(302),
    startedAt: afterRecoveryCooldown,
    tokenVersionId: VERSION_ID
  }).status, 'reserved')
  const status = staleRepository.status(afterRecoveryCooldown)
  assert.equal(Object.getPrototypeOf(status), Object.prototype)
  assert.deepEqual(status, {
    localDayKey: '2026-08-26',
    localAttemptCount: 2,
    cooldownUntil: null,
    inFlight: true,
    inFlightExpiresAt: afterRecoveryCooldown + IFIND_DIAGNOSTIC_LEASE_MS
  })
  staleDatabase.close()

  const rollbackDatabase = new DatabaseSync(':memory:')
  const rollbackRepository = createRepository(rollbackDatabase)
  const newerDay = Date.parse('2026-08-26T16:00:00.000Z')
  const newerReservation = rollbackRepository.reserve({
    diagnosticId: diagnosticId(400),
    startedAt: newerDay,
    tokenVersionId: VERSION_ID
  })
  rollbackRepository.fail({
    reservation: newerReservation.reservation,
    result: terminalResult({
      completedAt: newerDay + 1,
      authStatus: 'failed',
      probeStatus: 'not_run',
      safeErrorClass: 'AUTH',
      failureCode: 'IFIND_AUTH_REJECTED',
      requestCount: 1,
      dataVol: null,
      elapsedMs: 1,
      completeness: 'unavailable'
    })
  })
  const beforeRollback = rollbackRepository.status(newerDay + 1)
  assert.deepEqual(rollbackRepository.reserve({
    diagnosticId: diagnosticId(401),
    startedAt: newerDay - 1,
    tokenVersionId: VERSION_ID
  }), {
    status: 'clock-rollback',
    localDayKey: '2026-08-27',
    localAttemptCount: 1
  })
  assert.deepEqual(rollbackRepository.status(newerDay + 1), beforeRollback)
  assert.deepEqual(rollbackRepository.status(newerDay - 1), {
    localDayKey: '2026-08-27',
    localAttemptCount: 1,
    cooldownUntil: newerDay + 60_001,
    inFlight: false,
    inFlightExpiresAt: null
  })
  assert.equal(rollbackDatabase.prepare(`
    SELECT COUNT(*) AS count FROM ifind_diagnostic_runs
    WHERE diagnostic_id = ?
  `).get(diagnosticId(401)).count, 0)
  rollbackDatabase.close()

  const injectionDatabase = new DatabaseSync(':memory:')
  const injectionRepository = createRepository(injectionDatabase)
  injectionDatabase.exec(`
    CREATE TRIGGER reject_diagnostic_control_update
    BEFORE UPDATE ON ifind_diagnostic_control
    BEGIN
      SELECT RAISE(ABORT, 'injected transaction failure');
    END
  `)
  assert.throws(() => injectionRepository.reserve({
    diagnosticId: diagnosticId(500),
    startedAt: Date.parse('2026-08-26T02:00:00.000Z'),
    tokenVersionId: VERSION_ID
  }), /injected transaction failure/)
  assert.equal(injectionDatabase.prepare(`
    SELECT COUNT(*) AS count FROM ifind_diagnostic_runs
    WHERE diagnostic_id = ?
  `).get(diagnosticId(500)).count, 0)
  const injectionControl = injectionDatabase.prepare(`
    SELECT day_key, daily_attempt_count, in_flight_id
    FROM ifind_diagnostic_control WHERE singleton_id = 1
  `).get()
  assert.equal(injectionControl.day_key, '')
  assert.equal(injectionControl.daily_attempt_count, 0)
  assert.equal(injectionControl.in_flight_id, null)
  injectionDatabase.close()

  const approximateLegacyDatabase = new DatabaseSync(':memory:')
  approximateLegacyDatabase.exec(`
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
      )
    );
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
    );
    INSERT INTO ifind_diagnostic_runs (
      diagnostic_id, started_at, completed_at, auth_status, probe_status,
      safe_error_class, route, request_count, data_vol, elapsed_ms,
      completeness, token_version_id
    ) VALUES (
      'diag_000000000000000000000880', 1777777777000, 1777777777010,
      'success', 'failed', 'API', '${ROUTE}', 2, NULL, 10,
      'unavailable', '${VERSION_ID}'
    );
  `)
  const approximateColumnsBefore = approximateLegacyDatabase.prepare(
    'PRAGMA table_info(ifind_diagnostic_runs)'
  ).all().map((row) => row.name)
  const approximateRowBefore = JSON.stringify(approximateLegacyDatabase.prepare(`
    SELECT * FROM ifind_diagnostic_runs
    WHERE diagnostic_id = 'diag_000000000000000000000880'
  `).get())
  assert.throws(
    () => new IfindDiagnosticRepository(approximateLegacyDatabase).initialize(),
    IfindDiagnosticRepositorySchemaError
  )
  assert.deepEqual(
    approximateLegacyDatabase.prepare('PRAGMA table_info(ifind_diagnostic_runs)').all()
      .map((row) => row.name),
    approximateColumnsBefore
  )
  assert.equal(JSON.stringify(approximateLegacyDatabase.prepare(`
    SELECT * FROM ifind_diagnostic_runs
    WHERE diagnostic_id = 'diag_000000000000000000000880'
  `).get()), approximateRowBefore)
  approximateLegacyDatabase.close()

  const alteredLiteralDatabase = new DatabaseSync(':memory:')
  alteredLiteralDatabase.exec(`
    CREATE TABLE ifind_diagnostic_runs (
      diagnostic_id TEXT PRIMARY KEY NOT NULL,
      started_at INTEGER NOT NULL CHECK (started_at >= 0),
      completed_at INTEGER,
      auth_status TEXT CHECK (auth_status IS NULL OR auth_status IN ('success', 'failed', 'unknown')),
      probe_status TEXT CHECK (probe_status IS NULL OR probe_status IN ('success', 'failed', 'not_run')),
      safe_error_class TEXT CHECK (safe_error_class IS NULL OR safe_error_class IN ('auth', 'PERMISSION', 'QUOTA', 'NETWORK', 'API', 'CONFIG', 'BUSY', 'RATE_LIMITED')),
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
    );
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
    );
    INSERT INTO ifind_diagnostic_runs (
      diagnostic_id, started_at, completed_at, auth_status, probe_status,
      safe_error_class, route, request_count, data_vol, elapsed_ms,
      completeness, token_version_id
    ) VALUES (
      'diag_000000000000000000000881', 1777777777000, 1777777777010,
      'success', 'failed', 'API', '${ROUTE}', 2, NULL, 10,
      'unavailable', '${VERSION_ID}'
    );
  `)
  const alteredLiteralColumnsBefore = alteredLiteralDatabase.prepare(
    'PRAGMA table_info(ifind_diagnostic_runs)'
  ).all().map((row) => row.name)
  const alteredLiteralRowBefore = JSON.stringify(alteredLiteralDatabase.prepare(`
    SELECT * FROM ifind_diagnostic_runs
    WHERE diagnostic_id = 'diag_000000000000000000000881'
  `).get())
  assert.throws(
    () => new IfindDiagnosticRepository(alteredLiteralDatabase).initialize(),
    IfindDiagnosticRepositorySchemaError
  )
  assert.deepEqual(
    alteredLiteralDatabase.prepare('PRAGMA table_info(ifind_diagnostic_runs)').all()
      .map((row) => row.name),
    alteredLiteralColumnsBefore
  )
  assert.equal(JSON.stringify(alteredLiteralDatabase.prepare(`
    SELECT * FROM ifind_diagnostic_runs
    WHERE diagnostic_id = 'diag_000000000000000000000881'
  `).get()), alteredLiteralRowBefore)
  alteredLiteralDatabase.close()

  const triggeredLegacyDatabase = new DatabaseSync(':memory:')
  triggeredLegacyDatabase.exec(`
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
    );
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
    );
    CREATE TABLE migration_trigger_marker (count INTEGER NOT NULL);
    INSERT INTO migration_trigger_marker (count) VALUES (0);
    INSERT INTO ifind_diagnostic_runs (
      diagnostic_id, started_at, completed_at, auth_status, probe_status,
      safe_error_class, route, request_count, data_vol, elapsed_ms,
      completeness, token_version_id
    ) VALUES (
      'diag_000000000000000000000882', 1777777777000, 1777777777010,
      'success', 'failed', 'API', '${ROUTE}', 2, NULL, 10,
      'unavailable', '${VERSION_ID}'
    );
    CREATE TRIGGER reject_hidden_migration_side_effect
    AFTER UPDATE ON ifind_diagnostic_runs
    BEGIN
      UPDATE migration_trigger_marker SET count = count + 1;
    END;
  `)
  const triggeredColumnsBefore = triggeredLegacyDatabase.prepare(
    'PRAGMA table_info(ifind_diagnostic_runs)'
  ).all().map((row) => row.name)
  const triggeredRowBefore = JSON.stringify(triggeredLegacyDatabase.prepare(`
    SELECT * FROM ifind_diagnostic_runs
    WHERE diagnostic_id = 'diag_000000000000000000000882'
  `).get())
  assert.throws(
    () => new IfindDiagnosticRepository(triggeredLegacyDatabase).initialize(),
    IfindDiagnosticRepositorySchemaError
  )
  assert.deepEqual(
    triggeredLegacyDatabase.prepare('PRAGMA table_info(ifind_diagnostic_runs)').all()
      .map((row) => row.name),
    triggeredColumnsBefore
  )
  assert.equal(JSON.stringify(triggeredLegacyDatabase.prepare(`
    SELECT * FROM ifind_diagnostic_runs
    WHERE diagnostic_id = 'diag_000000000000000000000882'
  `).get()), triggeredRowBefore)
  assert.equal(
    triggeredLegacyDatabase.prepare('SELECT count FROM migration_trigger_marker').get().count,
    0
  )
  triggeredLegacyDatabase.close()

  for (const triggerKind of ['persistent', 'temporary']) {
    const currentTriggerDatabase = new DatabaseSync(':memory:')
    const currentTriggerRepository = createRepository(currentTriggerDatabase)
    const applicationIdBefore = Number(
      currentTriggerDatabase.prepare('PRAGMA application_id').get().application_id
    )
    const columnsBefore = currentTriggerDatabase.prepare(
      'PRAGMA table_info(ifind_diagnostic_runs)'
    ).all().map((row) => row.name)
    const controlBefore = JSON.stringify(currentTriggerDatabase.prepare(
      'SELECT * FROM ifind_diagnostic_control WHERE singleton_id = 1'
    ).get())
    currentTriggerDatabase.exec(`
      CREATE ${triggerKind === 'temporary' ? 'TEMP ' : ''}TRIGGER current_schema_${triggerKind}_trigger
      AFTER UPDATE ON ifind_diagnostic_runs
      BEGIN
        SELECT 1;
      END;
    `)
    assert.throws(
      () => currentTriggerRepository.initialize(),
      IfindDiagnosticRepositorySchemaError
    )
    assert.deepEqual(
      currentTriggerDatabase.prepare('PRAGMA table_info(ifind_diagnostic_runs)').all()
        .map((row) => row.name),
      columnsBefore
    )
    assert.equal(JSON.stringify(currentTriggerDatabase.prepare(
      'SELECT * FROM ifind_diagnostic_control WHERE singleton_id = 1'
    ).get()), controlBefore)
    assert.equal(
      Number(currentTriggerDatabase.prepare('PRAGMA application_id').get().application_id),
      applicationIdBefore
    )
    currentTriggerDatabase.close()
  }

  const controlInsertTriggerDatabase = new DatabaseSync(':memory:')
  controlInsertTriggerDatabase.exec(`
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
    );
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
    );
    CREATE TABLE control_insert_trigger_marker (count INTEGER NOT NULL);
    INSERT INTO control_insert_trigger_marker (count) VALUES (0);
    INSERT INTO ifind_diagnostic_runs (
      diagnostic_id, started_at, completed_at, auth_status, probe_status,
      safe_error_class, route, request_count, data_vol, elapsed_ms,
      completeness, token_version_id
    ) VALUES (
      'diag_000000000000000000000883', 1777777777000, 1777777777010,
      'success', 'failed', 'API', '${ROUTE}', 2, NULL, 10,
      'unavailable', '${VERSION_ID}'
    );
    CREATE TRIGGER legacy_control_insert_trigger
    BEFORE INSERT ON ifind_diagnostic_control
    BEGIN
      UPDATE control_insert_trigger_marker SET count = count + 1;
      SELECT RAISE(FAIL, 'control insert trigger executed before schema guard');
    END;
  `)
  const controlInsertColumnsBefore = controlInsertTriggerDatabase.prepare(
    'PRAGMA table_info(ifind_diagnostic_runs)'
  ).all().map((row) => row.name)
  const controlInsertRowBefore = JSON.stringify(controlInsertTriggerDatabase.prepare(`
    SELECT * FROM ifind_diagnostic_runs
    WHERE diagnostic_id = 'diag_000000000000000000000883'
  `).get())
  assert.throws(
    () => new IfindDiagnosticRepository(controlInsertTriggerDatabase).initialize(),
    IfindDiagnosticRepositorySchemaError
  )
  assert.deepEqual(
    controlInsertTriggerDatabase.prepare('PRAGMA table_info(ifind_diagnostic_runs)').all()
      .map((row) => row.name),
    controlInsertColumnsBefore
  )
  assert.equal(JSON.stringify(controlInsertTriggerDatabase.prepare(`
    SELECT * FROM ifind_diagnostic_runs
    WHERE diagnostic_id = 'diag_000000000000000000000883'
  `).get()), controlInsertRowBefore)
  assert.equal(
    controlInsertTriggerDatabase.prepare('SELECT count FROM control_insert_trigger_marker').get().count,
    0
  )
  assert.equal(
    controlInsertTriggerDatabase.prepare(
      'SELECT COUNT(*) AS count FROM ifind_diagnostic_control'
    ).get().count,
    0
  )
  assert.equal(
    Number(controlInsertTriggerDatabase.prepare('PRAGMA application_id').get().application_id),
    0
  )
  controlInsertTriggerDatabase.close()

  const malformedDatabase = new DatabaseSync(':memory:')
  malformedDatabase.exec(`
    CREATE TABLE ifind_diagnostic_runs (
      diagnostic_id TEXT PRIMARY KEY,
      raw_response_json TEXT
    )
  `)
  assert.throws(
    () => new IfindDiagnosticRepository(malformedDatabase).initialize(),
    IfindDiagnosticRepositorySchemaError
  )
  assert.equal(
    Number(malformedDatabase.prepare('PRAGMA application_id').get().application_id),
    0
  )
  assert.equal(malformedDatabase.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name = 'ifind_diagnostic_control'
  `).get().count, 0)
  assert.deepEqual(
    malformedDatabase.prepare('PRAGMA table_info(ifind_diagnostic_runs)').all().map((row) => row.name),
    ['diagnostic_id', 'raw_response_json']
  )
  malformedDatabase.close()
}

module.exports = { run }

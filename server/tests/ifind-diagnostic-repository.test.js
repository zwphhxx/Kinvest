const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const VERSION_ID = 'v20260826-001'
const ROUTE = '/api/v1/get_trade_dates'

function diagnosticId(number) {
  return `diag_${String(number).padStart(24, '0')}`
}

function terminalResult(overrides = {}) {
  return {
    completedAt: 1_777_777_777_010,
    authStatus: 'success',
    probeStatus: 'success',
    safeErrorClass: null,
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
    IfindDiagnosticRepositoryError
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
      'token_version_id'
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
  identityRepository.initialize()
  assert.equal(identityDatabase.prepare('SELECT COUNT(*) AS count FROM ifind_diagnostic_control').get().count, 1)
  identityDatabase.close()

  const wrongIdentity = new DatabaseSync(':memory:')
  wrongIdentity.exec('PRAGMA application_id = 1234')
  assert.throws(
    () => new IfindDiagnosticRepository(wrongIdentity).initialize(),
    (error) => error.code === 'DEVICE_AUTH_DATABASE_IDENTITY_INVALID'
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
    assert.deepEqual(first.complete({
      reservation: firstReservation.reservation,
      result: terminalResult({ completedAt: startedAt + 11 })
    }), { status: 'not-found' })
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
      tokenVersionId: VERSION_ID
    })
    latest.authStatus = 'failed'
    assert.equal(first.latest().authStatus, 'success')
    assert.equal(Object.getPrototypeOf(first.latest()), Object.prototype)
    assert.equal(Object.getPrototypeOf(first.list()[0]), Object.prototype)
    assert.equal(firstDatabase.prepare('SELECT 1 AS value').get().value, 1)

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
  const staleRun = staleRepository.latest()
  assert.deepEqual(staleRun, {
    diagnosticId: diagnosticId(300),
    startedAt: staleStartedAt,
    completedAt: staleStartedAt + IFIND_DIAGNOSTIC_LEASE_MS,
    authStatus: 'unknown',
    probeStatus: 'not_run',
    safeErrorClass: 'CONFIG',
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
}

module.exports = { run }

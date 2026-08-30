'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { Worker } = require('node:worker_threads')

const { DeviceAuthRepository } = require('../db/device-auth-repository')
const {
  IfindDiagnosticRepository
} = require('../db/ifind-diagnostic-repository')
const {
  IFIND_MARKET_MAX_CREATED_AT,
  IFIND_MARKET_MAX_DERIVED_TIMESTAMP,
  IfindMarketDiagnosticRepository
} = require('../db/ifind-market-diagnostic-repository')
const {
  KINVEST_SQLITE_APPLICATION_ID
} = require('../db/database-identity')
const { listIfindMarketCases } = require('../domain/ifind-market-cases')

const CASES = Object.freeze([
  'HK_ALIBABA_9988',
  'US_APPLE_AAPL',
  'CN_MOUTAI_600519'
])
const TOKEN_VERSION_ID = 'v20260829-001'
const DAY_START = Date.parse('2026-08-29T00:00:00+08:00')
const MINUTE = 60_000

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

function runId(index) {
  return `market_run_${index.toString(16).padStart(24, '0')}`
}

function openDatabase(databasePath = ':memory:') {
  const database = new DatabaseSync(databasePath)
  database.exec('PRAGMA foreign_keys = ON')
  return database
}

function createFileDatabases() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-market-repository-'))
  const databasePath = path.join(directory, 'kinvest.sqlite')
  const first = openDatabase(databasePath)
  const second = openDatabase(databasePath)
  return {
    databasePath,
    first,
    second,
    close() {
      first.close()
      second.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

function reserveWorker(databasePath, input, barrier) {
  const worker = new Worker(`
    'use strict'
    const { parentPort, workerData } = require('node:worker_threads')
    const { DatabaseSync } = require('node:sqlite')
    const {
      IfindMarketDiagnosticRepository
    } = require(workerData.repositoryPath)
    const database = new DatabaseSync(workerData.databasePath)
    let outcome
    try {
      const repository = new IfindMarketDiagnosticRepository(database)
      repository.initialize()
      const gate = new Int32Array(workerData.barrier)
      Atomics.add(gate, 0, 1)
      Atomics.notify(gate, 0)
      Atomics.wait(gate, 1, 0)
      outcome = { ok: true, result: repository.reserve(workerData.input) }
    } catch (error) {
      outcome = { ok: false, code: error && error.code, message: error && error.message }
    } finally {
      database.close()
    }
    parentPort.postMessage(outcome)
  `, {
    eval: true,
    workerData: {
      repositoryPath: require.resolve('../db/ifind-market-diagnostic-repository'),
      databasePath,
      input,
      barrier
    }
  })
  const outcome = new Promise((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`reservation worker exited ${code}`))
    })
  })
  return { worker, outcome }
}

async function releaseWorkers(barrier, expectedReady) {
  const gate = new Int32Array(barrier)
  const deadline = Date.now() + 5000
  while (Atomics.load(gate, 0) < expectedReady) {
    if (Date.now() >= deadline) throw new Error('reservation workers did not reach barrier')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  Atomics.store(gate, 1, 1)
  Atomics.notify(gate, 1, expectedReady)
}

function columns(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`).all().map((row) => [
    String(row.name), String(row.type), Number(row.notnull), Number(row.pk)
  ])
}

function reservationInput(index, caseId, createdAt) {
  return {
    runId: runId(index),
    caseId,
    createdAt,
    tokenVersionId: TOKEN_VERSION_ID
  }
}

function failedResult(createdAt, overrides = {}) {
  return {
    status: 'failed',
    quoteStatus: 'unavailable',
    financeStatus: 'unavailable',
    requestCount: 1,
    dataVol: null,
    elapsedMs: 1000,
    safeErrorClass: 'NETWORK',
    failureCode: 'IFIND_MARKET_NETWORK_FAILURE',
    vendorErrorCode: null,
    completedAt: createdAt + 1000,
    ...overrides
  }
}

function completeResult(createdAt, overrides = {}) {
  return {
    status: 'complete',
    quoteStatus: 'available',
    financeStatus: 'available',
    requestCount: 3,
    dataVol: null,
    elapsedMs: 1200,
    safeErrorClass: null,
    failureCode: null,
    vendorErrorCode: null,
    completedAt: createdAt + 1200,
    ...overrides
  }
}

function quote(overrides = {}) {
  return {
    listingId: 'listing-hkex-9988',
    displayCode: '9988.HK',
    latestPrice: 101.25,
    previousClose: 100,
    open: 100.5,
    high: 102,
    low: 99.75,
    volume: 0,
    turnover: 123456.75,
    quoteTime: '2026-08-29T15:59:00+08:00',
    tradingStatus: 'trading',
    currency: 'HKD',
    ...overrides
  }
}

function point(overrides = {}) {
  return {
    indicatorId: 'HK_REVENUE',
    metricKey: 'revenue',
    reportPeriod: '2025H1',
    periodEnd: '2025-06-30',
    periodType: 'interim',
    value: 123.5,
    availability: 'available',
    currency: 'HKD',
    unit: 'million',
    disclosureScope: 'consolidated',
    sourceTime: '2025-08-29T12:00:00+08:00',
    fetchTime: '2026-08-29T16:00:00+08:00',
    ...overrides
  }
}

function reserve(repository, index, caseId, createdAt) {
  const result = repository.reserve(reservationInput(index, caseId, createdAt))
  assert.equal(result.status, 'reserved')
  return result.reservation
}

function failReservation(repository, reservation, overrides = {}) {
  return repository.fail({
    reservation,
    result: failedResult(reservation.createdAt, overrides)
  })
}

function expectCode(routine, code) {
  assert.throws(routine, (error) => error instanceof Error &&
    'code' in error && error.code === code)
}

function tableSql(database, names) {
  const placeholders = names.map(() => '?').join(', ')
  return database.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND name IN (${placeholders}) ORDER BY name
  `).all(...names)
}

function testSchemaIdentityAndLegacyCompatibility() {
  const database = openDatabase()
  const legacyAuth = new DeviceAuthRepository(database)
  legacyAuth.initialize()
  const legacyDiagnostic = new IfindDiagnosticRepository(database)
  legacyDiagnostic.initialize()
  const legacyNames = [
    'device_auth_requests',
    'device_credentials',
    'device_auth_audit',
    'ifind_diagnostic_runs',
    'ifind_diagnostic_control'
  ]
  const legacyBefore = tableSql(database, legacyNames)
  const repository = new IfindMarketDiagnosticRepository(database)

  repository.initialize()
  repository.initialize()

  assert.equal(
    Number(database.prepare('PRAGMA application_id').get().application_id),
    KINVEST_SQLITE_APPLICATION_ID
  )
  assert.deepEqual(tableSql(database, legacyNames), legacyBefore)
  assert.deepEqual(columns(database, 'ifind_market_case_runs'), RUN_COLUMNS)
  assert.deepEqual(columns(database, 'ifind_market_quote_snapshots'), QUOTE_COLUMNS)
  assert.deepEqual(columns(database, 'ifind_market_financial_points'), FINANCIAL_COLUMNS)

  const runIndexes = database.prepare(
    'PRAGMA index_list(ifind_market_case_runs)'
  ).all()
  const namedIndexes = new Map(runIndexes.map((row) => [row.name, row]))
  assert.equal(namedIndexes.get('ifind_market_case_runs_one_pending').unique, 1)
  assert.equal(namedIndexes.get('ifind_market_case_runs_one_pending').partial, 1)
  assert.equal(namedIndexes.get('ifind_market_case_runs_case_created').unique, 0)
  assert.equal(namedIndexes.get('ifind_market_case_runs_created').unique, 0)
  assert.deepEqual(
    database.prepare('PRAGMA index_info(ifind_market_case_runs_case_created)')
      .all().map((row) => row.name),
    ['case_id', 'created_at', 'run_id']
  )

  for (const table of [
    'ifind_market_quote_snapshots',
    'ifind_market_financial_points'
  ]) {
    const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${table})`).all()
    assert.equal(foreignKeys.length, 1)
    assert.equal(foreignKeys[0].table, 'ifind_market_case_runs')
    assert.equal(foreignKeys[0].from, 'run_id')
    assert.equal(foreignKeys[0].to, 'run_id')
    assert.equal(foreignKeys[0].on_delete, 'CASCADE')
  }

  const schemaSql = tableSql(database, [
    'ifind_market_case_runs',
    'ifind_market_quote_snapshots',
    'ifind_market_financial_points'
  ]).map((row) => row.sql).join('\n')
  for (const required of [
    'HK_ALIBABA_9988',
    'US_APPLE_AAPL',
    'CN_MOUTAI_600519',
    "status IN ('pending', 'complete', 'partial', 'failed')",
    'request_count BETWEEN 0 AND 5',
    'FOREIGN KEY (run_id)',
    "availability = 'missing' AND value IS NULL"
  ]) assert.equal(schemaSql.includes(required), true, required)

  const exactTables = new Map(tableSql(database, [
    'ifind_market_case_runs',
    'ifind_market_quote_snapshots',
    'ifind_market_financial_points'
  ]).map((row) => [row.name, row.sql]))
  const exactIndexes = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'index' AND name LIKE 'ifind_market_case_runs_%'
      AND sql IS NOT NULL ORDER BY name
  `).all().map((row) => row.sql)
  database.close()

  const weakenedDatabase = openDatabase()
  weakenedDatabase.exec(`PRAGMA application_id = ${KINVEST_SQLITE_APPLICATION_ID}`)
  for (const table of [
    'ifind_market_case_runs',
    'ifind_market_quote_snapshots',
    'ifind_market_financial_points'
  ]) {
    const original = exactTables.get(table)
    const sql = table === 'ifind_market_case_runs'
      ? original.replace(
          'lease_expires_at > created_at',
          'lease_expires_at >= created_at'
        )
      : original
    assert.notEqual(sql, undefined)
    if (table === 'ifind_market_case_runs') assert.notEqual(sql, original)
    weakenedDatabase.exec(sql)
  }
  for (const sql of exactIndexes) {
    assert.equal(typeof sql, 'string')
    weakenedDatabase.exec(/** @type {string} */ (sql))
  }
  expectCode(
    () => new IfindMarketDiagnosticRepository(weakenedDatabase).initialize(),
    'IFIND_MARKET_DIAGNOSTIC_SCHEMA_INCOMPATIBLE'
  )
  weakenedDatabase.close()

  const foreignDatabase = openDatabase()
  foreignDatabase.exec(`
    PRAGMA application_id = 12345;
    CREATE TABLE preserved_foreign_data (id INTEGER PRIMARY KEY)
  `)
  const before = tableSql(foreignDatabase, ['preserved_foreign_data'])
  expectCode(
    () => new IfindMarketDiagnosticRepository(foreignDatabase).initialize(),
    'DEVICE_AUTH_DATABASE_IDENTITY_INVALID'
  )
  assert.equal(
    Number(foreignDatabase.prepare('PRAGMA application_id').get().application_id),
    12345
  )
  assert.deepEqual(tableSql(foreignDatabase, ['preserved_foreign_data']), before)
  assert.equal(columns(foreignDatabase, 'ifind_market_case_runs').length, 0)
  foreignDatabase.close()
}

function testZeroIdentityRejectsUnknownUserSchemaObjects() {
  const additions = [
    ['table', 'CREATE TABLE foreign_table (id INTEGER PRIMARY KEY)'],
    [
      'index',
      'CREATE INDEX foreign_index ON device_auth_requests(expires_at)'
    ],
    [
      'view',
      'CREATE VIEW foreign_view AS SELECT request_id FROM device_auth_requests'
    ],
    [
      'trigger',
      `CREATE TRIGGER foreign_trigger AFTER INSERT ON device_auth_requests
       BEGIN SELECT 1; END`
    ]
  ]
  for (const [label, sql] of additions) {
    const database = openDatabase()
    new DeviceAuthRepository(database).initialize()
    database.exec(sql)
    database.exec('PRAGMA application_id = 0')
    const before = database.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
    `).all()
    expectCode(
      () => new IfindMarketDiagnosticRepository(database).initialize(),
      'DEVICE_AUTH_DATABASE_IDENTITY_INVALID'
    )
    assert.equal(
      Number(database.prepare('PRAGMA application_id').get().application_id),
      0,
      label
    )
    assert.deepEqual(database.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
    `).all(), before, label)
    assert.equal(columns(database, 'ifind_market_case_runs').length, 0, label)
    database.close()
  }
}

function testTwoConnectionReservationAndStaleRecovery() {
  const databases = createFileDatabases()
  try {
    const first = new IfindMarketDiagnosticRepository(databases.first)
    const second = new IfindMarketDiagnosticRepository(databases.second)
    first.initialize()
    second.initialize()

    const firstReservation = reserve(first, 1, CASES[0], DAY_START + MINUTE)
    const raceLoser = second.reserve(reservationInput(
      2,
      CASES[1],
      DAY_START + MINUTE
    ))
    assert.equal(raceLoser.status, 'busy')
    assert.equal(raceLoser.retryAt, firstReservation.leaseExpiresAt)
    assert.equal(databases.second.prepare(`
      SELECT COUNT(*) AS count FROM ifind_market_case_runs WHERE status = 'pending'
    `).get().count, 1)

    assert.equal(failReservation(first, firstReservation).status, 'completed')
    const otherCase = reserve(second, 2, CASES[1], DAY_START + 2 * MINUTE)
    assert.equal(failReservation(second, otherCase).status, 'completed')

    const cooldown = first.reserve(reservationInput(
      3,
      CASES[0],
      DAY_START + 3 * MINUTE
    ))
    assert.equal(cooldown.status, 'cooldown')
    assert.equal(cooldown.retryAt, firstReservation.createdAt + 1000 + 5 * MINUTE)
    const afterCooldown = reserve(
      first,
      3,
      CASES[0],
      firstReservation.createdAt + 1000 + 5 * MINUTE
    )
    assert.equal(failReservation(first, afterCooldown).status, 'completed')

    const stale = reserve(first, 4, CASES[0], DAY_START + 20 * MINUTE)
    const recovered = reserve(second, 5, CASES[2], stale.leaseExpiresAt)
    const staleRow = databases.first.prepare(`
      SELECT status, failure_code, completed_at
      FROM ifind_market_case_runs WHERE run_id = ?
    `).get(stale.runId)
    assert.deepEqual({ ...staleRow }, {
      status: 'failed',
      failure_code: 'IFIND_MARKET_DIAGNOSTIC_STALE_LEASE',
      completed_at: stale.leaseExpiresAt
    })
    assert.equal(failReservation(first, stale).status, 'conflict')
    assert.deepEqual({ ...databases.first.prepare(`
      SELECT status, failure_code, completed_at
      FROM ifind_market_case_runs WHERE run_id = ?
    `).get(stale.runId) }, { ...staleRow })
    assert.equal(failReservation(second, recovered).status, 'completed')
  } finally {
    databases.close()
  }
}

async function testTrueTwoConnectionReservationRace() {
  const databases = createFileDatabases()
  try {
    new IfindMarketDiagnosticRepository(databases.first).initialize()
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2)
    const contenders = [
      reserveWorker(
        databases.databasePath,
        reservationInput(10, CASES[0], DAY_START + MINUTE),
        barrier
      ),
      reserveWorker(
        databases.databasePath,
        reservationInput(11, CASES[1], DAY_START + MINUTE),
        barrier
      )
    ]
    await releaseWorkers(barrier, contenders.length)
    const outcomes = await Promise.all(contenders.map(({ outcome }) => outcome))
    assert.equal(outcomes.every((outcome) => outcome.ok), true)
    assert.deepEqual(
      outcomes.map((outcome) => outcome.result.status).sort(),
      ['busy', 'reserved']
    )
    assert.equal(databases.first.prepare(`
      SELECT COUNT(*) AS count FROM ifind_market_case_runs
    `).get().count, 1)
    assert.equal(databases.first.prepare(`
      SELECT COUNT(*) AS count FROM ifind_market_case_runs WHERE status = 'pending'
    `).get().count, 1)
    const attemptTotal = CASES.reduce((total, caseId) => total +
      new IfindMarketDiagnosticRepository(databases.first).quotaStatus({
        caseId,
        now: DAY_START + MINUTE
      }).caseAttemptCount, 0)
    assert.equal(attemptTotal, 1)
  } finally {
    databases.close()
  }
}

function testQuotaStatusUsesOneReadSnapshot() {
  const databases = createFileDatabases()
  try {
    databases.first.exec('PRAGMA journal_mode = WAL')
    const reader = new IfindMarketDiagnosticRepository(databases.first)
    const writer = new IfindMarketDiagnosticRepository(databases.second)
    reader.initialize()
    writer.initialize()

    const originalPrepare = databases.first.prepare.bind(databases.first)
    let injected = false
    /** @type {ReturnType<IfindMarketDiagnosticRepository['reserve']> | null} */
    let writerResult = null
    databases.first.prepare = function interceptedPrepare(sql) {
      const statement = originalPrepare(sql)
      if (!injected && String(sql).includes(
        'WHERE case_id = ? AND created_at >= ? AND created_at < ?'
      )) {
        return {
          get(...parameters) {
            const row = statement.get(...parameters)
            injected = true
            writerResult = writer.reserve(reservationInput(
              16,
              CASES[0],
              DAY_START + 3 * MINUTE
            ))
            return row
          }
        }
      }
      return statement
    }
    const status = reader.quotaStatus({
      caseId: CASES[0],
      now: DAY_START + 3 * MINUTE
    })
    databases.first.prepare = originalPrepare
    assert.equal(injected, true)
    assert.ok(writerResult)
    assert.equal(writerResult.status, 'reserved')
    const beforeSnapshot = status.caseAttemptCount === 0 &&
      status.globalAttemptCount === 0 && status.inFlight === false
    const afterSnapshot = status.caseAttemptCount === 1 &&
      status.globalAttemptCount === 1 && status.inFlight === true
    assert.equal(beforeSnapshot || afterSnapshot, true, JSON.stringify(status))
    assert.equal(status.caseRemaining, 5 - status.caseAttemptCount)
    assert.equal(status.globalRemaining, 12 - status.globalAttemptCount)
  } finally {
    databases.close()
  }
}

function testLeaseBoundaryAndExpiredWorker() {
  const database = openDatabase()
  const repository = new IfindMarketDiagnosticRepository(database)
  repository.initialize()

  const boundary = reserve(repository, 12, CASES[0], DAY_START + 10 * MINUTE)
  assert.equal(repository.complete({
    reservation: boundary,
    result: completeResult(boundary.createdAt, {
      completedAt: boundary.leaseExpiresAt,
      elapsedMs: boundary.leaseExpiresAt - boundary.createdAt
    }),
    quoteSnapshot: quote(),
    financialPoints: [point()]
  }).status, 'completed')

  const expired = reserve(repository, 13, CASES[1], boundary.leaseExpiresAt + 1)
  expectCode(() => repository.complete({
    reservation: expired,
    result: completeResult(expired.createdAt, {
      completedAt: expired.leaseExpiresAt + 1,
      elapsedMs: expired.leaseExpiresAt - expired.createdAt + 1
    }),
    quoteSnapshot: quote({
      listingId: 'listing-nasdaq-aapl',
      displayCode: 'AAPL.US',
      currency: 'USD'
    }),
    financialPoints: [point({
      indicatorId: 'US_REVENUE',
      currency: 'USD'
    })]
  }), 'IFIND_MARKET_DIAGNOSTIC_REPOSITORY_INVALID')
  assert.equal(database.prepare(`
    SELECT status FROM ifind_market_case_runs WHERE run_id = ?
  `).get(expired.runId).status, 'pending')
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM ifind_market_quote_snapshots WHERE run_id = ?
  `).get(expired.runId).count, 0)
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM ifind_market_financial_points WHERE run_id = ?
  `).get(expired.runId).count, 0)
  database.close()
}

function testDelayedStaleRecoveryUsesLeaseBoundary() {
  const database = openDatabase()
  const repository = new IfindMarketDiagnosticRepository(database)
  repository.initialize()
  const stale = reserve(repository, 14, CASES[2], DAY_START + MINUTE)
  const delayedRecoveryAt = stale.leaseExpiresAt + 26 * 60 * MINUTE
  const recovered = reserve(repository, 15, CASES[2], delayedRecoveryAt)
  const staleRun = repository.latest({ caseId: CASES[2] })
  assert.equal(staleRun.runId, stale.runId)
  assert.equal(staleRun.completedAt, stale.leaseExpiresAt)
  assert.equal(staleRun.elapsedMs, stale.leaseExpiresAt - stale.createdAt)
  assert.equal(repository.quotaStatus({
    caseId: CASES[2],
    now: delayedRecoveryAt
  }).cooldownUntil, null)
  assert.equal(failReservation(repository, recovered).status, 'completed')
  database.close()
}

function testTimestampHeadroomAndOverflowRejection() {
  assert.equal(Number.isSafeInteger(IFIND_MARKET_MAX_CREATED_AT), true)
  assert.equal(Number.isSafeInteger(IFIND_MARKET_MAX_DERIVED_TIMESTAMP), true)
  assert.equal(
    IFIND_MARKET_MAX_CREATED_AT + 30_000 + 5 * MINUTE <=
      IFIND_MARKET_MAX_DERIVED_TIMESTAMP,
    true
  )
  const database = openDatabase()
  const repository = new IfindMarketDiagnosticRepository(database)
  repository.initialize()
  const boundary = reserve(
    repository,
    17,
    CASES[0],
    IFIND_MARKET_MAX_CREATED_AT
  )
  assert.equal(boundary.leaseExpiresAt <= IFIND_MARKET_MAX_DERIVED_TIMESTAMP, true)
  assert.equal(repository.fail({
    reservation: boundary,
    result: failedResult(boundary.createdAt, {
      completedAt: boundary.leaseExpiresAt,
      elapsedMs: boundary.leaseExpiresAt - boundary.createdAt
    })
  }).cooldownUntil <= IFIND_MARKET_MAX_DERIVED_TIMESTAMP, true)

  for (const invalidCreatedAt of [
    IFIND_MARKET_MAX_CREATED_AT + 1,
    IFIND_MARKET_MAX_DERIVED_TIMESTAMP,
    Number.MAX_SAFE_INTEGER
  ]) {
    expectCode(
      () => repository.reserve(reservationInput(
        18,
        CASES[1],
        invalidCreatedAt
      )),
      'IFIND_MARKET_DIAGNOSTIC_REPOSITORY_INVALID'
    )
  }
  expectCode(
    () => repository.quotaStatus({
      caseId: CASES[0],
      now: IFIND_MARKET_MAX_CREATED_AT + 1
    }),
    'IFIND_MARKET_DIAGNOSTIC_REPOSITORY_INVALID'
  )
  database.close()
}

function testShanghaiDayRolloverAndQuotas() {
  const perCaseDatabase = openDatabase()
  const perCase = new IfindMarketDiagnosticRepository(perCaseDatabase)
  perCase.initialize()
  for (let index = 0; index < 5; index += 1) {
    const createdAt = DAY_START + (index + 1) * 6 * MINUTE
    failReservation(perCase, reserve(perCase, 20 + index, CASES[0], createdAt))
  }
  const caseLimited = perCase.reserve(reservationInput(
    25,
    CASES[0],
    DAY_START + 36 * MINUTE
  ))
  assert.equal(caseLimited.status, 'case-daily-limit')
  assert.equal(caseLimited.retryAt, DAY_START + 24 * 60 * MINUTE)

  const nextDay = reserve(
    perCase,
    25,
    CASES[0],
    DAY_START + 24 * 60 * MINUTE
  )
  const rolloverStatus = perCase.quotaStatus({
    caseId: CASES[0],
    now: nextDay.createdAt
  })
  assert.equal(rolloverStatus.localDayKey, '2026-08-30')
  assert.equal(rolloverStatus.caseAttemptCount, 1)
  assert.equal(rolloverStatus.globalAttemptCount, 1)
  failReservation(perCase, nextDay)
  perCaseDatabase.close()

  const globalDatabase = openDatabase()
  const global = new IfindMarketDiagnosticRepository(globalDatabase)
  global.initialize()
  for (let index = 0; index < 12; index += 1) {
    const createdAt = DAY_START + (index + 1) * 2 * MINUTE
    const reservation = reserve(
      global,
      40 + index,
      CASES[index % CASES.length],
      createdAt
    )
    failReservation(global, reservation)
  }
  const globalLimited = global.reserve(reservationInput(
    52,
    CASES[0],
    DAY_START + 26 * MINUTE
  ))
  assert.equal(globalLimited.status, 'global-daily-limit')
  assert.equal(globalLimited.globalAttemptCount, 12)
  assert.equal(globalLimited.retryAt, DAY_START + 24 * 60 * MINUTE)
  const status = global.quotaStatus({ caseId: CASES[0], now: DAY_START + 26 * MINUTE })
  assert.equal(status.caseAttemptCount, 4)
  assert.equal(status.globalAttemptCount, 12)
  assert.equal(status.caseRemaining, 1)
  assert.equal(status.globalRemaining, 0)
  globalDatabase.close()
}

function testTerminalSnapshotsQueriesAndReplacement() {
  const database = openDatabase()
  const repository = new IfindMarketDiagnosticRepository(database)
  repository.initialize()
  const createdAt = DAY_START + 60 * MINUTE
  const reservation = reserve(repository, 70, CASES[0], createdAt)
  const missingPoint = point({
    indicatorId: 'HK_GROSS_PROFIT',
    metricKey: 'grossProfit',
    value: null,
    availability: 'missing'
  })
  const negativePoint = point({
    indicatorId: 'HK_OPERATING_CASH_FLOW',
    metricKey: 'operatingCashFlow',
    value: -20.25
  })
  const terminal = repository.complete({
    reservation,
    result: completeResult(createdAt),
    quoteSnapshot: quote(),
    financialPoints: [point(), missingPoint, negativePoint]
  })
  assert.equal(terminal.status, 'completed')

  const latest = repository.latest({ caseId: CASES[0] })
  assert.equal(latest.runId, reservation.runId)
  assert.equal(latest.dataVol, null)
  assert.equal(latest.quoteSnapshot.volume, 0)
  assert.equal(latest.financialPoints.length, 3)
  assert.deepEqual(
    latest.financialPoints.find((item) => item.metricKey === 'grossProfit'),
    missingPoint
  )
  assert.deepEqual(
    latest.financialPoints.find((item) => item.metricKey === 'operatingCashFlow'),
    negativePoint
  )
  assert.deepEqual(repository.history({ caseId: CASES[1], limit: 10 }), [])
  assert.equal(database.prepare(`
    SELECT value IS NULL AS is_null, availability
    FROM ifind_market_financial_points WHERE indicator_id = 'HK_GROSS_PROFIT'
  `).get().is_null, 1)

  const replacement = repository.complete({
    reservation,
    result: completeResult(createdAt),
    quoteSnapshot: quote({ latestPrice: 999 }),
    financialPoints: [point(), missingPoint, negativePoint]
  })
  assert.equal(replacement.status, 'conflict')
  assert.equal(database.prepare(`
    SELECT latest_price FROM ifind_market_quote_snapshots WHERE run_id = ?
  `).get(reservation.runId).latest_price, 101.25)

  const secondAt = createdAt + 6 * MINUTE
  const secondReservation = reserve(repository, 71, CASES[0], secondAt)
  assert.equal(failReservation(repository, secondReservation).status, 'completed')
  assert.equal(repository.latest({ caseId: CASES[0] }).runId, secondReservation.runId)
  assert.deepEqual(
    repository.history({ caseId: CASES[0], limit: 1 }).map((run) => run.runId),
    [secondReservation.runId]
  )
  expectCode(
    () => repository.history({ caseId: CASES[0], limit: 51 }),
    'IFIND_MARKET_DIAGNOSTIC_REPOSITORY_INVALID'
  )
  database.close()
}

function testTransactionalChildFailureRollsBack() {
  const database = openDatabase()
  const repository = new IfindMarketDiagnosticRepository(database)
  repository.initialize()
  const reservation = reserve(repository, 80, CASES[0], DAY_START + 90 * MINUTE)
  const before = database.prepare(`
    SELECT * FROM ifind_market_case_runs WHERE run_id = ?
  `).get(reservation.runId)
  database.exec(`
    CREATE TEMP TRIGGER reject_market_quote_insert
    BEFORE INSERT ON ifind_market_quote_snapshots
    BEGIN
      SELECT RAISE(ABORT, 'forced child insert failure');
    END
  `)
  assert.throws(() => repository.complete({
    reservation,
    result: completeResult(reservation.createdAt),
    quoteSnapshot: quote(),
    financialPoints: [point()]
  }))
  assert.deepEqual({ ...database.prepare(`
    SELECT * FROM ifind_market_case_runs WHERE run_id = ?
  `).get(reservation.runId) }, { ...before })
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM ifind_market_quote_snapshots WHERE run_id = ?
  `).get(reservation.runId).count, 0)
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM ifind_market_financial_points WHERE run_id = ?
  `).get(reservation.runId).count, 0)
  database.exec('DROP TRIGGER reject_market_quote_insert')

  database.exec(`
    CREATE TEMP TRIGGER reject_market_financial_insert
    BEFORE INSERT ON ifind_market_financial_points
    WHEN NEW.indicator_id = 'HK_GROSS_PROFIT'
    BEGIN
      SELECT RAISE(ABORT, 'forced financial child failure');
    END
  `)
  assert.throws(() => repository.complete({
    reservation,
    result: completeResult(reservation.createdAt),
    quoteSnapshot: quote(),
    financialPoints: [
      point(),
      point({
        indicatorId: 'HK_GROSS_PROFIT',
        metricKey: 'grossProfit',
        value: null,
        availability: 'missing'
      })
    ]
  }))
  assert.deepEqual({ ...database.prepare(`
    SELECT * FROM ifind_market_case_runs WHERE run_id = ?
  `).get(reservation.runId) }, { ...before })
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM ifind_market_quote_snapshots WHERE run_id = ?
  `).get(reservation.runId).count, 0)
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM ifind_market_financial_points WHERE run_id = ?
  `).get(reservation.runId).count, 0)
  database.exec('DROP TRIGGER reject_market_financial_insert')
  assert.equal(failReservation(repository, reservation).status, 'completed')
  database.close()
}

function testCanonicalCatalogIdentityAndReportingCurrency() {
  const catalog = listIfindMarketCases()
  assert.equal(catalog.length, 3)
  assert.equal(catalog.every((marketCase) => marketCase.liveReady === false), true)
  const marketCase = catalog.find(({ caseId }) => caseId === CASES[0])
  const financialMetric = marketCase.indicators.financial[0].metric
  const database = openDatabase()
  const repository = new IfindMarketDiagnosticRepository(database)
  repository.initialize()
  const reservation = reserve(repository, 81, marketCase.caseId, DAY_START + 95 * MINUTE)
  assert.equal(repository.complete({
    reservation,
    result: completeResult(reservation.createdAt),
    quoteSnapshot: quote({
      listingId: marketCase.listingId,
      displayCode: marketCase.displayCode,
      currency: marketCase.expectedTradingCurrency
    }),
    financialPoints: [point({
      metricKey: financialMetric,
      currency: 'CNY'
    })]
  }).status, 'completed')
  assert.equal(
    repository.latest({ caseId: marketCase.caseId }).financialPoints[0].currency,
    'CNY'
  )
  database.close()
}

function testTerminalValidationRollbackAndRawRejection() {
  const database = openDatabase()
  const repository = new IfindMarketDiagnosticRepository(database)
  repository.initialize()
  assert.deepEqual(
    Object.getOwnPropertyNames(Object.getPrototypeOf(repository)).sort(),
    [
      'complete',
      'constructor',
      'fail',
      'history',
      'initialize',
      'latest',
      'quotaStatus',
      'reserve'
    ]
  )
  for (const bypass of ['insertQuote', 'insertFinancialPoints', 'settle']) {
    assert.equal(repository[bypass], undefined)
  }
  const createdAt = DAY_START + 120 * MINUTE
  const reservation = reserve(repository, 90, CASES[0], createdAt)
  const invalidWrites = [
    {
      label: 'duplicate financial identity',
      input: {
        reservation,
        result: completeResult(createdAt),
        quoteSnapshot: quote(),
        financialPoints: [point(), point({ metricKey: 'grossProfit' })]
      }
    },
    {
      label: 'raw provider body',
      input: {
        reservation,
        result: { ...completeResult(createdAt), rawProviderBody: '{}' },
        quoteSnapshot: quote(),
        financialPoints: [point()]
      }
    },
    {
      label: 'RequestId',
      input: {
        reservation,
        result: completeResult(createdAt),
        quoteSnapshot: { ...quote(), RequestId: 'unsafe-request-id' },
        financialPoints: [point()]
      }
    },
    {
      label: 'provider message',
      input: {
        reservation,
        result: completeResult(createdAt),
        quoteSnapshot: quote(),
        financialPoints: [{ ...point(), providerMessage: 'unsafe provider text' }]
      }
    },
    {
      label: 'Mock value',
      input: {
        reservation,
        result: completeResult(createdAt),
        quoteSnapshot: quote({ tradingStatus: 'Mock' }),
        financialPoints: [point()]
      }
    },
    {
      label: 'impossible quote date',
      input: {
        reservation,
        result: completeResult(createdAt),
        quoteSnapshot: quote({ quoteTime: '2026-02-30T12:00:00+08:00' }),
        financialPoints: [point()]
      }
    },
    {
      label: 'invalid quote hour',
      input: {
        reservation,
        result: completeResult(createdAt),
        quoteSnapshot: quote({ quoteTime: '2026-08-29T24:00:00+08:00' }),
        financialPoints: [point()]
      }
    },
    {
      label: 'invalid source minute',
      input: {
        reservation,
        result: completeResult(createdAt),
        quoteSnapshot: quote(),
        financialPoints: [point({ sourceTime: '2025-08-29T12:60:00+08:00' })]
      }
    },
    {
      label: 'invalid fetch offset',
      input: {
        reservation,
        result: completeResult(createdAt),
        quoteSnapshot: quote(),
        financialPoints: [point({ fetchTime: '2026-08-29T16:00:00+25:00' })]
      }
    }
  ]
  for (const { label, input } of invalidWrites) {
    expectCode(
      () => repository.complete(input),
      'IFIND_MARKET_DIAGNOSTIC_REPOSITORY_INVALID'
    )
    assert.equal(database.prepare(`
      SELECT status FROM ifind_market_case_runs WHERE run_id = ?
    `).get(reservation.runId).status, 'pending', label)
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM ifind_market_quote_snapshots
    `).get().count, 0, label)
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM ifind_market_financial_points
    `).get().count, 0, label)
  }

  let accessorInvoked = false
  const accessorInput = reservationInput(91, CASES[1], createdAt)
  Object.defineProperty(accessorInput, 'runId', {
    enumerable: true,
    get() {
      accessorInvoked = true
      return runId(91)
    }
  })
  expectCode(
    () => repository.reserve(accessorInput),
    'IFIND_MARKET_DIAGNOSTIC_REPOSITORY_INVALID'
  )
  assert.equal(accessorInvoked, false)

  let proxyInvoked = false
  const proxied = new Proxy(reservationInput(92, CASES[1], createdAt), {
    get() {
      proxyInvoked = true
      throw new Error('proxy trap invoked')
    }
  })
  expectCode(
    () => repository.reserve(proxied),
    'IFIND_MARKET_DIAGNOSTIC_REPOSITORY_INVALID'
  )
  assert.equal(proxyInvoked, false)

  let terminalProxyInvoked = false
  const terminalProxy = new Proxy({
    reservation,
    result: completeResult(createdAt),
    quoteSnapshot: quote(),
    financialPoints: [point()]
  }, {
    get() {
      terminalProxyInvoked = true
      throw new Error('terminal proxy trap invoked')
    }
  })
  expectCode(
    () => repository.complete(terminalProxy),
    'IFIND_MARKET_DIAGNOSTIC_REPOSITORY_INVALID'
  )
  assert.equal(terminalProxyInvoked, false)

  let quoteAccessorInvoked = false
  const accessorQuote = quote()
  Object.defineProperty(accessorQuote, 'latestPrice', {
    enumerable: true,
    get() {
      quoteAccessorInvoked = true
      return 101.25
    }
  })
  expectCode(() => repository.complete({
    reservation,
    result: completeResult(createdAt),
    quoteSnapshot: accessorQuote,
    financialPoints: [point()]
  }), 'IFIND_MARKET_DIAGNOSTIC_REPOSITORY_INVALID')
  assert.equal(quoteAccessorInvoked, false)

  let pointsProxyInvoked = false
  const pointsProxy = new Proxy([point()], {
    get() {
      pointsProxyInvoked = true
      throw new Error('points proxy trap invoked')
    }
  })
  expectCode(() => repository.complete({
    reservation,
    result: completeResult(createdAt),
    quoteSnapshot: quote(),
    financialPoints: pointsProxy
  }), 'IFIND_MARKET_DIAGNOSTIC_REPOSITORY_INVALID')
  assert.equal(pointsProxyInvoked, false)

  const customPrototype = Object.create({ inherited: true })
  Object.assign(customPrototype, reservationInput(93, CASES[1], createdAt))
  expectCode(
    () => repository.reserve(customPrototype),
    'IFIND_MARKET_DIAGNOSTIC_REPOSITORY_INVALID'
  )

  const partialAt = reservation.leaseExpiresAt
  const partialReservation = reserve(repository, 94, CASES[1], partialAt)
  const partial = repository.complete({
    reservation: partialReservation,
    result: completeResult(partialAt, {
      status: 'partial',
      financeStatus: 'unavailable',
      safeErrorClass: 'INDICATOR',
      failureCode: 'IFIND_MARKET_FINANCE_UNAVAILABLE'
    }),
    quoteSnapshot: {
      ...quote(),
      listingId: 'listing-nasdaq-aapl',
      displayCode: 'AAPL.US',
      currency: 'USD'
    },
    financialPoints: []
  })
  assert.equal(partial.status, 'completed')

  const serializedRows = JSON.stringify(database.prepare(`
    SELECT * FROM ifind_market_case_runs
    LEFT JOIN ifind_market_quote_snapshots USING (run_id)
  `).all())
  assert.doesNotMatch(
    serializedRows,
    /unsafe-request-id|unsafe provider text|rawProviderBody|RequestId|Mock/
  )
  database.close()
}

async function run() {
  /** @type {[string, () => void | Promise<void>][]} */
  const tests = [
    ['schema identity and legacy compatibility', testSchemaIdentityAndLegacyCompatibility],
    ['zero identity rejects unknown schema objects', testZeroIdentityRejectsUnknownUserSchemaObjects],
    ['two-connection reservation and stale recovery', testTwoConnectionReservationAndStaleRecovery],
    ['true two-connection reservation race', testTrueTwoConnectionReservationRace],
    ['quota status uses one read snapshot', testQuotaStatusUsesOneReadSnapshot],
    ['lease boundary and expired worker', testLeaseBoundaryAndExpiredWorker],
    ['delayed stale recovery uses lease boundary', testDelayedStaleRecoveryUsesLeaseBoundary],
    ['timestamp headroom and overflow rejection', testTimestampHeadroomAndOverflowRejection],
    ['Shanghai day rollover and quotas', testShanghaiDayRolloverAndQuotas],
    ['terminal snapshots, queries, and replacement', testTerminalSnapshotsQueriesAndReplacement],
    ['transactional child failure rollback', testTransactionalChildFailureRollsBack],
    ['canonical catalog identity and reporting currency', testCanonicalCatalogIdentityAndReportingCurrency],
    ['terminal validation, rollback, and raw rejection', testTerminalValidationRollbackAndRawRejection]
  ]
  for (const [label, test] of tests) {
    try {
      await test()
    } catch (error) {
      error.message = `[${label}] ${error.message}`
      throw error
    }
  }
}

module.exports = { run }

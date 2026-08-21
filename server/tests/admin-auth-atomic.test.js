const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Worker } = require('node:worker_threads')
const { DatabaseSync } = require('node:sqlite')

const { AdminAuthRepository } = require('../db/admin-auth-repository')

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('base64url')
}

function sessionFixture() {
  return {
    sessionId: 'session-atomic',
    tokenDigest: digest('session-token'),
    csrfDigest: digest('csrf-old'),
    createdAt: 1000,
    lastUsedAt: 1000,
    idleExpiresAt: 10000,
    absoluteExpiresAt: 20000,
    revokedAt: null
  }
}

function audit(eventId, occurredAt) {
  return {
    eventId,
    eventType: 'admin_session_authenticated',
    occurredAt,
    subjectId: null,
    metadata: {}
  }
}

function testAtomicVerifyTouchAndDeadlinePredicates() {
  const database = new DatabaseSync(':memory:')
  const repository = new AdminAuthRepository(database)
  repository.initialize()
  const fixture = sessionFixture()
  repository.createSession(fixture)

  const authenticated = repository.verifyAndTouchSession({
    tokenDigest: fixture.tokenDigest,
    expectedCsrfDigest: fixture.csrfDigest,
    now: 2000,
    idleTtlMs: 5000,
    auditEvent: audit('audit-valid', 2000)
  })
  assert.equal(authenticated.status, 'authenticated')
  assert.equal(authenticated.session.lastUsedAt, 2000)
  assert.equal(authenticated.session.idleExpiresAt, 7000)
  const authenticatedAudit = repository.listAuditEvents()[0]
  assert.equal(authenticatedAudit.subjectId, fixture.sessionId)
  assert.equal(authenticatedAudit.metadata.sessionId, fixture.sessionId)

  const beforeRejected = repository.findSessionByTokenDigest(fixture.tokenDigest)
  const rejected = repository.verifyAndTouchSession({
    tokenDigest: fixture.tokenDigest,
    expectedCsrfDigest: digest('csrf-stale'),
    now: 3000,
    idleTtlMs: 5000,
    auditEvent: audit('audit-stale', 3000)
  })
  assert.equal(rejected.status, 'csrf_invalid')
  assert.deepEqual(
    repository.findSessionByTokenDigest(fixture.tokenDigest),
    beforeRejected
  )

  const expired = repository.verifyAndTouchSession({
    tokenDigest: fixture.tokenDigest,
    expectedCsrfDigest: fixture.csrfDigest,
    now: 7000,
    idleTtlMs: 5000,
    auditEvent: audit('audit-expired', 7000)
  })
  assert.equal(expired.status, 'session_expired')
  assert.equal(repository.listAuditEvents().length, 1)
  database.close()
}

async function testConcurrentStaleCsrfRotationAndExpiredRotation() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-csrf-race-'))
  const databasePath = path.join(directory, 'auth.sqlite')
  const database = new DatabaseSync(databasePath)
  database.exec('PRAGMA busy_timeout = 5000')
  const repository = new AdminAuthRepository(database)
  repository.initialize()
  const fixture = sessionFixture()
  repository.createSession(fixture)
  database.close()

  const repositoryPath = require.resolve('../db/admin-auth-repository')
  const source = `
    const { parentPort, workerData } = require('node:worker_threads')
    const { DatabaseSync } = require('node:sqlite')
    const { AdminAuthRepository } = require(workerData.repositoryPath)
    const database = new DatabaseSync(workerData.databasePath)
    database.exec('PRAGMA busy_timeout = 5000')
    const repository = new AdminAuthRepository(database)
    repository.initialize()
    parentPort.once('message', () => {
      try {
        const rotated = repository.rotateSessionCsrf(workerData.input)
        parentPort.postMessage({ rotated })
      } catch (error) {
        parentPort.postMessage({ error: error && error.message })
      } finally {
        database.close()
      }
    })
  `
  const makeInput = (marker) => ({
    sessionId: fixture.sessionId,
    expectedCsrfDigest: fixture.csrfDigest,
    csrfDigest: digest(`csrf-${marker}`),
    now: 2000,
    idleTtlMs: 5000,
    auditEvent: audit(`audit-${marker}`, 2000)
  })
  const workers = ['one', 'two'].map((marker) => new Worker(source, {
    eval: true,
    workerData: {
      repositoryPath,
      databasePath,
      input: makeInput(marker)
    }
  }))
  const outcomes = workers.map((worker) => new Promise((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.postMessage('start')
  }))

  try {
    const results = await Promise.all(outcomes)
    assert.deepEqual(
      results.map((entry) => entry.rotated).sort(),
      [false, true]
    )
    const verification = new DatabaseSync(databasePath)
    verification.exec('PRAGMA busy_timeout = 5000')
    const verifyRepository = new AdminAuthRepository(verification)
    const current = verifyRepository.findSessionByTokenDigest(fixture.tokenDigest)
    const expiredRotation = verifyRepository.rotateSessionCsrf({
      sessionId: fixture.sessionId,
      expectedCsrfDigest: current.csrfDigest,
      csrfDigest: digest('csrf-expired'),
      now: current.idleExpiresAt,
      idleTtlMs: 5000,
      auditEvent: audit('audit-expired-rotation', current.idleExpiresAt)
    })
    assert.equal(expiredRotation, false)
    assert.equal(verifyRepository.listAuditEvents().length, 1)
    verification.close()
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()))
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

async function run() {
  testAtomicVerifyTouchAndDeadlinePredicates()
  await testConcurrentStaleCsrfRotationAndExpiredRotation()
}

module.exports = { run }

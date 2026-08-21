const assert = require('node:assert')
const crypto = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')

const { AdminAuthRepository } = require('../db/admin-auth-repository')
const {
  generateAdminPasswordVerifier
} = require('../security/secret-bootstrap-contract')
const {
  ADMIN_ABSOLUTE_TTL_MS,
  ADMIN_IDLE_TTL_MS,
  ADMIN_LOGIN_WINDOW_MS,
  ADMIN_MAX_FAILURES,
  AdminAuthService
} = require('../security/admin-auth')

const PASSWORD = 'Admin-\u00e9-Password'
const OTHER_PASSWORD = 'Admin-e\u0301-Password'
const START = Date.UTC(2026, 0, 2, 3, 4, 5)

async function createVerifier(password = PASSWORD) {
  return generateAdminPasswordVerifier(password)
}

function deterministicRandomBytes() {
  let count = 0
  return (size) => {
    count += 1
    const chunks = []
    for (let index = 0; Buffer.concat(chunks).length < size; index += 1) {
      chunks.push(crypto.createHash('sha256')
        .update(`admin-auth-test-${count}-${index}`)
        .digest())
    }
    return Buffer.concat(chunks).subarray(0, size)
  }
}

async function createHarness() {
  const database = new DatabaseSync(':memory:')
  const repository = new AdminAuthRepository(database)
  repository.initialize()
  const clock = { value: START }
  const service = new AdminAuthService({
    repository,
    adminVerifierMaterial: await createVerifier(),
    rateLimitKey: Buffer.alloc(32, 11),
    now: () => clock.value,
    randomBytes: deterministicRandomBytes()
  })
  return { clock, database, repository, service }
}

async function expectCode(operation, code) {
  try {
    await operation()
    assert.fail(`expected ${code}`)
  } catch (error) {
    assert.ok(error && typeof error === 'object' && 'code' in error)
    assert.strictEqual(error.code, code)
  }
}

async function testPasswordMatchingAndValidation() {
  const harness = await createHarness()
  const login = await harness.service.login(PASSWORD, '192.0.2.10')
  assert.strictEqual(Buffer.from(login.sessionToken, 'base64url').length, 32)
  assert.strictEqual(Buffer.from(login.csrfToken, 'base64url').length, 32)
  assert.strictEqual(Buffer.from(login.sessionId, 'base64url').length, 16)

  await expectCode(
    () => harness.service.reauthenticate('wrong-password', '192.0.2.11'),
    'ADMIN_AUTH_INVALID'
  )
  await expectCode(
    () => harness.service.reauthenticate(OTHER_PASSWORD, '192.0.2.12'),
    'ADMIN_AUTH_INVALID'
  )
  assert.deepStrictEqual(
    await harness.service.reauthenticate(PASSWORD, '192.0.2.13'),
    { authenticated: true }
  )

  for (const invalid of ['', 'x'.repeat(129), '\u{1f600}'.repeat(129)]) {
    await expectCode(
      () => harness.service.reauthenticate(invalid, `198.51.100.${invalid.length + 1}`),
      'ADMIN_AUTH_INVALID'
    )
  }
}

async function testRateLimitIsolationAndReset() {
  const harness = await createHarness()
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await expectCode(
      () => harness.service.reauthenticate('wrong', '203.0.113.7'),
      'ADMIN_AUTH_INVALID'
    )
  }
  await expectCode(
    () => harness.service.reauthenticate(PASSWORD, '203.0.113.7'),
    'ADMIN_AUTH_RATE_LIMITED'
  )
  assert.deepStrictEqual(
    await harness.service.reauthenticate(PASSWORD, '203.0.113.8'),
    { authenticated: true }
  )

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await expectCode(
      () => harness.service.reauthenticate('wrong', '203.0.113.9'),
      'ADMIN_AUTH_INVALID'
    )
  }
  assert.deepStrictEqual(
    await harness.service.reauthenticate(PASSWORD, '203.0.113.9'),
    { authenticated: true }
  )
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await expectCode(
      () => harness.service.reauthenticate('wrong', '203.0.113.9'),
      'ADMIN_AUTH_INVALID'
    )
  }
}

async function testConcurrentAttemptReservations() {
  const harness = await createHarness()
  const originalScrypt = crypto.scrypt
  let scryptCalls = 0
  /** @type {typeof crypto.scrypt} */
  const countingScrypt = (...arguments_) => {
    scryptCalls += 1
    return Reflect.apply(originalScrypt, crypto, arguments_)
  }
  crypto.scrypt = countingScrypt
  let results
  try {
    results = await Promise.allSettled([
      ...Array.from({ length: 10 }, () =>
        harness.service.reauthenticate('wrong', '203.0.113.60')),
      ...Array.from({ length: 10 }, () =>
        harness.service.reauthenticate('wrong', '203.0.113.61'))
    ])
  } finally {
    crypto.scrypt = originalScrypt
  }

  const codes = results.map((result) => {
    if (result.status !== 'rejected') {
      assert.fail('concurrent wrong password attempt unexpectedly succeeded')
    }
    const reason = result.reason
    return reason !== null && typeof reason === 'object' && 'code' in reason
      ? reason.code
      : undefined
  })
  assert.strictEqual(
    codes.filter((code) => code === 'ADMIN_AUTH_INVALID').length,
    10
  )
  assert.strictEqual(
    codes.filter((code) => code === 'ADMIN_AUTH_RATE_LIMITED').length,
    10
  )
  assert.strictEqual(scryptCalls, 10)
}

async function testMalformedPasswordsCountTowardRateLimit() {
  const harness = await createHarness()
  const clientAddress = '203.0.113.50'
  const malformedPasswords = [
    '',
    'x'.repeat(129),
    '\u{1f600}'.repeat(129),
    null,
    ''
  ]
  for (const password of malformedPasswords) {
    await expectCode(
      () => harness.service.reauthenticate(password, clientAddress),
      'ADMIN_AUTH_INVALID'
    )
  }
  await expectCode(
    () => harness.service.reauthenticate(PASSWORD, clientAddress),
    'ADMIN_AUTH_RATE_LIMITED'
  )
  assert.deepStrictEqual(
    await harness.service.reauthenticate(PASSWORD, '203.0.113.51'),
    { authenticated: true }
  )
}

async function testRateLimitIdentityValidation() {
  for (const identity of ['', 'x'.repeat(257), 'proxy\nspoof', 'proxy\u007fspoof']) {
    const harness = await createHarness()
    await expectCode(
      () => harness.service.reauthenticate(PASSWORD, identity),
      'ADMIN_AUTH_INVALID'
    )
    assert.strictEqual(
      harness.database.prepare(
        'SELECT COUNT(*) AS count FROM auth_rate_limits'
      ).get().count,
      0
    )
  }
}

async function testLoginSettlementRollback() {
  const harness = await createHarness()
  harness.database.exec(`
    CREATE TRIGGER fail_admin_session_created_audit
    BEFORE INSERT ON admin_auth_audit
    WHEN NEW.event_type = 'admin_session_created'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic audit failure');
    END;
  `)
  await assert.rejects(
    () => harness.service.login(PASSWORD, '203.0.113.62'),
    /synthetic audit failure/
  )
  assert.strictEqual(
    harness.database.prepare(
      'SELECT COUNT(*) AS count FROM admin_sessions'
    ).get().count,
    0
  )
  const rateLimit = harness.database.prepare(`
    SELECT failure_count, in_flight_count
    FROM auth_rate_limits
  `).get()
  assert.strictEqual(rateLimit.failure_count, 0)
  assert.strictEqual(rateLimit.in_flight_count, 1)
}

async function testStaleReauthenticationSettlementFailsClosed() {
  const harness = await createHarness()
  const settleRateLimitSuccess = harness.repository.settleRateLimitSuccess
    .bind(harness.repository)
  harness.repository.settleRateLimitSuccess = ({ reservation, auditEvent }) => {
    harness.clock.value += ADMIN_LOGIN_WINDOW_MS
    const replacement = harness.repository.reserveAttempt({
      scope: reservation.scope,
      keyDigest: reservation.keyDigest,
      now: harness.clock.value,
      windowMs: ADMIN_LOGIN_WINDOW_MS,
      maxAttempts: ADMIN_MAX_FAILURES
    })
    assert.strictEqual(replacement.allowed, true)
    return settleRateLimitSuccess({ reservation, auditEvent })
  }

  await expectCode(
    () => harness.service.reauthenticate(PASSWORD, '203.0.113.63'),
    'ADMIN_AUTH_RATE_LIMITED'
  )
  const rateLimit = harness.database.prepare(`
    SELECT window_started_at, failure_count, in_flight_count
    FROM auth_rate_limits
  `).get()
  assert.strictEqual(rateLimit.window_started_at, harness.clock.value)
  assert.strictEqual(rateLimit.failure_count, 0)
  assert.strictEqual(rateLimit.in_flight_count, 1)
  assert.strictEqual(
    harness.repository.listAuditEvents().filter(
      (event) => event.eventType === 'admin_password_reauthenticated'
    ).length,
    0
  )
}

async function testSecretStorageAndAuditRedaction() {
  const harness = await createHarness()
  const login = await harness.service.login(PASSWORD, '2001:db8::1234')
  const row = harness.database.prepare('SELECT * FROM admin_sessions').get()
  const serializedRow = JSON.stringify(row)
  assert.strictEqual(row.token_digest, crypto.createHash('sha256')
    .update(login.sessionToken)
    .digest('base64url'))
  assert.strictEqual(row.csrf_digest, crypto.createHash('sha256')
    .update(login.csrfToken)
    .digest('base64url'))

  const audit = JSON.stringify(harness.repository.listAuditEvents())
  for (const forbidden of [
    PASSWORD,
    login.sessionToken,
    login.csrfToken,
    '2001:db8::1234',
    'kinvest-admin-scrypt-v1',
    Buffer.alloc(32, 11).toString('base64url')
  ]) {
    assert.strictEqual(serializedRow.includes(forbidden), false)
    assert.strictEqual(audit.includes(forbidden), false)
  }

  harness.repository.appendAudit({
    eventId: 'whitelist-check',
    eventType: 'test',
    occurredAt: START,
    subjectId: null,
    metadata: {
      count: 2,
      csrf: login.csrfToken,
      password: PASSWORD,
      reason: 'safe-reason',
      sessionId: login.sessionId,
      token: login.sessionToken
    }
  })
  assert.deepStrictEqual(
    harness.repository.listAuditEvents().at(-1).metadata,
    { count: 2, reason: 'safe-reason', sessionId: login.sessionId }
  )
}

async function testIdleAbsoluteExpiryAndLogout() {
  const sliding = await createHarness()
  const login = await sliding.service.login(PASSWORD, '192.0.2.20')
  sliding.clock.value += 29 * 60 * 1000
  const authenticated = sliding.service.authenticate(login.sessionToken)
  assert.deepStrictEqual(authenticated, {
    sessionId: login.sessionId,
    idleExpiresAt: sliding.clock.value + ADMIN_IDLE_TTL_MS,
    absoluteExpiresAt: START + ADMIN_ABSOLUTE_TTL_MS
  })

  while (sliding.clock.value + (29 * 60 * 1000) <
    START + ADMIN_ABSOLUTE_TTL_MS - (10 * 60 * 1000)) {
    sliding.clock.value += 29 * 60 * 1000
    sliding.service.authenticate(login.sessionToken)
  }
  sliding.clock.value = START + ADMIN_ABSOLUTE_TTL_MS - (10 * 60 * 1000)
  const capped = sliding.service.authenticate(login.sessionToken)
  assert.strictEqual(capped.idleExpiresAt, START + ADMIN_ABSOLUTE_TTL_MS)
  sliding.clock.value = START + ADMIN_ABSOLUTE_TTL_MS
  await expectCode(
    () => sliding.service.authenticate(login.sessionToken),
    'ADMIN_SESSION_EXPIRED'
  )

  const idle = await createHarness()
  const idleLogin = await idle.service.login(PASSWORD, '192.0.2.21')
  idle.clock.value += ADMIN_IDLE_TTL_MS
  await expectCode(
    () => idle.service.authenticate(idleLogin.sessionToken),
    'ADMIN_SESSION_EXPIRED'
  )

  const logout = await createHarness()
  const logoutLogin = await logout.service.login(PASSWORD, '192.0.2.22')
  assert.deepStrictEqual(logout.service.logout(
    logoutLogin.sessionToken,
    logoutLogin.csrfToken
  ), {
    revoked: true
  })
  await expectCode(
    () => logout.service.authenticate(logoutLogin.sessionToken),
    'ADMIN_SESSION_INVALID'
  )
}

async function testCsrfAndReauthentication() {
  const harness = await createHarness()
  assert.deepStrictEqual(
    await harness.service.reauthenticate(PASSWORD, '198.51.100.30'),
    { authenticated: true }
  )
  assert.strictEqual(
    harness.database.prepare('SELECT COUNT(*) AS count FROM admin_sessions').get().count,
    0
  )

  const login = await harness.service.login(PASSWORD, '198.51.100.30')
  assert.strictEqual(
    harness.service.verifyCsrf(login.sessionToken, login.csrfToken),
    true
  )
  await expectCode(
    () => harness.service.verifyCsrf(login.sessionToken, 'wrong-csrf'),
    'ADMIN_CSRF_INVALID'
  )
}

async function testRejectedCsrfDoesNotTouchSession() {
  const harness = await createHarness()
  const login = await harness.service.login(PASSWORD, '198.51.100.31')
  const selectSession = harness.database.prepare(`
    SELECT last_used_at, idle_expires_at
    FROM admin_sessions
    WHERE session_id = ?
  `)
  const countAuthenticatedAudit = () => Number(harness.database.prepare(`
    SELECT COUNT(*) AS count
    FROM admin_auth_audit
    WHERE event_type = 'admin_session_authenticated'
  `).get().count)
  const beforeSession = selectSession.get(login.sessionId)
  const beforeAuditCount = countAuthenticatedAudit()

  harness.clock.value += 5 * 60 * 1000
  await expectCode(
    () => harness.service.verifyCsrf(login.sessionToken, 'wrong-csrf'),
    'ADMIN_CSRF_INVALID'
  )
  assert.deepStrictEqual(selectSession.get(login.sessionId), beforeSession)
  assert.strictEqual(countAuthenticatedAudit(), beforeAuditCount)

  assert.strictEqual(
    harness.service.verifyCsrf(login.sessionToken, login.csrfToken),
    true
  )
  const afterValidCsrf = selectSession.get(login.sessionId)
  assert.strictEqual(afterValidCsrf.last_used_at, harness.clock.value)
  assert.strictEqual(
    afterValidCsrf.idle_expires_at,
    harness.clock.value + ADMIN_IDLE_TTL_MS
  )
  assert.strictEqual(countAuthenticatedAudit(), beforeAuditCount + 1)
}

async function testLogoutRequiresCsrfWithoutTouch() {
  const harness = await createHarness()
  const login = await harness.service.login(PASSWORD, '198.51.100.32')
  const selectSession = harness.database.prepare(`
    SELECT last_used_at, idle_expires_at, revoked_at
    FROM admin_sessions
    WHERE session_id = ?
  `)
  const authenticatedAuditCount = () => harness.database.prepare(`
    SELECT COUNT(*) AS count
    FROM admin_auth_audit
    WHERE event_type = 'admin_session_authenticated'
  `).get().count
  const before = selectSession.get(login.sessionId)
  const beforeAudit = authenticatedAuditCount()
  harness.clock.value += 5 * 60 * 1000

  await expectCode(
    () => harness.service.logout(login.sessionToken, 'wrong-csrf'),
    'ADMIN_CSRF_INVALID'
  )
  assert.deepStrictEqual(selectSession.get(login.sessionId), before)
  assert.strictEqual(authenticatedAuditCount(), beforeAudit)
  assert.strictEqual(harness.service.authenticate(login.sessionToken).sessionId, login.sessionId)

  assert.deepStrictEqual(
    harness.service.logout(login.sessionToken, login.csrfToken),
    { revoked: true }
  )
  assert.strictEqual(selectSession.get(login.sessionId).revoked_at, harness.clock.value)
}

async function testParsedVerifierBuffersAreCleared() {
  const contract = require('../security/secret-bootstrap-contract')
  const adminAuthPath = require.resolve('../security/admin-auth')
  const originalParser = contract.parseAdminPasswordVerifier
  let parsed
  contract.parseAdminPasswordVerifier = () => parsed
  delete require.cache[adminAuthPath]
  try {
    const { AdminAuthService: FreshAdminAuthService } = require('../security/admin-auth')
    const repository = { findSessionByTokenDigest() {} }
    parsed = {
      digest: Buffer.alloc(32, 21),
      format: 'kinvest-admin-scrypt-v1',
      n: 65536,
      p: 1,
      r: 8,
      salt: Buffer.alloc(16, 22)
    }
    const digest = parsed.digest
    const salt = parsed.salt
    const service = new FreshAdminAuthService({
      repository,
      adminVerifierMaterial: 'synthetic',
      rateLimitKey: Buffer.alloc(32, 23)
    })
    assert.strictEqual(digest.every((value) => value === 0), true)
    assert.strictEqual(salt.every((value) => value === 0), true)
    service.clear()

    parsed = {
      digest: Buffer.alloc(32, 24),
      format: 'kinvest-admin-scrypt-v1',
      n: 65536,
      p: 1,
      r: 8,
      salt: Buffer.alloc(16, 25)
    }
    const failureDigest = parsed.digest
    const failureSalt = parsed.salt
    assert.throws(() => new FreshAdminAuthService({
      repository,
      adminVerifierMaterial: 'synthetic',
      rateLimitKey: 'short'
    }), (error) => error !== null && typeof error === 'object' &&
      'code' in error && error.code === 'ADMIN_AUTH_CONFIG_INVALID')
    assert.strictEqual(failureDigest.every((value) => value === 0), true)
    assert.strictEqual(failureSalt.every((value) => value === 0), true)
  } finally {
    contract.parseAdminPasswordVerifier = originalParser
    delete require.cache[adminAuthPath]
  }
}

async function testClearIsIdempotent() {
  const harness = await createHarness()
  harness.service.clear()
  harness.service.clear()
  await expectCode(
    () => harness.service.reauthenticate(PASSWORD, '192.0.2.40'),
    'ADMIN_AUTH_CONFIG_INVALID'
  )
  await expectCode(
    () => harness.service.login(PASSWORD, '192.0.2.40'),
    'ADMIN_AUTH_CONFIG_INVALID'
  )
}

async function testCsrfRefreshIsAtomicAndRevokesPreviousToken() {
  const harness = await createHarness()
  const login = await harness.service.login(PASSWORD, '192.0.2.71')
  const before = harness.repository.findSessionByTokenDigest(
    crypto.createHash('sha256').update(login.sessionToken).digest('base64url')
  )
  const refreshed = harness.service.refreshCsrf(login.sessionToken)

  assert.equal(Buffer.from(refreshed.csrfToken, 'base64url').length, 32)
  assert.notEqual(refreshed.csrfToken, login.csrfToken)
  assert.equal(refreshed.idleExpiresAt, harness.clock.value + ADMIN_IDLE_TTL_MS)
  await expectCode(
    () => harness.service.verifyCsrf(login.sessionToken, login.csrfToken),
    'ADMIN_CSRF_INVALID'
  )
  assert.equal(
    harness.service.verifyCsrf(login.sessionToken, refreshed.csrfToken),
    true
  )
  const after = harness.repository.findSessionByTokenDigest(before.tokenDigest)
  assert.notEqual(after.csrfDigest, before.csrfDigest)
  const serialized = JSON.stringify(harness.repository.listAuditEvents())
  assert.equal(serialized.includes(refreshed.csrfToken), false)
}

async function run() {
  await testPasswordMatchingAndValidation()
  await testRateLimitIsolationAndReset()
  await testConcurrentAttemptReservations()
  await testMalformedPasswordsCountTowardRateLimit()
  await testRateLimitIdentityValidation()
  await testLoginSettlementRollback()
  await testStaleReauthenticationSettlementFailsClosed()
  await testSecretStorageAndAuditRedaction()
  await testIdleAbsoluteExpiryAndLogout()
  await testCsrfAndReauthentication()
  await testRejectedCsrfDoesNotTouchSession()
  await testLogoutRequiresCsrfWithoutTouch()
  await testCsrfRefreshIsAtomicAndRevokesPreviousToken()
  await testClearIsIdempotent()
  await testParsedVerifierBuffersAreCleared()
}

module.exports = {
  run,
  testConcurrentAttemptReservations,
  testCsrfRefreshIsAtomicAndRevokesPreviousToken,
  testLoginSettlementRollback,
  testLogoutRequiresCsrfWithoutTouch,
  testMalformedPasswordsCountTowardRateLimit,
  testParsedVerifierBuffersAreCleared,
  testRateLimitIdentityValidation,
  testRejectedCsrfDoesNotTouchSession,
  testStaleReauthenticationSettlementFailsClosed
}

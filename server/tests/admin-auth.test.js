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
  assert.deepStrictEqual(logout.service.logout(logoutLogin.sessionToken), {
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

async function run() {
  await testPasswordMatchingAndValidation()
  await testRateLimitIsolationAndReset()
  await testSecretStorageAndAuditRedaction()
  await testIdleAbsoluteExpiryAndLogout()
  await testCsrfAndReauthentication()
  await testClearIsIdempotent()
}

module.exports = { run }

const assert = require('assert')
const crypto = require('crypto')
const { DatabaseSync } = require('node:sqlite')
const {
  MockSecretProvider,
  isValidSecretName,
  isValidVersionId
} = require('../security/secret-provider')
const { DeviceAuthRepository } = require('../db/device-auth-repository')
const {
  DAY_MS,
  DeviceApprovalService
} = require('../security/device-approval')

const SECRET_NAME = 'kinvest-prod-device-token-hmac-key'
const VERSION_ONE = 'v20260731-001'
const VERSION_TWO = 'v20260731-002'

function createRandomSource() {
  let counter = 0
  return (size) => {
    counter += 1
    const chunks = []
    while (Buffer.concat(chunks).length < size) {
      chunks.push(crypto.createHash('sha256').update(`test-random-${counter}-${chunks.length}`).digest())
    }
    return Buffer.concat(chunks).subarray(0, size)
  }
}

function createHarness(options = {}) {
  const database = new DatabaseSync(':memory:')
  const repository = new DeviceAuthRepository(database)
  repository.initialize()

  const clock = {
    value: options.now || Date.UTC(2026, 6, 31, 8, 0, 0)
  }
  const secretProvider = new MockSecretProvider({
    [`${SECRET_NAME}:${VERSION_ONE}`]: 'synthetic-hmac-key-one',
    [`${SECRET_NAME}:${VERSION_TWO}`]: 'synthetic-hmac-key-two'
  })
  const service = new DeviceApprovalService({
    repository,
    secretProvider,
    hmacSecretName: SECRET_NAME,
    activeHmacVersionId: options.activeHmacVersionId || VERSION_ONE,
    now: () => clock.value,
    randomBytes: createRandomSource()
  })

  return { clock, database, repository, secretProvider, service }
}

function expectCode(callback, expectedCode) {
  assert.throws(callback, (error) => {
    assert.ok(error && typeof error === 'object' && 'code' in error)
    assert.strictEqual(error.code, expectedCode)
    return true
  })
}

function installAuditFailure(database, eventType) {
  assert.match(eventType, /^[a-z_]+$/)
  database.exec(`
    CREATE TEMP TRIGGER fail_selected_audit
    BEFORE INSERT ON device_auth_audit
    WHEN NEW.event_type = '${eventType}'
    BEGIN
      SELECT RAISE(ABORT, 'AUDIT_WRITE_FAILED');
    END;
  `)
}

function expectAuditFailure(callback) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof Error)
    assert.strictEqual(error.message.includes('AUDIT_WRITE_FAILED'), true)
    return true
  })
}

function countRows(database, tableName) {
  assert.match(tableName, /^[a-z_]+$/)
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count)
}

function issueDevice(harness) {
  const request = harness.service.createRequest()
  harness.service.approveRequest({
    requestId: request.requestId,
    requestCode: request.requestCode,
    adminAuthenticated: true
  })
  const credential = harness.service.redeemRequest({
    requestId: request.requestId,
    browserCredential: request.browserCredential
  })
  return { credential, request }
}

function testSecretProviderContract() {
  assert.strictEqual(isValidSecretName('A_b-9'), true)
  assert.strictEqual(isValidSecretName('a'.repeat(128)), true)
  assert.strictEqual(isValidSecretName('a'.repeat(129)), false)
  assert.strictEqual(isValidSecretName('kinvest/prod'), false)
  assert.strictEqual(isValidSecretName(''), false)

  assert.strictEqual(isValidVersionId('v20260731-001.alpha'), true)
  assert.strictEqual(isValidVersionId('v'.repeat(64)), true)
  assert.strictEqual(isValidVersionId('v'.repeat(65)), false)
  assert.strictEqual(isValidVersionId('version/current'), false)
  assert.strictEqual(isValidVersionId(''), false)

  const provider = new MockSecretProvider({
    [`${SECRET_NAME}:${VERSION_ONE}`]: 'synthetic-secret-value'
  })
  assert.strictEqual(
    provider.readSecret({ secretName: SECRET_NAME, versionId: VERSION_ONE }),
    'synthetic-secret-value'
  )
  expectCode(
    () => provider.readSecret({ secretName: SECRET_NAME }),
    'SECRET_REFERENCE_INVALID'
  )
  expectCode(
    () => provider.readSecret({ secretName: 'bad/name', versionId: VERSION_ONE }),
    'SECRET_REFERENCE_INVALID'
  )

  try {
    provider.readSecret({ secretName: SECRET_NAME, versionId: VERSION_TWO })
    assert.fail('missing secret should fail')
  } catch (error) {
    assert.strictEqual(error.code, 'SECRET_NOT_FOUND')
    assert.strictEqual(error.message.includes('synthetic-secret-value'), false)
    assert.strictEqual(error.message.includes(SECRET_NAME), false)
    assert.strictEqual(error.message.includes(VERSION_TWO), false)
  }
}

function testRequestApprovalAndRedemption() {
  const harness = createHarness()
  const request = harness.service.createRequest()

  assert.strictEqual(Buffer.from(request.browserCredential, 'base64url').length, 32)
  assert.strictEqual(request.expiresAt - harness.clock.value, 10 * 60 * 1000)

  const storedRequest = harness.database.prepare(
    'SELECT request_code_digest, browser_credential_digest FROM device_auth_requests WHERE request_id = ?'
  ).get(request.requestId)
  assert.notStrictEqual(storedRequest.request_code_digest, request.requestCode)
  assert.notStrictEqual(
    storedRequest.request_code_digest,
    crypto.createHash('sha256')
      .update(`${request.requestId}:${request.requestCode}`)
      .digest('base64url')
  )
  assert.notStrictEqual(storedRequest.browser_credential_digest, request.browserCredential)
  assert.strictEqual(JSON.stringify(storedRequest).includes(request.requestCode), false)
  assert.strictEqual(JSON.stringify(storedRequest).includes(request.browserCredential), false)

  expectCode(() => harness.service.approveRequest({
    requestId: request.requestId,
    requestCode: request.requestCode,
    adminAuthenticated: false
  }), 'ADMIN_AUTH_REQUIRED')

  expectCode(() => harness.service.redeemRequest({
    requestId: request.requestId,
    browserCredential: request.browserCredential
  }), 'REQUEST_NOT_APPROVED')

  harness.service.approveRequest({
    requestId: request.requestId,
    requestCode: request.requestCode,
    adminAuthenticated: true
  })
  expectCode(() => harness.service.redeemRequest({
    requestId: request.requestId,
    browserCredential: 'wrong-browser-credential'
  }), 'REQUEST_BROWSER_MISMATCH')

  const credential = harness.service.redeemRequest({
    requestId: request.requestId,
    browserCredential: request.browserCredential
  })
  assert.strictEqual(Buffer.from(credential.token, 'base64url').length, 32)
  assert.strictEqual(credential.cookie.secure, true)
  assert.strictEqual(credential.cookie.httpOnly, true)
  assert.strictEqual(credential.cookie.sameSite, 'Strict')
  expectCode(() => harness.service.redeemRequest({
    requestId: request.requestId,
    browserCredential: request.browserCredential
  }), 'REQUEST_ALREADY_USED')
}

function testRequestExpiryAndAttemptLock() {
  const expired = createHarness()
  const expiredRequest = expired.service.createRequest()
  expired.clock.value += (10 * 60 * 1000) + 1
  expectCode(() => expired.service.approveRequest({
    requestId: expiredRequest.requestId,
    requestCode: expiredRequest.requestCode,
    adminAuthenticated: true
  }), 'REQUEST_EXPIRED')

  const locked = createHarness()
  const lockedRequest = locked.service.createRequest()
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    expectCode(() => locked.service.approveRequest({
      requestId: lockedRequest.requestId,
      requestCode: `wrong-${attempt}`,
      adminAuthenticated: true
    }), attempt === 5 ? 'REQUEST_LOCKED' : 'REQUEST_CODE_INVALID')
  }
  expectCode(() => locked.service.approveRequest({
    requestId: lockedRequest.requestId,
    requestCode: lockedRequest.requestCode,
    adminAuthenticated: true
  }), 'REQUEST_LOCKED')
}

function testApprovedRequestIsIdempotentBeforeCodeValidation() {
  const harness = createHarness()
  const request = harness.service.createRequest()
  harness.service.approveRequest({
    requestId: request.requestId,
    requestCode: request.requestCode,
    adminAuthenticated: true
  })

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.deepStrictEqual(harness.service.approveRequest({
      requestId: request.requestId,
      requestCode: `wrong-after-approval-${attempt}`,
      adminAuthenticated: true
    }), {
      approved: true,
      requestId: request.requestId
    })
  }

  const stored = harness.repository.getRequest(request.requestId)
  assert.strictEqual(stored.failedAttempts, 0)
  assert.strictEqual(stored.lockedAt, null)
  assert.strictEqual(harness.service.redeemRequest({
    requestId: request.requestId,
    browserCredential: request.browserCredential
  }).token.length > 0, true)

  const expired = createHarness()
  const expiredRequest = expired.service.createRequest()
  expired.service.approveRequest({
    requestId: expiredRequest.requestId,
    requestCode: expiredRequest.requestCode,
    adminAuthenticated: true
  })
  expired.clock.value += (10 * 60 * 1000) + 1
  expectCode(() => expired.service.approveRequest({
    requestId: expiredRequest.requestId,
    requestCode: 'wrong-after-expiry',
    adminAuthenticated: true
  }), 'REQUEST_EXPIRED')
}

function testTokenStorageAndExplicitHmacVersion() {
  const harness = createHarness()
  const { credential } = issueDevice(harness)
  const stored = harness.database.prepare(
    'SELECT token_digest, hmac_version_id FROM device_credentials WHERE credential_id = ?'
  ).get(credential.credentialId)

  assert.notStrictEqual(stored.token_digest, credential.token)
  assert.strictEqual(stored.hmac_version_id, VERSION_ONE)
  assert.strictEqual(JSON.stringify(stored).includes(credential.token), false)

  harness.service.setActiveHmacVersionId(VERSION_TWO)
  const authenticated = harness.service.authenticate(credential.token)
  assert.strictEqual(authenticated.authenticated, true)
  assert.strictEqual(authenticated.hmacVersionId, VERSION_ONE)

  const second = issueDevice(harness).credential
  const secondStored = harness.database.prepare(
    'SELECT hmac_version_id FROM device_credentials WHERE credential_id = ?'
  ).get(second.credentialId)
  assert.strictEqual(secondStored.hmac_version_id, VERSION_TWO)
}

function testRotationAndConcurrentGrace() {
  const harness = createHarness()
  const { credential } = issueDevice(harness)

  harness.service.setActiveHmacVersionId(VERSION_TWO)
  harness.clock.value += 30 * DAY_MS
  const rotation = harness.service.authenticate(credential.token)
  assert.strictEqual(rotation.authenticated, true)
  assert.strictEqual(rotation.rotated, true)
  assert.strictEqual(Buffer.from(rotation.token, 'base64url').length, 32)
  assert.notStrictEqual(rotation.token, credential.token)
  assert.strictEqual(rotation.cookie.secure, true)
  assert.strictEqual(rotation.credentialId, credential.credentialId)
  assert.strictEqual(rotation.hmacVersionId, VERSION_ONE)
  assert.strictEqual(typeof rotation.replacementCredentialId, 'string')
  assert.strictEqual(rotation.replacementHmacVersionId, VERSION_TWO)

  const afterFirstRotation = harness.repository.getCredential(credential.credentialId)
  const originalGraceExpiry = afterFirstRotation.replacementGraceExpiresAt
  const oldDuringGrace = harness.service.authenticate(credential.token)
  assert.strictEqual(oldDuringGrace.authenticated, true)
  assert.strictEqual(oldDuringGrace.concurrentGrace, true)
  assert.strictEqual(oldDuringGrace.rotated, true)
  assert.strictEqual(oldDuringGrace.token, rotation.token)
  assert.strictEqual(oldDuringGrace.credentialId, credential.credentialId)
  assert.strictEqual(oldDuringGrace.hmacVersionId, VERSION_ONE)
  assert.strictEqual(
    oldDuringGrace.replacementCredentialId,
    rotation.replacementCredentialId
  )
  assert.strictEqual(oldDuringGrace.replacementHmacVersionId, VERSION_TWO)
  assert.strictEqual(oldDuringGrace.cookie.sameSite, 'Strict')
  const oldRecord = harness.repository.getCredential(credential.credentialId)
  const replacementRecord = harness.repository.getCredential(
    rotation.replacementCredentialId
  )
  assert.strictEqual(oldRecord.deviceId, replacementRecord.deviceId)
  assert.strictEqual(oldRecord.replacementGraceExpiresAt, originalGraceExpiry)
  assert.strictEqual(harness.service.authenticate(rotation.token).authenticated, true)

  harness.clock.value += (5 * 60 * 1000) + 1
  expectCode(() => harness.service.authenticate(credential.token), 'TOKEN_INVALID')
  assert.strictEqual(harness.service.authenticate(rotation.token).authenticated, true)
}

function testIdleAndAbsoluteExpiryBoundaries() {
  const idleHarness = createHarness()
  const idleCredential = issueDevice(idleHarness).credential
  idleHarness.clock.value += 89 * DAY_MS
  const idleRotation = idleHarness.service.authenticate(idleCredential.token)
  assert.strictEqual(idleRotation.rotated, true)
  const idleRecord = idleHarness.repository.getCredential(
    idleRotation.replacementCredentialId
  )
  assert.strictEqual(
    idleRecord.idleExpiresAt,
    Math.min(idleHarness.clock.value + (90 * DAY_MS), idleRecord.absoluteExpiresAt)
  )

  idleHarness.clock.value = idleRecord.idleExpiresAt
  expectCode(() => idleHarness.service.authenticate(idleRotation.token), 'TOKEN_INVALID')

  const absoluteHarness = createHarness()
  const absoluteCredential = issueDevice(absoluteHarness).credential
  const absoluteRecord = absoluteHarness.repository.getCredential(absoluteCredential.credentialId)
  let activeToken = absoluteCredential.token
  while (absoluteHarness.clock.value + (29 * DAY_MS) < absoluteRecord.absoluteExpiresAt - DAY_MS) {
    absoluteHarness.clock.value += 29 * DAY_MS
    const authentication = absoluteHarness.service.authenticate(activeToken)
    if (authentication.rotated) {
      activeToken = authentication.token
    }
  }
  absoluteHarness.clock.value = absoluteRecord.absoluteExpiresAt - DAY_MS
  const beforeAbsoluteExpiry = absoluteHarness.service.authenticate(activeToken)
  assert.strictEqual(beforeAbsoluteExpiry.authenticated, true)
  if (beforeAbsoluteExpiry.rotated) {
    activeToken = beforeAbsoluteExpiry.token
  }
  const activeCredentialId = beforeAbsoluteExpiry.rotated
    ? beforeAbsoluteExpiry.replacementCredentialId
    : beforeAbsoluteExpiry.credentialId
  const activeRecord = absoluteHarness.repository.getCredential(
    activeCredentialId
  )
  assert.strictEqual(activeRecord.absoluteExpiresAt, absoluteRecord.absoluteExpiresAt)
  assert.strictEqual(activeRecord.idleExpiresAt, absoluteRecord.absoluteExpiresAt)

  absoluteHarness.clock.value = absoluteRecord.absoluteExpiresAt
  expectCode(() => absoluteHarness.service.authenticate(activeToken), 'TOKEN_INVALID')
}

function testRevocationAndVersionDeletionProtection() {
  const harness = createHarness()
  const first = issueDevice(harness).credential
  harness.service.setActiveHmacVersionId(VERSION_TWO)
  const second = issueDevice(harness).credential

  assert.deepStrictEqual(
    harness.service.getReferencedHmacVersionIds(),
    [VERSION_ONE, VERSION_TWO]
  )
  expectCode(
    () => harness.service.assertHmacVersionDeletable(VERSION_ONE),
    'HMAC_VERSION_IN_USE'
  )

  assert.deepStrictEqual(harness.service.revokeCredential(first.credentialId), {
    devicesRevoked: 1,
    credentialsRevoked: 1
  })
  assert.deepStrictEqual(harness.service.revokeCredential(first.credentialId), {
    devicesRevoked: 0,
    credentialsRevoked: 0
  })
  assert.strictEqual(
    harness.repository.listAuditEvents()
      .filter((event) => event.eventType === 'device_revoked').length,
    1
  )
  expectCode(() => harness.service.authenticate(first.token), 'TOKEN_INVALID')
  assert.deepStrictEqual(harness.service.getReferencedHmacVersionIds(), [VERSION_TWO])
  assert.strictEqual(harness.service.assertHmacVersionDeletable(VERSION_ONE), true)

  const third = issueDevice(harness).credential
  assert.deepStrictEqual(harness.service.revokeByHmacVersion(VERSION_TWO), {
    devicesMatched: 2,
    credentialsRevoked: 2
  })
  expectCode(() => harness.service.authenticate(second.token), 'TOKEN_INVALID')
  expectCode(() => harness.service.authenticate(third.token), 'TOKEN_INVALID')
  assert.deepStrictEqual(harness.service.getReferencedHmacVersionIds(), [])

  harness.service.setActiveHmacVersionId(VERSION_ONE)
  const fourth = issueDevice(harness).credential
  const fifth = issueDevice(harness).credential
  assert.strictEqual(harness.service.revokeAllCredentials(), 2)
  expectCode(() => harness.service.authenticate(fourth.token), 'TOKEN_INVALID')
  expectCode(() => harness.service.authenticate(fifth.token), 'TOKEN_INVALID')
}

function testLogicalDeviceRevocationAcrossRotation() {
  const harness = createHarness()
  const original = issueDevice(harness).credential
  harness.service.setActiveHmacVersionId(VERSION_TWO)
  harness.clock.value += 30 * DAY_MS
  const replacement = harness.service.authenticate(original.token)

  const result = harness.service.revokeCredential(original.credentialId)
  assert.deepStrictEqual(result, {
    devicesRevoked: 1,
    credentialsRevoked: 2
  })
  expectCode(() => harness.service.authenticate(original.token), 'TOKEN_INVALID')
  expectCode(() => harness.service.authenticate(replacement.token), 'TOKEN_INVALID')
}

function testExpiredVersionIsNotReadAndLeakRevokesReplacement() {
  const harness = createHarness()
  const original = issueDevice(harness).credential
  harness.service.setActiveHmacVersionId(VERSION_TWO)
  harness.clock.value += 30 * DAY_MS
  const replacement = harness.service.authenticate(original.token)
  harness.clock.value += (5 * 60 * 1000) + 1

  assert.deepStrictEqual(
    harness.repository.listCredentialCandidates(harness.clock.value)
      .map((credential) => credential.credentialId),
    [replacement.replacementCredentialId]
  )
  assert.strictEqual(harness.secretProvider.deleteEntry({
    secretName: SECRET_NAME,
    versionId: VERSION_ONE
  }), true)
  assert.strictEqual(harness.service.authenticate(replacement.token).authenticated, true)
  assert.deepStrictEqual(harness.service.getReferencedHmacVersionIds(), [VERSION_TWO])

  assert.deepStrictEqual(harness.service.revokeByHmacVersion(VERSION_ONE), {
    devicesMatched: 1,
    credentialsRevoked: 2
  })
  expectCode(() => harness.service.authenticate(original.token), 'TOKEN_INVALID')
  expectCode(() => harness.service.authenticate(replacement.token), 'TOKEN_INVALID')
}

function testMissingActiveVersionDoesNotBlockOtherDevices() {
  const harness = createHarness()
  const versionOneCredential = issueDevice(harness).credential
  harness.service.setActiveHmacVersionId(VERSION_TWO)
  const versionTwoCredential = issueDevice(harness).credential
  assert.strictEqual(harness.secretProvider.deleteEntry({
    secretName: SECRET_NAME,
    versionId: VERSION_ONE
  }), true)

  assert.strictEqual(
    harness.service.authenticate(versionTwoCredential.token).authenticated,
    true
  )
  try {
    harness.service.authenticate(versionOneCredential.token)
    assert.fail('missing active key must fail')
  } catch (error) {
    assert.ok(error && typeof error === 'object' && 'code' in error)
    assert.strictEqual(error.code, 'TOKEN_KEY_UNAVAILABLE')
    assert.strictEqual(error.message.includes(SECRET_NAME), false)
    assert.strictEqual(error.message.includes(VERSION_ONE), false)
    assert.strictEqual(error.message.includes('synthetic-hmac-key-one'), false)
  }
}

function testStateAndAuditAreAtomic() {
  const creation = createHarness()
  installAuditFailure(creation.database, 'device_request_created')
  expectAuditFailure(() => creation.service.createRequest())
  assert.strictEqual(countRows(creation.database, 'device_auth_requests'), 0)

  const failedAttempt = createHarness()
  const failedRequest = failedAttempt.service.createRequest()
  installAuditFailure(failedAttempt.database, 'device_request_code_rejected')
  expectAuditFailure(() => failedAttempt.service.approveRequest({
    requestId: failedRequest.requestId,
    requestCode: 'wrong-code',
    adminAuthenticated: true
  }))
  assert.strictEqual(failedAttempt.repository.getRequest(failedRequest.requestId).failedAttempts, 0)

  const approval = createHarness()
  const approvalRequest = approval.service.createRequest()
  installAuditFailure(approval.database, 'device_request_approved')
  expectAuditFailure(() => approval.service.approveRequest({
    requestId: approvalRequest.requestId,
    requestCode: approvalRequest.requestCode,
    adminAuthenticated: true
  }))
  assert.strictEqual(approval.repository.getRequest(approvalRequest.requestId).approvedAt, null)

  const redemption = createHarness()
  const redemptionRequest = redemption.service.createRequest()
  redemption.service.approveRequest({
    requestId: redemptionRequest.requestId,
    requestCode: redemptionRequest.requestCode,
    adminAuthenticated: true
  })
  installAuditFailure(redemption.database, 'device_credential_issued')
  expectAuditFailure(() => redemption.service.redeemRequest({
    requestId: redemptionRequest.requestId,
    browserCredential: redemptionRequest.browserCredential
  }))
  assert.strictEqual(redemption.repository.getRequest(redemptionRequest.requestId).consumedAt, null)
  assert.strictEqual(countRows(redemption.database, 'device_credentials'), 0)

  const sliding = createHarness()
  const slidingCredential = issueDevice(sliding).credential
  const beforeSliding = sliding.repository.getCredential(slidingCredential.credentialId)
  sliding.clock.value += DAY_MS
  installAuditFailure(sliding.database, 'device_credential_authenticated')
  expectAuditFailure(() => sliding.service.authenticate(slidingCredential.token))
  const afterSliding = sliding.repository.getCredential(slidingCredential.credentialId)
  assert.strictEqual(afterSliding.lastUsedAt, beforeSliding.lastUsedAt)
  assert.strictEqual(afterSliding.idleExpiresAt, beforeSliding.idleExpiresAt)

  const rotation = createHarness()
  const rotationCredential = issueDevice(rotation).credential
  rotation.clock.value += 30 * DAY_MS
  installAuditFailure(rotation.database, 'device_credential_rotated')
  expectAuditFailure(() => rotation.service.authenticate(rotationCredential.token))
  assert.strictEqual(
    rotation.repository.getCredential(rotationCredential.credentialId)
      .replacementCredentialId,
    null
  )
  assert.strictEqual(countRows(rotation.database, 'device_credentials'), 1)

  const singleRevocation = createHarness()
  const singleCredential = issueDevice(singleRevocation).credential
  installAuditFailure(singleRevocation.database, 'device_revoked')
  expectAuditFailure(() => singleRevocation.service.revokeCredential(
    singleCredential.credentialId
  ))
  assert.strictEqual(singleRevocation.service.authenticate(singleCredential.token).authenticated, true)

  const allRevocation = createHarness()
  const allCredential = issueDevice(allRevocation).credential
  installAuditFailure(allRevocation.database, 'device_credentials_revoked_all')
  expectAuditFailure(() => allRevocation.service.revokeAllCredentials())
  assert.strictEqual(allRevocation.service.authenticate(allCredential.token).authenticated, true)

  const versionRevocation = createHarness()
  const versionCredential = issueDevice(versionRevocation).credential
  installAuditFailure(versionRevocation.database, 'device_credentials_revoked_hmac_version')
  expectAuditFailure(() => versionRevocation.service.revokeByHmacVersion(VERSION_ONE))
  assert.strictEqual(versionRevocation.service.authenticate(versionCredential.token).authenticated, true)
}

function testAuditDoesNotContainSecrets() {
  const harness = createHarness()
  const request = harness.service.createRequest()
  harness.service.approveRequest({
    requestId: request.requestId,
    requestCode: request.requestCode,
    adminAuthenticated: true
  })
  const credential = harness.service.redeemRequest({
    requestId: request.requestId,
    browserCredential: request.browserCredential
  })
  harness.service.authenticate(credential.token)

  const audit = JSON.stringify(harness.repository.listAuditEvents())
  const forbidden = [
    request.requestCode,
    request.browserCredential,
    credential.token,
    'synthetic-hmac-key-one',
    'synthetic-hmac-key-two'
  ]
  for (const value of forbidden) {
    assert.strictEqual(audit.includes(value), false)
  }
}

async function run() {
  testSecretProviderContract()
  testRequestApprovalAndRedemption()
  testRequestExpiryAndAttemptLock()
  testApprovedRequestIsIdempotentBeforeCodeValidation()
  testTokenStorageAndExplicitHmacVersion()
  testRotationAndConcurrentGrace()
  testIdleAndAbsoluteExpiryBoundaries()
  testRevocationAndVersionDeletionProtection()
  testLogicalDeviceRevocationAcrossRotation()
  testExpiredVersionIsNotReadAndLeakRevokesReplacement()
  testMissingActiveVersionDoesNotBlockOtherDevices()
  testStateAndAuditAreAtomic()
  testAuditDoesNotContainSecrets()
}

module.exports = { run }

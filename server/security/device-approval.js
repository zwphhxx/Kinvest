const crypto = require('crypto')
const { validateSecretReference } = require('./secret-provider')

const DAY_MS = 24 * 60 * 60 * 1000
const REQUEST_TTL_MS = 10 * 60 * 1000
const REQUEST_MAX_ATTEMPTS = 5
const TOKEN_ROTATION_MS = 30 * DAY_MS
const TOKEN_GRACE_MS = 5 * 60 * 1000
const TOKEN_IDLE_MS = 90 * DAY_MS
const TOKEN_ABSOLUTE_MS = 365 * DAY_MS

const ERROR_MESSAGES = {
  ADMIN_AUTH_REQUIRED: 'Administrator authentication is required',
  HMAC_VERSION_IN_USE: 'The HMAC version is referenced by an active credential',
  REQUEST_ALREADY_USED: 'The request has already been used',
  REQUEST_BROWSER_MISMATCH: 'The browser request credential does not match',
  REQUEST_CODE_INVALID: 'The request code is invalid',
  REQUEST_EXPIRED: 'The request has expired',
  REQUEST_LOCKED: 'The request is locked',
  REQUEST_NOT_APPROVED: 'The request is not approved',
  REQUEST_NOT_FOUND: 'The request is unavailable',
  TOKEN_EXPIRED: 'The device credential has expired',
  TOKEN_INVALID: 'The device credential is invalid',
  TOKEN_REPLACED: 'The device credential has been replaced'
}

class DeviceApprovalError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] || 'Device approval failed')
    this.name = 'DeviceApprovalError'
    this.code = code
  }
}

function hashValue(value) {
  return crypto.createHash('sha256').update(value).digest('base64url')
}

function hmacToken(secret, token) {
  return crypto.createHmac('sha256', secret).update(token).digest('base64url')
}

function digestsEqual(left, right) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function cookieContract() {
  return {
    secure: true,
    httpOnly: true,
    sameSite: 'Strict'
  }
}

class DeviceApprovalService {
  constructor({
    repository,
    secretProvider,
    hmacSecretName,
    activeHmacVersionId,
    now = Date.now,
    randomBytes = crypto.randomBytes
  }) {
    validateSecretReference({
      secretName: hmacSecretName,
      versionId: activeHmacVersionId
    })
    this.repository = repository
    this.secretProvider = secretProvider
    this.hmacSecretName = hmacSecretName
    this.activeHmacVersionId = activeHmacVersionId
    this.now = now
    this.randomBytes = randomBytes
  }

  setActiveHmacVersionId(versionId) {
    validateSecretReference({
      secretName: this.hmacSecretName,
      versionId
    })
    this.activeHmacVersionId = versionId
  }

  createRequest() {
    const now = this.now()
    const requestId = this.randomBytes(16).toString('base64url')
    const browserCredential = this.randomBytes(32).toString('base64url')
    const codeNumber = this.randomBytes(4).readUInt32BE(0) % 1000000
    const requestCode = String(codeNumber).padStart(6, '0')
    const expiresAt = now + REQUEST_TTL_MS

    this.repository.insertRequest({
      requestId,
      requestCodeDigest: hashValue(`${requestId}:${requestCode}`),
      browserCredentialDigest: hashValue(browserCredential),
      createdAt: now,
      expiresAt
    })
    this.repository.addAuditEvent('device_request_created', now, requestId, { requestId })

    return {
      requestId,
      browserCredential,
      requestCode,
      expiresAt
    }
  }

  approveRequest({ requestId, requestCode, adminAuthenticated }) {
    if (adminAuthenticated !== true) {
      throw new DeviceApprovalError('ADMIN_AUTH_REQUIRED')
    }

    const now = this.now()
    const request = this.requireRequest(requestId)
    if (request.consumedAt !== null) {
      throw new DeviceApprovalError('REQUEST_ALREADY_USED')
    }
    if (request.lockedAt !== null || request.failedAttempts >= REQUEST_MAX_ATTEMPTS) {
      throw new DeviceApprovalError('REQUEST_LOCKED')
    }
    if (now >= request.expiresAt) {
      throw new DeviceApprovalError('REQUEST_EXPIRED')
    }

    const suppliedDigest = hashValue(`${requestId}:${requestCode}`)
    if (!digestsEqual(suppliedDigest, request.requestCodeDigest)) {
      const updated = this.repository.recordFailedAttempt(
        requestId,
        now,
        REQUEST_MAX_ATTEMPTS
      )
      this.repository.addAuditEvent('device_request_code_rejected', now, requestId, {
        requestId,
        count: updated.failedAttempts
      })
      throw new DeviceApprovalError(
        updated.lockedAt !== null ? 'REQUEST_LOCKED' : 'REQUEST_CODE_INVALID'
      )
    }

    if (!this.repository.approveRequest(requestId, now)) {
      throw new DeviceApprovalError('REQUEST_NOT_FOUND')
    }
    this.repository.addAuditEvent('device_request_approved', now, requestId, { requestId })
    return { approved: true, requestId }
  }

  redeemRequest({ requestId, browserCredential }) {
    const now = this.now()
    const request = this.requireRequest(requestId)
    if (request.consumedAt !== null) {
      throw new DeviceApprovalError('REQUEST_ALREADY_USED')
    }
    if (request.lockedAt !== null) {
      throw new DeviceApprovalError('REQUEST_LOCKED')
    }
    if (now >= request.expiresAt) {
      throw new DeviceApprovalError('REQUEST_EXPIRED')
    }
    if (request.approvedAt === null) {
      throw new DeviceApprovalError('REQUEST_NOT_APPROVED')
    }
    if (!digestsEqual(hashValue(browserCredential), request.browserCredentialDigest)) {
      throw new DeviceApprovalError('REQUEST_BROWSER_MISMATCH')
    }

    const issued = this.createCredential({
      approvedAt: request.approvedAt,
      absoluteExpiresAt: request.approvedAt + TOKEN_ABSOLUTE_MS,
      hmacVersionId: this.activeHmacVersionId,
      now
    })
    if (!this.repository.consumeRequestAndInsertCredential(
      requestId,
      now,
      issued.record
    )) {
      throw new DeviceApprovalError('REQUEST_ALREADY_USED')
    }
    this.repository.addAuditEvent(
      'device_credential_issued',
      now,
      issued.record.credentialId,
      {
        credentialId: issued.record.credentialId,
        hmacVersionId: issued.record.hmacVersionId
      }
    )

    return {
      credentialId: issued.record.credentialId,
      token: issued.token,
      hmacVersionId: issued.record.hmacVersionId,
      idleExpiresAt: issued.record.idleExpiresAt,
      absoluteExpiresAt: issued.record.absoluteExpiresAt,
      rotated: false,
      cookie: cookieContract()
    }
  }

  authenticate(token) {
    const now = this.now()
    const credential = this.findCredentialForToken(token)
    if (!credential) {
      throw new DeviceApprovalError('TOKEN_INVALID')
    }
    if (now >= credential.absoluteExpiresAt || now >= credential.idleExpiresAt) {
      throw new DeviceApprovalError('TOKEN_EXPIRED')
    }

    if (credential.replacementCredentialId) {
      if (now >= credential.replacementGraceExpiresAt) {
        throw new DeviceApprovalError('TOKEN_REPLACED')
      }
      return {
        authenticated: true,
        credentialId: credential.replacementCredentialId,
        hmacVersionId: credential.hmacVersionId,
        rotated: false,
        concurrentGrace: true
      }
    }

    if (now - credential.rotatedAt >= TOKEN_ROTATION_MS) {
      return this.rotateCredential(credential, now)
    }

    const idleExpiresAt = Math.min(now + TOKEN_IDLE_MS, credential.absoluteExpiresAt)
    this.repository.updateCredentialUse(credential.credentialId, now, idleExpiresAt)
    this.repository.addAuditEvent(
      'device_credential_authenticated',
      now,
      credential.credentialId,
      { credentialId: credential.credentialId }
    )
    return {
      authenticated: true,
      credentialId: credential.credentialId,
      hmacVersionId: credential.hmacVersionId,
      rotated: false,
      concurrentGrace: false,
      idleExpiresAt,
      absoluteExpiresAt: credential.absoluteExpiresAt
    }
  }

  revokeCredential(credentialId) {
    const now = this.now()
    const count = this.repository.revokeCredential(credentialId, now)
    if (count > 0) {
      this.repository.addAuditEvent('device_credential_revoked', now, credentialId, {
        credentialId,
        count
      })
    }
    return count
  }

  revokeAllCredentials() {
    const now = this.now()
    const count = this.repository.revokeAllCredentials(now)
    this.repository.addAuditEvent('device_credentials_revoked_all', now, null, { count })
    return count
  }

  revokeByHmacVersion(hmacVersionId) {
    validateSecretReference({
      secretName: this.hmacSecretName,
      versionId: hmacVersionId
    })
    const now = this.now()
    const count = this.repository.revokeByHmacVersion(hmacVersionId, now)
    this.repository.addAuditEvent('device_credentials_revoked_hmac_version', now, null, {
      hmacVersionId,
      count
    })
    return count
  }

  getReferencedHmacVersionIds() {
    return this.repository.getReferencedHmacVersionIds(this.now())
  }

  assertHmacVersionDeletable(hmacVersionId) {
    validateSecretReference({
      secretName: this.hmacSecretName,
      versionId: hmacVersionId
    })
    if (this.getReferencedHmacVersionIds().includes(hmacVersionId)) {
      throw new DeviceApprovalError('HMAC_VERSION_IN_USE')
    }
    return true
  }

  requireRequest(requestId) {
    const request = this.repository.getRequest(requestId)
    if (!request) {
      throw new DeviceApprovalError('REQUEST_NOT_FOUND')
    }
    return request
  }

  readHmacSecret(hmacVersionId) {
    return this.secretProvider.readSecret({
      secretName: this.hmacSecretName,
      versionId: hmacVersionId
    })
  }

  createCredential({ approvedAt, absoluteExpiresAt, hmacVersionId, now }) {
    const token = this.randomBytes(32).toString('base64url')
    const secret = this.readHmacSecret(hmacVersionId)
    const credentialId = this.randomBytes(16).toString('base64url')
    return {
      token,
      record: {
        credentialId,
        tokenDigest: hmacToken(secret, token),
        hmacVersionId,
        approvedAt,
        rotatedAt: now,
        lastUsedAt: now,
        idleExpiresAt: Math.min(now + TOKEN_IDLE_MS, absoluteExpiresAt),
        absoluteExpiresAt
      }
    }
  }

  findCredentialForToken(token) {
    const secrets = new Map()
    for (const credential of this.repository.listCredentialCandidates()) {
      if (!secrets.has(credential.hmacVersionId)) {
        secrets.set(
          credential.hmacVersionId,
          this.readHmacSecret(credential.hmacVersionId)
        )
      }
      const digest = hmacToken(secrets.get(credential.hmacVersionId), token)
      if (digestsEqual(digest, credential.tokenDigest)) {
        return credential
      }
    }
    return null
  }

  rotateCredential(credential, now) {
    const issued = this.createCredential({
      approvedAt: credential.approvedAt,
      absoluteExpiresAt: credential.absoluteExpiresAt,
      hmacVersionId: this.activeHmacVersionId,
      now
    })
    const graceExpiresAt = now + TOKEN_GRACE_MS
    if (!this.repository.rotateCredential(
      credential.credentialId,
      issued.record,
      graceExpiresAt
    )) {
      throw new DeviceApprovalError('TOKEN_REPLACED')
    }
    this.repository.addAuditEvent(
      'device_credential_rotated',
      now,
      credential.credentialId,
      {
        credentialId: credential.credentialId,
        replacementCredentialId: issued.record.credentialId,
        hmacVersionId: issued.record.hmacVersionId
      }
    )
    return {
      authenticated: true,
      credentialId: issued.record.credentialId,
      token: issued.token,
      hmacVersionId: issued.record.hmacVersionId,
      idleExpiresAt: issued.record.idleExpiresAt,
      absoluteExpiresAt: issued.record.absoluteExpiresAt,
      rotated: true,
      concurrentGrace: false,
      cookie: cookieContract()
    }
  }
}

module.exports = {
  DAY_MS,
  DeviceApprovalError,
  DeviceApprovalService,
  REQUEST_MAX_ATTEMPTS,
  REQUEST_TTL_MS,
  TOKEN_ABSOLUTE_MS,
  TOKEN_GRACE_MS,
  TOKEN_IDLE_MS,
  TOKEN_ROTATION_MS
}

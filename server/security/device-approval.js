const crypto = require('crypto')
const {
  SecretProviderError,
  validateSecretReference
} = require('./secret-provider')

const DAY_MS = 24 * 60 * 60 * 1000
const REQUEST_TTL_MS = 10 * 60 * 1000
const REQUEST_MAX_ATTEMPTS = 5
const TOKEN_ROTATION_MS = 30 * DAY_MS
const TOKEN_GRACE_MS = 5 * 60 * 1000
const TOKEN_IDLE_MS = 90 * DAY_MS
const TOKEN_ABSOLUTE_MS = 365 * DAY_MS

const ERROR_MESSAGES = {
  ADMIN_AUTH_REQUIRED: 'Administrator authentication is required',
  DEVICE_NAME_INVALID: 'The device name is invalid',
  HMAC_VERSION_IN_USE: 'The HMAC version is referenced by an active credential',
  IP_DIGEST_INVALID: 'The IP digest is invalid',
  REQUEST_ALREADY_USED: 'The request has already been used',
  REQUEST_BROWSER_MISMATCH: 'The browser request credential does not match',
  REQUEST_CODE_INVALID: 'The request code is invalid',
  REQUEST_EXPIRED: 'The request has expired',
  REQUEST_LOCKED: 'The request is locked',
  REQUEST_NOT_APPROVED: 'The request is not approved',
  REQUEST_NOT_FOUND: 'The request is unavailable',
  TOKEN_EXPIRED: 'The device credential has expired',
  TOKEN_INVALID: 'The device credential is invalid',
  TOKEN_KEY_UNAVAILABLE: 'A required device credential key is unavailable',
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

function hashRequestCode(requestId, requestCode) {
  return crypto.scryptSync(
    String(requestCode),
    `kinvest-device-request-code-v1:${requestId}`,
    32,
    {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024
    }
  ).toString('base64url')
}

function hmacToken(secret, token) {
  return crypto.createHmac('sha256', secret).update(token).digest('base64url')
}

function deriveReplacementToken(secret, token, credentialId) {
  return crypto.createHmac('sha256', secret)
    .update('kinvest-device-token-rotation-v1')
    .update('\0')
    .update(credentialId)
    .update('\0')
    .update(token)
    .digest('base64url')
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

function normalizeDeviceName(value) {
  if (typeof value !== 'string') {
    throw new DeviceApprovalError('DEVICE_NAME_INVALID')
  }
  const normalized = value.trim().normalize('NFC')
  const characters = Array.from(normalized)
  if (characters.length < 1 || characters.length > 40 ||
    Buffer.byteLength(normalized, 'utf8') > 160 ||
    characters.some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
    })) {
    throw new DeviceApprovalError('DEVICE_NAME_INVALID')
  }
  return normalized
}

function normalizeIpDigest(value) {
  if (value === null) return null
  if (typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new DeviceApprovalError('IP_DIGEST_INVALID')
  }
  return value
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

  createRequest({ deviceName, ipDigest = null } = {}) {
    const normalizedDeviceName = normalizeDeviceName(deviceName)
    const normalizedIpDigest = normalizeIpDigest(ipDigest)
    const now = this.now()
    const requestId = this.randomBytes(16).toString('base64url')
    const browserCredential = this.randomBytes(32).toString('base64url')
    const codeNumber = this.randomBytes(4).readUInt32BE(0) % 1000000
    const requestCode = String(codeNumber).padStart(6, '0')
    const expiresAt = now + REQUEST_TTL_MS

    this.repository.runInImmediateTransaction(() => {
      this.repository.insertRequest({
        requestId,
        deviceName: normalizedDeviceName,
        ipDigest: normalizedIpDigest,
        requestCodeDigest: hashRequestCode(requestId, requestCode),
        browserCredentialDigest: hashValue(browserCredential),
        createdAt: now,
        expiresAt
      })
      this.repository.addAuditEvent('device_request_created', now, requestId, { requestId })
    })

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
    if (request.approvedAt !== null) {
      return { approved: true, requestId }
    }

    const suppliedDigest = hashRequestCode(requestId, requestCode)
    if (!digestsEqual(suppliedDigest, request.requestCodeDigest)) {
      const updated = this.repository.runInImmediateTransaction(() => {
        const failedRequest = this.repository.recordFailedAttempt(
          requestId,
          now,
          REQUEST_MAX_ATTEMPTS
        )
        if (failedRequest.approvedAt === null) {
          this.repository.addAuditEvent(
            'device_request_code_rejected',
            now,
            requestId,
            {
              requestId,
              count: failedRequest.failedAttempts
            }
          )
        }
        return failedRequest
      })
      if (updated.approvedAt !== null) {
        return { approved: true, requestId }
      }
      throw new DeviceApprovalError(
        updated.lockedAt !== null ? 'REQUEST_LOCKED' : 'REQUEST_CODE_INVALID'
      )
    }

    this.repository.runInImmediateTransaction(() => {
      if (!this.repository.approveRequest(requestId, now)) {
        throw new DeviceApprovalError('REQUEST_NOT_FOUND')
      }
      this.repository.addAuditEvent('device_request_approved', now, requestId, { requestId })
    })
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

    const credentialSecret = this.readHmacSecret(this.activeHmacVersionId)
    let issued
    try {
      issued = this.createCredential({
        approvedAt: request.approvedAt,
        absoluteExpiresAt: request.approvedAt + TOKEN_ABSOLUTE_MS,
        hmacVersionId: this.activeHmacVersionId,
        deviceId: this.randomBytes(16).toString('base64url'),
        deviceName: request.deviceName === null
          ? null
          : normalizeDeviceName(request.deviceName),
        now,
        secret: credentialSecret
      })
    } finally {
      if (Buffer.isBuffer(credentialSecret)) credentialSecret.fill(0)
    }
    this.repository.runInImmediateTransaction(() => {
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
          deviceId: issued.record.deviceId,
          hmacVersionId: issued.record.hmacVersionId
        }
      )
    })

    return {
      credentialId: issued.record.credentialId,
      deviceId: issued.record.deviceId,
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
    const credential = this.findCredentialForToken(token, now)
    if (!credential) {
      throw new DeviceApprovalError('TOKEN_INVALID')
    }
    if (now >= credential.absoluteExpiresAt || now >= credential.idleExpiresAt) {
      throw new DeviceApprovalError('TOKEN_EXPIRED')
    }

    if (credential.replacementCredentialId) {
      const replacement = this.repository.getCredential(
        credential.replacementCredentialId
      )
      if (!replacement) throw new DeviceApprovalError('TOKEN_INVALID')
      const replacementSecret = this.readHmacSecretOrUnavailable(
        replacement.hmacVersionId
      )
      try {
        const replacementToken = deriveReplacementToken(
          replacementSecret,
          token,
          credential.credentialId
        )
        if (!digestsEqual(
          hmacToken(replacementSecret, replacementToken),
          replacement.tokenDigest
        )) {
          throw new DeviceApprovalError('TOKEN_INVALID')
        }
        const replacementIdleExpiresAt = Math.min(
          now + TOKEN_IDLE_MS,
          replacement.absoluteExpiresAt
        )
        const touched = this.repository.runInImmediateTransaction(() => {
          const updated = this.repository.updateReplacementUseDuringGrace({
            oldCredentialId: credential.credentialId,
            replacementCredentialId: replacement.credentialId,
            lastUsedAt: now,
            idleExpiresAt: replacementIdleExpiresAt
          })
          if (!updated) return false
          this.repository.addAuditEvent(
            'device_credential_authenticated',
            now,
            replacement.credentialId,
            {
              credentialId: replacement.credentialId,
              deviceId: replacement.deviceId
            }
          )
          return true
        })
        if (!touched) throw new DeviceApprovalError('TOKEN_INVALID')
        return {
          authenticated: true,
          credentialId: credential.credentialId,
          deviceId: credential.deviceId,
          hmacVersionId: credential.hmacVersionId,
          replacementCredentialId: replacement.credentialId,
          replacementHmacVersionId: replacement.hmacVersionId,
          token: replacementToken,
          rotated: true,
          concurrentGrace: true,
          cookie: cookieContract()
        }
      } finally {
        if (Buffer.isBuffer(replacementSecret)) replacementSecret.fill(0)
      }
    }

    if (now - credential.rotatedAt >= TOKEN_ROTATION_MS) {
      return this.rotateCredential(credential, token, now)
    }

    const idleExpiresAt = Math.min(now + TOKEN_IDLE_MS, credential.absoluteExpiresAt)
    const touched = this.repository.runInImmediateTransaction(() => {
      if (!this.repository.updateCredentialUse(
        credential.credentialId,
        now,
        idleExpiresAt
      )) return false
      this.repository.addAuditEvent(
        'device_credential_authenticated',
        now,
        credential.credentialId,
        {
          credentialId: credential.credentialId,
          deviceId: credential.deviceId
        }
      )
      return true
    })
    if (!touched) throw new DeviceApprovalError('TOKEN_INVALID')
    return {
      authenticated: true,
      credentialId: credential.credentialId,
      deviceId: credential.deviceId,
      hmacVersionId: credential.hmacVersionId,
      rotated: false,
      concurrentGrace: false,
      idleExpiresAt,
      absoluteExpiresAt: credential.absoluteExpiresAt
    }
  }

  revokeCredential(credentialId) {
    const now = this.now()
    return this.repository.runInImmediateTransaction(() => {
      const result = this.repository.revokeCredential(credentialId, now)
      const response = {
        devicesRevoked: result.credentialsRevoked > 0 ? 1 : 0,
        credentialsRevoked: result.credentialsRevoked
      }
      if (response.devicesRevoked > 0) {
        this.repository.addAuditEvent('device_revoked', now, result.deviceId, {
          deviceId: result.deviceId,
          credentialId,
          devicesRevoked: response.devicesRevoked,
          credentialsRevoked: response.credentialsRevoked
        })
      }
      return response
    })
  }

  revokeAllCredentials() {
    const now = this.now()
    return this.repository.runInImmediateTransaction(() => {
      const count = this.repository.revokeAllCredentials(now)
      this.repository.addAuditEvent('device_credentials_revoked_all', now, null, { count })
      return count
    })
  }

  revokeByHmacVersion(hmacVersionId) {
    validateSecretReference({
      secretName: this.hmacSecretName,
      versionId: hmacVersionId
    })
    const now = this.now()
    return this.repository.runInImmediateTransaction(() => {
      const result = this.repository.revokeByHmacVersion(hmacVersionId, now)
      this.repository.addAuditEvent('device_credentials_revoked_hmac_version', now, null, {
        hmacVersionId,
        devicesMatched: result.devicesMatched,
        credentialsRevoked: result.credentialsRevoked
      })
      return result
    })
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

  createCredential({
    approvedAt,
    absoluteExpiresAt,
    hmacVersionId,
    deviceId,
    deviceName,
    now,
    token = this.randomBytes(32).toString('base64url'),
    secret
  }) {
    const credentialId = this.randomBytes(16).toString('base64url')
    return {
      token,
      record: {
        credentialId,
        deviceId,
        deviceName,
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

  findCredentialForToken(token, now) {
    const secrets = new Map()
    const unavailableVersions = new Set()
    let hasUnavailableVersion = false
    try {
      for (const credential of this.repository.listCredentialCandidates(now)) {
        if (unavailableVersions.has(credential.hmacVersionId)) continue
        if (!secrets.has(credential.hmacVersionId)) {
          try {
            secrets.set(
              credential.hmacVersionId,
              this.readHmacSecret(credential.hmacVersionId)
            )
          } catch (error) {
            if (
              error instanceof SecretProviderError &&
              error.code === 'SECRET_NOT_FOUND'
            ) {
              unavailableVersions.add(credential.hmacVersionId)
              hasUnavailableVersion = true
              continue
            }
            throw error
          }
        }
        const digest = hmacToken(secrets.get(credential.hmacVersionId), token)
        if (digestsEqual(digest, credential.tokenDigest)) {
          return credential
        }
      }
      if (hasUnavailableVersion) {
        throw new DeviceApprovalError('TOKEN_KEY_UNAVAILABLE')
      }
      return null
    } finally {
      for (const secret of secrets.values()) {
        if (Buffer.isBuffer(secret)) secret.fill(0)
      }
      secrets.clear()
    }
  }

  readHmacSecretOrUnavailable(hmacVersionId) {
    try {
      return this.readHmacSecret(hmacVersionId)
    } catch (error) {
      if (
        error instanceof SecretProviderError &&
        error.code === 'SECRET_NOT_FOUND'
      ) {
        throw new DeviceApprovalError('TOKEN_KEY_UNAVAILABLE')
      }
      throw error
    }
  }

  rotateCredential(credential, rawToken, now) {
    const replacementHmacVersionId = this.activeHmacVersionId
    const replacementSecret = this.readHmacSecretOrUnavailable(
      replacementHmacVersionId
    )
    try {
      const replacementToken = deriveReplacementToken(
        replacementSecret,
        rawToken,
        credential.credentialId
      )
      const issued = this.createCredential({
        approvedAt: credential.approvedAt,
        absoluteExpiresAt: credential.absoluteExpiresAt,
        hmacVersionId: replacementHmacVersionId,
        deviceId: credential.deviceId,
        deviceName: credential.deviceName,
        now,
        token: replacementToken,
        secret: replacementSecret
      })
      const graceExpiresAt = now + TOKEN_GRACE_MS
      this.repository.runInImmediateTransaction(() => {
        if (!this.repository.rotateCredential(
          credential.credentialId,
          issued.record,
          graceExpiresAt,
          now
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
            deviceId: credential.deviceId,
            hmacVersionId: issued.record.hmacVersionId
          }
        )
      })
      return {
        authenticated: true,
        credentialId: credential.credentialId,
        deviceId: issued.record.deviceId,
        hmacVersionId: credential.hmacVersionId,
        replacementCredentialId: issued.record.credentialId,
        replacementHmacVersionId: issued.record.hmacVersionId,
        token: replacementToken,
        idleExpiresAt: issued.record.idleExpiresAt,
        absoluteExpiresAt: issued.record.absoluteExpiresAt,
        rotated: true,
        concurrentGrace: false,
        cookie: cookieContract()
      }
    } finally {
      if (Buffer.isBuffer(replacementSecret)) replacementSecret.fill(0)
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

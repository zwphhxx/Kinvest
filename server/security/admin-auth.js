const crypto = require('node:crypto')

const {
  parseAdminPasswordVerifier
} = require('./secret-bootstrap-contract')

const ADMIN_IDLE_TTL_MS = 30 * 60 * 1000
const ADMIN_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000
const ADMIN_MAX_FAILURES = 5
const RATE_LIMIT_SCOPE = 'admin-login-ip-v1'
const RATE_LIMIT_DOMAIN = 'kinvest-admin-login-rate-limit-v1\0'

class AdminAuthError extends Error {
  constructor(code) {
    const messages = {
      ADMIN_AUTH_CONFIG_INVALID: 'Administrator authentication is not configured',
      ADMIN_AUTH_INVALID: 'Administrator credentials are invalid',
      ADMIN_AUTH_RATE_LIMITED: 'Administrator authentication is temporarily blocked',
      ADMIN_CSRF_INVALID: 'The CSRF token is invalid',
      ADMIN_SESSION_EXPIRED: 'The administrator session has expired',
      ADMIN_SESSION_INVALID: 'The administrator session is invalid'
    }
    super(messages[code] || 'Administrator authentication failed')
    this.name = 'AdminAuthError'
    this.code = code
  }
}

function fail(code) {
  throw new AdminAuthError(code)
}

function copyRateLimitKey(value) {
  if (Buffer.isBuffer(value)) {
    if (value.length < 16) fail('ADMIN_AUTH_CONFIG_INVALID')
    return Buffer.from(value)
  }
  if (typeof value === 'string') {
    const encoded = Buffer.from(value, 'utf8')
    if (encoded.length < 16) fail('ADMIN_AUTH_CONFIG_INVALID')
    return encoded
  }
  fail('ADMIN_AUTH_CONFIG_INVALID')
}

function digestPublicToken(token) {
  if (typeof token !== 'string' || token.length < 1 || token.length > 1024) {
    return null
  }
  return crypto.createHash('sha256').update(token, 'utf8').digest('base64url')
}

class AdminAuthService {
  constructor({
    repository,
    adminVerifierMaterial,
    rateLimitKey,
    now = Date.now,
    randomBytes = crypto.randomBytes
  }) {
    if (!repository || typeof repository.findSessionByTokenDigest !== 'function' ||
      typeof now !== 'function' || typeof randomBytes !== 'function') {
      fail('ADMIN_AUTH_CONFIG_INVALID')
    }

    let verifier
    let key
    try {
      verifier = parseAdminPasswordVerifier(adminVerifierMaterial)
      key = copyRateLimitKey(rateLimitKey)
      const verifierDigest = verifier.digest
      if (!Buffer.isBuffer(verifier.salt) || !Buffer.isBuffer(verifierDigest) ||
        verifier.salt.length !== 16 || verifierDigest.length !== 32 ||
        verifier.n !== 65536 || verifier.p !== 1 || verifier.r !== 8) {
        fail('ADMIN_AUTH_CONFIG_INVALID')
      }
      this.verifierSalt = Buffer.from(verifier.salt)
      this.verifierDigest = Buffer.from(verifierDigest)
    } catch {
      if (key) key.fill(0)
      fail('ADMIN_AUTH_CONFIG_INVALID')
    } finally {
      if (verifier && Buffer.isBuffer(verifier.digest)) verifier.digest.fill(0)
      if (verifier && Buffer.isBuffer(verifier.salt)) verifier.salt.fill(0)
    }

    this.repository = repository
    this.rateLimitKey = key
    this.now = now
    this.randomBytes = randomBytes
    this.cleared = false
  }

  assertConfigured() {
    if (this.cleared) fail('ADMIN_AUTH_CONFIG_INVALID')
  }

  validatePassword(password) {
    if (typeof password !== 'string' || password.length === 0 ||
      [...password].length > 128 || Buffer.byteLength(password, 'utf8') > 512) {
      fail('ADMIN_AUTH_INVALID')
    }
  }

  rateLimitIdentityDigest(rateLimitIdentity) {
    if (typeof rateLimitIdentity !== 'string' || rateLimitIdentity.length === 0 ||
      Buffer.byteLength(rateLimitIdentity, 'utf8') > 256 ||
      [...rateLimitIdentity].some((character) => {
        const codePoint = character.codePointAt(0)
        return codePoint <= 0x1f || codePoint === 0x7f
      })) {
      fail('ADMIN_AUTH_INVALID')
    }
    return crypto.createHmac('sha256', this.rateLimitKey)
      .update(RATE_LIMIT_DOMAIN, 'utf8')
      .update(rateLimitIdentity, 'utf8')
      .digest('base64url')
  }

  auditEvent(eventType, occurredAt, subjectId, metadata = {}) {
    return {
      eventId: this.randomToken(16),
      eventType,
      occurredAt,
      subjectId,
      metadata
    }
  }

  randomToken(size) {
    const generated = this.randomBytes(size)
    if (!Buffer.isBuffer(generated) || generated.length !== size) {
      fail('ADMIN_AUTH_CONFIG_INVALID')
    }
    return Buffer.from(generated).toString('base64url')
  }

  async passwordMatches(password) {
    let derived
    try {
      derived = await new Promise((resolve, reject) => {
        crypto.scrypt(password, this.verifierSalt, 32, {
          N: 65536,
          p: 1,
          r: 8,
          maxmem: 128 * 1024 * 1024
        }, (error, value) => {
          if (error) reject(error)
          else resolve(value)
        })
      })
      return crypto.timingSafeEqual(derived, this.verifierDigest)
    } catch {
      fail('ADMIN_AUTH_CONFIG_INVALID')
    } finally {
      if (Buffer.isBuffer(derived)) derived.fill(0)
    }
  }

  async verifyPasswordWithRateLimit(password, rateLimitIdentity) {
    this.assertConfigured()
    const keyDigest = this.rateLimitIdentityDigest(rateLimitIdentity)
    const now = this.now()
    const reservation = this.repository.reserveAttempt({
      scope: RATE_LIMIT_SCOPE,
      keyDigest,
      now,
      windowMs: ADMIN_LOGIN_WINDOW_MS,
      maxAttempts: ADMIN_MAX_FAILURES
    })
    if (!reservation.allowed) {
      fail('ADMIN_AUTH_RATE_LIMITED')
    }

    let passwordIsValid = true
    try {
      this.validatePassword(password)
    } catch (error) {
      if (!(error instanceof AdminAuthError) || error.code !== 'ADMIN_AUTH_INVALID') {
        throw error
      }
      passwordIsValid = false
    }
    if (!passwordIsValid || !await this.passwordMatches(password)) {
      const settledAt = this.now()
      this.repository.settleRateLimitFailure({
        reservation,
        windowMs: ADMIN_LOGIN_WINDOW_MS,
        maxFailures: ADMIN_MAX_FAILURES,
        auditEvent: this.auditEvent(
          'admin_password_rejected',
          settledAt,
          null,
          { reason: 'invalid-password' }
        )
      })
      fail('ADMIN_AUTH_INVALID')
    }
    return { reservation, now: this.now() }
  }

  async login(password, rateLimitIdentity) {
    const verified = await this.verifyPasswordWithRateLimit(password, rateLimitIdentity)
    const sessionId = this.randomToken(16)
    const sessionToken = this.randomToken(32)
    const csrfToken = this.randomToken(32)
    const absoluteExpiresAt = verified.now + ADMIN_ABSOLUTE_TTL_MS
    const idleExpiresAt = verified.now + ADMIN_IDLE_TTL_MS
    this.repository.completeLogin({
      reservation: verified.reservation,
      session: {
        sessionId,
        tokenDigest: digestPublicToken(sessionToken),
        csrfDigest: digestPublicToken(csrfToken),
        createdAt: verified.now,
        lastUsedAt: verified.now,
        idleExpiresAt,
        absoluteExpiresAt,
        revokedAt: null
      },
      auditEvent: this.auditEvent(
        'admin_session_created',
        verified.now,
        sessionId,
        { sessionId }
      )
    })
    return {
      sessionId,
      sessionToken,
      csrfToken,
      idleExpiresAt,
      absoluteExpiresAt
    }
  }

  async reauthenticate(password, rateLimitIdentity) {
    const verified = await this.verifyPasswordWithRateLimit(password, rateLimitIdentity)
    const settled = this.repository.settleRateLimitSuccess({
      reservation: verified.reservation,
      auditEvent: this.auditEvent(
        'admin_password_reauthenticated',
        verified.now,
        null,
        { reason: 'reauthenticated' }
      )
    })
    if (!settled) fail('ADMIN_AUTH_RATE_LIMITED')
    return { authenticated: true }
  }

  getActiveSession(sessionToken, touch) {
    this.assertConfigured()
    const tokenDigest = digestPublicToken(sessionToken)
    if (!tokenDigest) fail('ADMIN_SESSION_INVALID')
    const session = this.repository.findSessionByTokenDigest(tokenDigest)
    if (!session || session.revokedAt !== null) fail('ADMIN_SESSION_INVALID')
    const now = this.now()
    if (now >= session.idleExpiresAt || now >= session.absoluteExpiresAt) {
      fail('ADMIN_SESSION_EXPIRED')
    }
    const idleExpiresAt = Math.min(now + ADMIN_IDLE_TTL_MS, session.absoluteExpiresAt)
    if (touch) {
      const updated = this.repository.updateSessionUsage(
        session.sessionId,
        now,
        idleExpiresAt,
        this.auditEvent(
          'admin_session_authenticated',
          now,
          session.sessionId,
          { sessionId: session.sessionId }
        )
      )
      if (!updated) fail('ADMIN_SESSION_INVALID')
    }
    return { ...session, lastUsedAt: now, idleExpiresAt }
  }

  authenticate(sessionToken) {
    const session = this.getActiveSession(sessionToken, true)
    return {
      sessionId: session.sessionId,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt
    }
  }

  verifyCsrf(sessionToken, csrfToken) {
    const session = this.getActiveSession(sessionToken, false)
    this.assertCsrf(session, csrfToken)
    const updated = this.repository.updateSessionUsage(
      session.sessionId,
      session.lastUsedAt,
      session.idleExpiresAt,
      this.auditEvent(
        'admin_session_authenticated',
        session.lastUsedAt,
        session.sessionId,
        { sessionId: session.sessionId }
      )
    )
    if (!updated) fail('ADMIN_SESSION_INVALID')
    return true
  }

  assertCsrf(session, csrfToken) {
    const csrfDigest = digestPublicToken(csrfToken)
    if (!csrfDigest) fail('ADMIN_CSRF_INVALID')
    const expected = Buffer.from(session.csrfDigest, 'base64url')
    const actual = Buffer.from(csrfDigest, 'base64url')
    const valid = expected.length === actual.length &&
      crypto.timingSafeEqual(expected, actual)
    expected.fill(0)
    actual.fill(0)
    if (!valid) fail('ADMIN_CSRF_INVALID')
  }

  logout(sessionToken, csrfToken) {
    const session = this.getActiveSession(sessionToken, false)
    this.assertCsrf(session, csrfToken)
    const now = this.now()
    const revoked = this.repository.revokeSession(
      session.sessionId,
      now,
      this.auditEvent(
        'admin_session_revoked',
        now,
        session.sessionId,
        { reason: 'logout', sessionId: session.sessionId }
      )
    )
    if (!revoked) fail('ADMIN_SESSION_INVALID')
    return { revoked: true }
  }

  clear() {
    if (this.cleared) return
    this.verifierDigest.fill(0)
    this.verifierSalt.fill(0)
    this.rateLimitKey.fill(0)
    this.cleared = true
  }
}

module.exports = {
  ADMIN_ABSOLUTE_TTL_MS,
  ADMIN_IDLE_TTL_MS,
  ADMIN_LOGIN_WINDOW_MS,
  ADMIN_MAX_FAILURES,
  AdminAuthError,
  AdminAuthService
}

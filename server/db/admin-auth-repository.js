const crypto = require('node:crypto')

const AUDIT_METADATA_KEYS = new Set(['count', 'reason', 'sessionId'])

function mapSession(row) {
  if (!row) return null
  return {
    sessionId: row.session_id,
    tokenDigest: row.token_digest,
    csrfDigest: row.csrf_digest,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    revokedAt: row.revoked_at
  }
}

function mapRateLimit(row) {
  if (!row) return null
  return {
    scope: row.scope,
    keyDigest: row.key_digest,
    windowStartedAt: row.window_started_at,
    failureCount: row.failure_count,
    inFlightCount: row.in_flight_count,
    blockedUntil: row.blocked_until
  }
}

function digestsEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const expected = Buffer.from(left, 'base64url')
  const actual = Buffer.from(right, 'base64url')
  return expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
}

function sanitizeMetadata(metadata) {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {}
  }
  const sanitized = {}
  for (const key of ['count', 'reason', 'sessionId']) {
    const value = metadata[key]
    if (!AUDIT_METADATA_KEYS.has(key) || value === undefined) continue
    if (key === 'count' && Number.isSafeInteger(value) && value >= 0) {
      sanitized[key] = value
    }
    if (key !== 'count' && typeof value === 'string') {
      sanitized[key] = value
    }
  }
  return sanitized
}

class AdminAuthRepository {
  constructor(database) {
    this.database = database
  }

  initialize() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS admin_sessions (
        session_id TEXT PRIMARY KEY,
        token_digest TEXT NOT NULL UNIQUE,
        csrf_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        idle_expires_at INTEGER NOT NULL,
        absolute_expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS auth_rate_limits (
        scope TEXT NOT NULL,
        key_digest TEXT NOT NULL,
        window_started_at INTEGER NOT NULL,
        failure_count INTEGER NOT NULL,
        in_flight_count INTEGER NOT NULL DEFAULT 0,
        blocked_until INTEGER,
        PRIMARY KEY (scope, key_digest)
      );

      CREATE TABLE IF NOT EXISTS admin_auth_audit (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        subject_id TEXT,
        metadata_json TEXT NOT NULL
      );
    `)
    const rateLimitColumns = this.database.prepare(
      'PRAGMA table_info(auth_rate_limits)'
    ).all()
    if (!rateLimitColumns.some((column) => column.name === 'in_flight_count')) {
      this.database.exec(`
        ALTER TABLE auth_rate_limits
        ADD COLUMN in_flight_count INTEGER NOT NULL DEFAULT 0
      `)
    }
  }

  withImmediateTransaction(operation) {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  insertAudit(event) {
    this.database.prepare(`
      INSERT INTO admin_auth_audit (
        event_id, event_type, occurred_at, subject_id, metadata_json
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.eventType,
      event.occurredAt,
      event.subjectId ?? null,
      JSON.stringify(sanitizeMetadata(event.metadata))
    )
  }

  appendAudit(event) {
    this.insertAudit(event)
  }

  listAuditEvents() {
    return this.database.prepare(`
      SELECT event_id, event_type, occurred_at, subject_id, metadata_json
      FROM admin_auth_audit
      ORDER BY occurred_at, event_id
    `).all().map((row) => ({
      eventId: row.event_id,
      eventType: row.event_type,
      occurredAt: row.occurred_at,
      subjectId: row.subject_id,
      metadata: JSON.parse(row.metadata_json)
    }))
  }

  insertSession(session) {
    this.database.prepare(`
      INSERT INTO admin_sessions (
        session_id, token_digest, csrf_digest, created_at, last_used_at,
        idle_expires_at, absolute_expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.sessionId,
      session.tokenDigest,
      session.csrfDigest,
      session.createdAt,
      session.lastUsedAt,
      session.idleExpiresAt,
      session.absoluteExpiresAt,
      session.revokedAt ?? null
    )
  }

  createSession(session, auditEvent = null) {
    return this.withImmediateTransaction(() => {
      this.insertSession(session)
      if (auditEvent) this.insertAudit(auditEvent)
      return mapSession(this.database.prepare(
        'SELECT * FROM admin_sessions WHERE session_id = ?'
      ).get(session.sessionId))
    })
  }

  completeLogin({ reservation, session, auditEvent }) {
    return this.withImmediateTransaction(() => {
      const settlement = this.database.prepare(`
        UPDATE auth_rate_limits
        SET failure_count = 0,
            in_flight_count = in_flight_count - 1,
            blocked_until = NULL
        WHERE scope = ? AND key_digest = ? AND window_started_at = ?
          AND in_flight_count > 0
      `).run(
        reservation.scope,
        reservation.keyDigest,
        reservation.windowStartedAt
      )
      if (settlement.changes !== 1) {
        throw new Error('Admin authentication reservation is unavailable')
      }
      this.insertSession(session)
      this.insertAudit(auditEvent)
      return mapSession(this.database.prepare(
        'SELECT * FROM admin_sessions WHERE session_id = ?'
      ).get(session.sessionId))
    })
  }

  findSessionByTokenDigest(tokenDigest) {
    return mapSession(this.database.prepare(
      'SELECT * FROM admin_sessions WHERE token_digest = ?'
    ).get(tokenDigest))
  }

  updateSessionUsage(sessionId, lastUsedAt, idleExpiresAt, auditEvent = null) {
    return this.withImmediateTransaction(() => {
      const result = this.database.prepare(`
        UPDATE admin_sessions
        SET last_used_at = ?, idle_expires_at = ?
        WHERE session_id = ? AND revoked_at IS NULL
      `).run(lastUsedAt, idleExpiresAt, sessionId)
      if (result.changes > 0 && auditEvent) this.insertAudit(auditEvent)
      return result.changes > 0
    })
  }

  verifyAndTouchSession({
    tokenDigest,
    expectedCsrfDigest,
    now,
    idleTtlMs,
    auditEvent
  }) {
    return this.withImmediateTransaction(() => {
      const session = this.findSessionByTokenDigest(tokenDigest)
      if (!session || session.revokedAt !== null) return { status: 'session_invalid' }
      if (now >= session.idleExpiresAt || now >= session.absoluteExpiresAt) {
        return { status: 'session_expired' }
      }
      if (!digestsEqual(session.csrfDigest, expectedCsrfDigest)) {
        return { status: 'csrf_invalid' }
      }
      const idleExpiresAt = Math.min(
        now + idleTtlMs,
        session.absoluteExpiresAt
      )
      const result = this.database.prepare(`
        UPDATE admin_sessions
        SET last_used_at = ?, idle_expires_at = ?
        WHERE token_digest = ? AND csrf_digest = ? AND revoked_at IS NULL
          AND idle_expires_at > ? AND absolute_expires_at > ?
      `).run(
        now,
        idleExpiresAt,
        tokenDigest,
        expectedCsrfDigest,
        now,
        now
      )
      if (result.changes !== 1) return { status: 'session_invalid' }
      this.insertAudit({
        ...auditEvent,
        subjectId: session.sessionId,
        metadata: {
          ...auditEvent.metadata,
          sessionId: session.sessionId
        }
      })
      return {
        status: 'authenticated',
        session: mapSession(this.database.prepare(
          'SELECT * FROM admin_sessions WHERE token_digest = ?'
        ).get(tokenDigest))
      }
    })
  }

  rotateSessionCsrf({
    sessionId,
    expectedCsrfDigest,
    csrfDigest,
    now,
    idleTtlMs,
    auditEvent
  }) {
    return this.withImmediateTransaction(() => {
      const current = mapSession(this.database.prepare(
        'SELECT * FROM admin_sessions WHERE session_id = ?'
      ).get(sessionId))
      if (!current || current.revokedAt !== null ||
        now >= current.idleExpiresAt || now >= current.absoluteExpiresAt ||
        !digestsEqual(current.csrfDigest, expectedCsrfDigest)) {
        return false
      }
      const idleExpiresAt = Math.min(
        now + idleTtlMs,
        current.absoluteExpiresAt
      )
      const result = this.database.prepare(`
        UPDATE admin_sessions
        SET csrf_digest = ?, last_used_at = ?, idle_expires_at = ?
        WHERE session_id = ? AND csrf_digest = ? AND revoked_at IS NULL
          AND idle_expires_at > ? AND absolute_expires_at > ?
      `).run(
        csrfDigest,
        now,
        idleExpiresAt,
        sessionId,
        expectedCsrfDigest,
        now,
        now
      )
      if (result.changes !== 1) return false
      this.insertAudit({
        ...auditEvent,
        subjectId: current.sessionId,
        metadata: {
          ...auditEvent.metadata,
          sessionId: current.sessionId
        }
      })
      return true
    })
  }

  verifyCsrfAndRevokeSession({
    tokenDigest,
    expectedCsrfDigest,
    now,
    auditEvent
  }) {
    return this.withImmediateTransaction(() => {
      const session = this.findSessionByTokenDigest(tokenDigest)
      if (!session || session.revokedAt !== null) return { status: 'session_invalid' }
      if (now >= session.idleExpiresAt || now >= session.absoluteExpiresAt) {
        return { status: 'session_expired' }
      }
      if (!digestsEqual(session.csrfDigest, expectedCsrfDigest)) {
        return { status: 'csrf_invalid' }
      }
      const result = this.database.prepare(`
        UPDATE admin_sessions
        SET revoked_at = ?
        WHERE token_digest = ? AND csrf_digest = ? AND revoked_at IS NULL
          AND idle_expires_at > ? AND absolute_expires_at > ?
      `).run(
        now,
        tokenDigest,
        expectedCsrfDigest,
        now,
        now
      )
      if (result.changes !== 1) return { status: 'session_invalid' }
      this.insertAudit({
        ...auditEvent,
        subjectId: session.sessionId,
        metadata: {
          ...auditEvent.metadata,
          sessionId: session.sessionId
        }
      })
      return { status: 'revoked' }
    })
  }

  revokeSession(sessionId, revokedAt, auditEvent = null) {
    return this.withImmediateTransaction(() => {
      const result = this.database.prepare(`
        UPDATE admin_sessions
        SET revoked_at = ?
        WHERE session_id = ? AND revoked_at IS NULL
      `).run(revokedAt, sessionId)
      if (result.changes > 0 && auditEvent) this.insertAudit(auditEvent)
      return result.changes > 0
    })
  }

  getRateLimit(scope, keyDigest) {
    return mapRateLimit(this.database.prepare(`
      SELECT scope, key_digest, window_started_at, failure_count,
             in_flight_count, blocked_until
      FROM auth_rate_limits
      WHERE scope = ? AND key_digest = ?
    `).get(scope, keyDigest))
  }

  reserveAttempt({ scope, keyDigest, now, windowMs, maxAttempts }) {
    return this.withImmediateTransaction(() => {
      let rateLimit = this.getRateLimit(scope, keyDigest)
      if (!rateLimit || now >= rateLimit.windowStartedAt + windowMs) {
        this.database.prepare(`
          INSERT INTO auth_rate_limits (
            scope, key_digest, window_started_at, failure_count,
            in_flight_count, blocked_until
          ) VALUES (?, ?, ?, 0, 0, NULL)
          ON CONFLICT(scope, key_digest) DO UPDATE SET
            window_started_at = excluded.window_started_at,
            failure_count = 0,
            in_flight_count = 0,
            blocked_until = NULL
        `).run(scope, keyDigest, now)
        rateLimit = {
          scope,
          keyDigest,
          windowStartedAt: now,
          failureCount: 0,
          inFlightCount: 0,
          blockedUntil: null
        }
      }

      const blocked = rateLimit.blockedUntil !== null &&
        now < rateLimit.blockedUntil
      if (blocked || rateLimit.failureCount + rateLimit.inFlightCount >= maxAttempts) {
        return {
          allowed: false,
          scope,
          keyDigest,
          windowStartedAt: rateLimit.windowStartedAt
        }
      }
      this.database.prepare(`
        UPDATE auth_rate_limits
        SET in_flight_count = in_flight_count + 1
        WHERE scope = ? AND key_digest = ? AND window_started_at = ?
      `).run(scope, keyDigest, rateLimit.windowStartedAt)
      return {
        allowed: true,
        scope,
        keyDigest,
        windowStartedAt: rateLimit.windowStartedAt
      }
    })
  }

  settleRateLimitFailure({
    reservation,
    scope,
    keyDigest,
    windowMs,
    maxFailures,
    auditEvent
  }) {
    return this.withImmediateTransaction(() => {
      const effectiveScope = reservation ? reservation.scope : scope
      const effectiveKeyDigest = reservation ? reservation.keyDigest : keyDigest
      const windowStartedAt = reservation.windowStartedAt
      const existing = this.getRateLimit(effectiveScope, effectiveKeyDigest)
      if (!existing || existing.windowStartedAt !== windowStartedAt ||
        existing.inFlightCount < 1) {
        return null
      }
      const failureCount = existing.failureCount + 1
      const blockedUntil = failureCount >= maxFailures
        ? windowStartedAt + windowMs
        : null
      this.database.prepare(`
        UPDATE auth_rate_limits
        SET failure_count = ?,
            in_flight_count = in_flight_count - 1,
            blocked_until = ?
        WHERE scope = ? AND key_digest = ? AND window_started_at = ?
          AND in_flight_count > 0
      `).run(
        failureCount,
        blockedUntil,
        effectiveScope,
        effectiveKeyDigest,
        windowStartedAt
      )
      this.insertAudit({
        ...auditEvent,
        metadata: {
          ...auditEvent.metadata,
          count: failureCount
        }
      })
      return {
        scope: effectiveScope,
        keyDigest: effectiveKeyDigest,
        windowStartedAt,
        failureCount,
        inFlightCount: existing.inFlightCount - 1,
        blockedUntil
      }
    })
  }

  settleRateLimitSuccess({ reservation, auditEvent }) {
    return this.withImmediateTransaction(() => {
      const result = this.database.prepare(`
        UPDATE auth_rate_limits
        SET failure_count = 0,
            in_flight_count = in_flight_count - 1,
            blocked_until = NULL
        WHERE scope = ? AND key_digest = ? AND window_started_at = ?
          AND in_flight_count > 0
      `).run(
        reservation.scope,
        reservation.keyDigest,
        reservation.windowStartedAt
      )
      if (result.changes === 1) this.insertAudit(auditEvent)
      return result.changes === 1
    })
  }

  clearRateLimit(scope, keyDigest, auditEvent = null) {
    return this.withImmediateTransaction(() => {
      const result = this.database.prepare(`
        UPDATE auth_rate_limits
        SET failure_count = 0, blocked_until = NULL
        WHERE scope = ? AND key_digest = ?
      `).run(scope, keyDigest)
      if (auditEvent) this.insertAudit(auditEvent)
      return result.changes > 0
    })
  }
}

module.exports = {
  AdminAuthRepository
}

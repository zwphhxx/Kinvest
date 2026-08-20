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
    blockedUntil: row.blocked_until
  }
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

  completeLogin({ scope, keyDigest, session, auditEvent }) {
    return this.withImmediateTransaction(() => {
      this.database.prepare(
        'DELETE FROM auth_rate_limits WHERE scope = ? AND key_digest = ?'
      ).run(scope, keyDigest)
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
      SELECT scope, key_digest, window_started_at, failure_count, blocked_until
      FROM auth_rate_limits
      WHERE scope = ? AND key_digest = ?
    `).get(scope, keyDigest))
  }

  recordRateLimitFailure({
    scope,
    keyDigest,
    now,
    windowMs,
    maxFailures,
    auditEvent
  }) {
    return this.withImmediateTransaction(() => {
      const existing = this.getRateLimit(scope, keyDigest)
      const inWindow = existing && now < existing.windowStartedAt + windowMs
      const windowStartedAt = inWindow ? existing.windowStartedAt : now
      const failureCount = (inWindow ? existing.failureCount : 0) + 1
      const blockedUntil = failureCount >= maxFailures
        ? windowStartedAt + windowMs
        : null
      this.database.prepare(`
        INSERT INTO auth_rate_limits (
          scope, key_digest, window_started_at, failure_count, blocked_until
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(scope, key_digest) DO UPDATE SET
          window_started_at = excluded.window_started_at,
          failure_count = excluded.failure_count,
          blocked_until = excluded.blocked_until
      `).run(scope, keyDigest, windowStartedAt, failureCount, blockedUntil)
      this.insertAudit({
        ...auditEvent,
        metadata: {
          ...auditEvent.metadata,
          count: failureCount
        }
      })
      return { scope, keyDigest, windowStartedAt, failureCount, blockedUntil }
    })
  }

  clearRateLimit(scope, keyDigest, auditEvent = null) {
    return this.withImmediateTransaction(() => {
      const result = this.database.prepare(
        'DELETE FROM auth_rate_limits WHERE scope = ? AND key_digest = ?'
      ).run(scope, keyDigest)
      if (auditEvent) this.insertAudit(auditEvent)
      return result.changes > 0
    })
  }
}

module.exports = {
  AdminAuthRepository
}

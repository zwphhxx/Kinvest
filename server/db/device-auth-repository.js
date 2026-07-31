const AUDIT_METADATA_KEYS = new Set([
  'requestId',
  'credentialId',
  'replacementCredentialId',
  'deviceId',
  'hmacVersionId',
  'reason',
  'count',
  'devicesRevoked',
  'devicesMatched',
  'credentialsRevoked'
])

function mapRequest(row) {
  if (!row) return null
  return {
    requestId: row.request_id,
    requestCodeDigest: row.request_code_digest,
    browserCredentialDigest: row.browser_credential_digest,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    failedAttempts: row.failed_attempts,
    approvedAt: row.approved_at,
    consumedAt: row.consumed_at,
    lockedAt: row.locked_at
  }
}

function mapCredential(row) {
  if (!row) return null
  return {
    credentialId: row.credential_id,
    deviceId: row.device_id,
    tokenDigest: row.token_digest,
    hmacVersionId: row.hmac_version_id,
    approvedAt: row.approved_at,
    rotatedAt: row.rotated_at,
    lastUsedAt: row.last_used_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    revokedAt: row.revoked_at,
    replacementCredentialId: row.replacement_credential_id,
    replacementGraceExpiresAt: row.replacement_grace_expires_at
  }
}

function sanitizeAuditMetadata(metadata = {}) {
  const sanitized = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (!AUDIT_METADATA_KEYS.has(key)) continue
    if (!['string', 'number', 'boolean'].includes(typeof value)) continue
    sanitized[key] = value
  }
  return sanitized
}

class DeviceAuthRepository {
  constructor(database) {
    this.database = database
  }

  initialize() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS device_auth_requests (
        request_id TEXT PRIMARY KEY,
        request_code_digest TEXT NOT NULL,
        browser_credential_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        approved_at INTEGER,
        consumed_at INTEGER,
        locked_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS device_credentials (
        credential_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        token_digest TEXT NOT NULL UNIQUE,
        hmac_version_id TEXT NOT NULL,
        approved_at INTEGER NOT NULL,
        rotated_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        idle_expires_at INTEGER NOT NULL,
        absolute_expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        replacement_credential_id TEXT,
        replacement_grace_expires_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_device_credentials_hmac_version
        ON device_credentials (hmac_version_id);

      CREATE INDEX IF NOT EXISTS idx_device_credentials_device
        ON device_credentials (device_id);

      CREATE TABLE IF NOT EXISTS device_auth_audit (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        subject_id TEXT,
        metadata_json TEXT NOT NULL
      );
    `)
  }

  insertRequest(request) {
    this.database.prepare(`
      INSERT INTO device_auth_requests (
        request_id,
        request_code_digest,
        browser_credential_digest,
        created_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      request.requestId,
      request.requestCodeDigest,
      request.browserCredentialDigest,
      request.createdAt,
      request.expiresAt
    )
  }

  getRequest(requestId) {
    return mapRequest(this.database.prepare(
      'SELECT * FROM device_auth_requests WHERE request_id = ?'
    ).get(requestId))
  }

  recordFailedAttempt(requestId, now, maximumAttempts) {
    this.database.prepare(`
      UPDATE device_auth_requests
      SET
        failed_attempts = failed_attempts + 1,
        locked_at = CASE
          WHEN failed_attempts + 1 >= ? THEN ?
          ELSE locked_at
        END
      WHERE request_id = ? AND consumed_at IS NULL AND locked_at IS NULL
        AND approved_at IS NULL
    `).run(maximumAttempts, now, requestId)
    return this.getRequest(requestId)
  }

  approveRequest(requestId, approvedAt) {
    const result = this.database.prepare(`
      UPDATE device_auth_requests
      SET approved_at = COALESCE(approved_at, ?)
      WHERE request_id = ? AND consumed_at IS NULL AND locked_at IS NULL
    `).run(approvedAt, requestId)
    return Number(result.changes) === 1
  }

  consumeRequestAndInsertCredential(requestId, consumedAt, credential) {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const consumed = this.database.prepare(`
        UPDATE device_auth_requests
        SET consumed_at = ?
        WHERE request_id = ?
          AND approved_at IS NOT NULL
          AND consumed_at IS NULL
          AND locked_at IS NULL
      `).run(consumedAt, requestId)
      if (Number(consumed.changes) !== 1) {
        this.database.exec('ROLLBACK')
        return false
      }
      this.insertCredential(credential)
      this.database.exec('COMMIT')
      return true
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  insertCredential(credential) {
    this.database.prepare(`
      INSERT INTO device_credentials (
        credential_id,
        device_id,
        token_digest,
        hmac_version_id,
        approved_at,
        rotated_at,
        last_used_at,
        idle_expires_at,
        absolute_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      credential.credentialId,
      credential.deviceId,
      credential.tokenDigest,
      credential.hmacVersionId,
      credential.approvedAt,
      credential.rotatedAt,
      credential.lastUsedAt,
      credential.idleExpiresAt,
      credential.absoluteExpiresAt
    )
  }

  getCredential(credentialId) {
    return mapCredential(this.database.prepare(
      'SELECT * FROM device_credentials WHERE credential_id = ?'
    ).get(credentialId))
  }

  listCredentialCandidates(now) {
    return this.database.prepare(`
      SELECT *
      FROM device_credentials
      WHERE revoked_at IS NULL
        AND absolute_expires_at > ?
        AND (
          (
            replacement_credential_id IS NULL
            AND idle_expires_at > ?
          )
          OR (
            replacement_credential_id IS NOT NULL
            AND replacement_grace_expires_at > ?
          )
        )
      ORDER BY credential_id
    `).all(now, now, now).map(mapCredential)
  }

  updateCredentialUse(credentialId, lastUsedAt, idleExpiresAt) {
    this.database.prepare(`
      UPDATE device_credentials
      SET last_used_at = ?, idle_expires_at = ?
      WHERE credential_id = ? AND revoked_at IS NULL
    `).run(lastUsedAt, idleExpiresAt, credentialId)
  }

  rotateCredential(oldCredentialId, replacement, graceExpiresAt) {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const changed = this.database.prepare(`
        UPDATE device_credentials
        SET replacement_credential_id = ?, replacement_grace_expires_at = ?
        WHERE credential_id = ?
          AND revoked_at IS NULL
          AND replacement_credential_id IS NULL
      `).run(replacement.credentialId, graceExpiresAt, oldCredentialId)
      if (Number(changed.changes) !== 1) {
        this.database.exec('ROLLBACK')
        return false
      }
      this.insertCredential(replacement)
      this.database.exec('COMMIT')
      return true
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  revokeCredential(credentialId, revokedAt) {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const credential = this.database.prepare(`
        SELECT device_id
        FROM device_credentials
        WHERE credential_id = ?
      `).get(credentialId)
      if (!credential) {
        this.database.exec('ROLLBACK')
        return { deviceId: null, credentialsRevoked: 0 }
      }
      const result = this.database.prepare(`
        UPDATE device_credentials
        SET revoked_at = ?
        WHERE device_id = ? AND revoked_at IS NULL
      `).run(revokedAt, credential.device_id)
      this.database.exec('COMMIT')
      return {
        deviceId: credential.device_id,
        credentialsRevoked: Number(result.changes)
      }
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  revokeAllCredentials(revokedAt) {
    const result = this.database.prepare(`
      UPDATE device_credentials
      SET revoked_at = ?
      WHERE revoked_at IS NULL
    `).run(revokedAt)
    return Number(result.changes)
  }

  revokeByHmacVersion(hmacVersionId, revokedAt) {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const matched = this.database.prepare(`
        SELECT COUNT(DISTINCT device_id) AS devices_matched
        FROM device_credentials
        WHERE hmac_version_id = ?
      `).get(hmacVersionId)
      const result = this.database.prepare(`
        UPDATE device_credentials
        SET revoked_at = ?
        WHERE revoked_at IS NULL
          AND device_id IN (
            SELECT device_id
            FROM device_credentials
            WHERE hmac_version_id = ?
          )
      `).run(revokedAt, hmacVersionId)
      this.database.exec('COMMIT')
      return {
        devicesMatched: Number(matched.devices_matched),
        credentialsRevoked: Number(result.changes)
      }
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  getReferencedHmacVersionIds(now) {
    return this.database.prepare(`
      SELECT DISTINCT hmac_version_id
      FROM device_credentials
      WHERE revoked_at IS NULL
        AND absolute_expires_at > ?
        AND (
          (
            replacement_credential_id IS NULL
            AND idle_expires_at > ?
          )
          OR (
            replacement_credential_id IS NOT NULL
            AND replacement_grace_expires_at > ?
          )
        )
      ORDER BY hmac_version_id
    `).all(now, now, now).map((row) => row.hmac_version_id)
  }

  addAuditEvent(eventType, occurredAt, subjectId = null, metadata = {}) {
    this.database.prepare(`
      INSERT INTO device_auth_audit (
        event_type,
        occurred_at,
        subject_id,
        metadata_json
      ) VALUES (?, ?, ?, ?)
    `).run(
      eventType,
      occurredAt,
      subjectId,
      JSON.stringify(sanitizeAuditMetadata(metadata))
    )
  }

  listAuditEvents() {
    return this.database.prepare(`
      SELECT event_type, occurred_at, subject_id, metadata_json
      FROM device_auth_audit
      ORDER BY event_id
    `).all().map((row) => ({
      eventType: row.event_type,
      occurredAt: row.occurred_at,
      subjectId: row.subject_id,
      metadata: JSON.parse(row.metadata_json)
    }))
  }
}

module.exports = {
  DeviceAuthRepository
}

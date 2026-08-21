const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { DeviceAuthRepository } = require('../db/device-auth-repository')
const {
  run: revokeAllDevices,
  selectExecutableEffectiveUid
} = require('../cli/revoke-all-devices')

const KINVEST_APPLICATION_ID = 1263095382

function expectCode(callback, expectedCode) {
  assert.throws(callback, (/** @type {any} */ error) => {
    assert.equal(error && error.code, expectedCode)
    assert.strictEqual(String(error.message).includes('.sqlite'), false)
    return true
  })
}

function insertCredential(repository, id, now) {
  repository.insertCredential({
    credentialId: `credential-${id}`,
    deviceId: `device-${id}`,
    deviceName: `Device ${id}`,
    tokenDigest: Buffer.alloc(32, id).toString('base64url'),
    hmacVersionId: 'v20260821-002',
    approvedAt: now,
    rotatedAt: now,
    lastUsedAt: now,
    idleExpiresAt: now + 1000,
    absoluteExpiresAt: now + 2000
  })
}

function testNonRootFailsBeforeDatabaseOpen() {
  expectCode(() => revokeAllDevices({
    databasePath: '/definitely/not/opened/kinvest.sqlite',
    now: () => 100,
    effectiveUid: () => 501,
    stdout: { write() { throw new Error('stdout must not be used') } }
  }), 'DEVICE_REVOKE_ROOT_REQUIRED')
}

function testMissingOrNonfunctionEffectiveUidFailsBeforeDatabaseOpen() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-no-root-'))
  const cases = [undefined, null, 'root', 0]
  for (const effectiveUid of cases) {
    const databasePath = path.join(directory, `case-${String(effectiveUid)}.sqlite`)
    expectCode(() => revokeAllDevices({
      databasePath,
      now: () => 100,
      effectiveUid,
      stdout: { write() {} }
    }), 'DEVICE_REVOKE_ROOT_REQUIRED')
    assert.strictEqual(fs.existsSync(databasePath), false)
  }

  fs.rmSync(directory, { recursive: true, force: true })
}

function testExecutableEffectiveUidPrefersEffectiveIdentity() {
  let realUidCalls = 0
  const selected = selectExecutableEffectiveUid({
    geteuid: () => 501,
    getuid: () => {
      realUidCalls += 1
      return 0
    }
  })
  assert.strictEqual(selected(), 501)
  assert.strictEqual(realUidCalls, 0)
  assert.strictEqual(selectExecutableEffectiveUid({
    getuid: () => 0
  })(), 0)
  assert.strictEqual(selectExecutableEffectiveUid({}), undefined)
}

function testInvalidDatabaseTargetsFailClosed() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-db-target-'))
  const realDatabasePath = path.join(directory, 'real.sqlite')
  const database = new DatabaseSync(realDatabasePath)
  const repository = new DeviceAuthRepository(database)
  repository.initialize()
  insertCredential(repository, 9, 100)
  database.close()
  fs.chmodSync(realDatabasePath, 0o600)

  const missingPath = path.join(directory, 'missing.sqlite')
  const relativePath = path.relative(process.cwd(), missingPath)
  const symlinkPath = path.join(directory, 'linked.sqlite')
  fs.symlinkSync(realDatabasePath, symlinkPath)
  const directoryPath = path.join(directory, 'not-a-file')
  fs.mkdirSync(directoryPath)

  const expectInvalid = (databasePath) => expectCode(() => revokeAllDevices({
    databasePath,
    now: () => 200,
    effectiveUid: () => 0,
    stdout: { write() {} }
  }), 'DEVICE_REVOKE_DATABASE_INVALID')

  expectInvalid(missingPath)
  assert.strictEqual(fs.existsSync(missingPath), false)
  expectInvalid(relativePath)
  assert.strictEqual(fs.existsSync(missingPath), false)
  expectInvalid(symlinkPath)
  expectInvalid(directoryPath)
  fs.chmodSync(realDatabasePath, 0o644)
  expectInvalid(realDatabasePath)

  const verify = new DatabaseSync(realDatabasePath)
  assert.strictEqual(Number(verify.prepare(`
    SELECT COUNT(*) AS count
    FROM device_credentials
    WHERE revoked_at IS NOT NULL
  `).get().count), 0)
  verify.close()
  fs.rmSync(directory, { recursive: true, force: true })
}

function assertDatabaseHasNoDeviceSchema(databasePath, expectedApplicationId = 0) {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  assert.strictEqual(
    Number(database.prepare('PRAGMA application_id').get().application_id),
    expectedApplicationId
  )
  assert.strictEqual(
    database.prepare('PRAGMA table_info(device_auth_requests)').all().length,
    0
  )
  assert.strictEqual(
    database.prepare('PRAGMA table_info(device_credentials)').all().length,
    0
  )
  assert.strictEqual(
    database.prepare('PRAGMA table_info(device_auth_audit)').all().length,
    0
  )
  database.close()
}

function testEmptyAndUnrelatedDatabasesAreRejectedWithoutMutation() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-db-identity-'))
  try {
    const emptyPath = path.join(directory, 'empty.sqlite')
    new DatabaseSync(emptyPath).close()
    fs.chmodSync(emptyPath, 0o600)
    expectCode(() => revokeAllDevices({
      databasePath: emptyPath,
      now: () => 300,
      effectiveUid: () => 0,
      stdout: { write() { return true } }
    }), 'DEVICE_REVOKE_DATABASE_INVALID')
    assertDatabaseHasNoDeviceSchema(emptyPath)

    const unrelatedPath = path.join(directory, 'unrelated.sqlite')
    const unrelated = new DatabaseSync(unrelatedPath)
    unrelated.exec('CREATE TABLE unrelated_data (id INTEGER PRIMARY KEY)')
    unrelated.prepare('INSERT INTO unrelated_data (id) VALUES (?)').run(7)
    unrelated.close()
    fs.chmodSync(unrelatedPath, 0o600)
    expectCode(() => revokeAllDevices({
      databasePath: unrelatedPath,
      now: () => 300,
      effectiveUid: () => 0,
      stdout: { write() { return true } }
    }), 'DEVICE_REVOKE_DATABASE_INVALID')
    assertDatabaseHasNoDeviceSchema(unrelatedPath)
    const verifyUnrelated = new DatabaseSync(unrelatedPath, { readOnly: true })
    assert.strictEqual(Number(verifyUnrelated.prepare(
      'SELECT COUNT(*) AS count FROM unrelated_data'
    ).get().count), 1)
    verifyUnrelated.close()
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function testStrictLegacyDatabaseIsUpgradedAndRevoked() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-legacy-'))
  const databasePath = path.join(directory, 'legacy.sqlite')
  const legacy = new DatabaseSync(databasePath)
  legacy.exec(`
    CREATE TABLE device_auth_requests (
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
    CREATE TABLE device_credentials (
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
    CREATE TABLE device_auth_audit (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      subject_id TEXT,
      metadata_json TEXT NOT NULL
    );
  `)
  legacy.prepare(`
    INSERT INTO device_credentials (
      credential_id, device_id, token_digest, hmac_version_id,
      approved_at, rotated_at, last_used_at, idle_expires_at,
      absolute_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('legacy-credential', 'legacy-device', 'legacy-token',
    'v20260821-002', 1, 1, 1, 1000, 2000)
  legacy.close()
  fs.chmodSync(databasePath, 0o600)

  const output = []
  assert.strictEqual(revokeAllDevices({
    databasePath,
    now: () => 400,
    effectiveUid: () => 0,
    stdout: { write(value) { output.push(String(value)); return true } }
  }), 1)
  assert.strictEqual(output.join(''),
    'KINVEST_DEVICE_REVOKE_ALL_OK credentials=1\n')
  const verify = new DatabaseSync(databasePath, { readOnly: true })
  assert.strictEqual(
    Number(verify.prepare('PRAGMA application_id').get().application_id),
    KINVEST_APPLICATION_ID
  )
  assert.strictEqual(Number(verify.prepare(`
    SELECT COUNT(*) AS count
    FROM device_credentials
    WHERE revoked_at = 400
  `).get().count), 1)
  verify.close()
  fs.rmSync(directory, { recursive: true, force: true })
}

function testRootRevokesAllWithAuditAndSafeRepeat() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-revoke-'))
  const databasePath = path.join(directory, 'device-auth.sqlite')
  const now = 123456
  const setupDatabase = new DatabaseSync(databasePath)
  const setupRepository = new DeviceAuthRepository(setupDatabase)
  setupRepository.initialize()
  assert.strictEqual(
    Number(setupDatabase.prepare('PRAGMA application_id').get().application_id),
    KINVEST_APPLICATION_ID
  )
  insertCredential(setupRepository, 1, now)
  insertCredential(setupRepository, 2, now)
  setupDatabase.close()
  fs.chmodSync(databasePath, 0o600)

  const output = []
  assert.strictEqual(revokeAllDevices({
    databasePath,
    now: () => now,
    effectiveUid: () => 0,
    stdout: { write: (value) => output.push(String(value)) }
  }), 2)
  assert.strictEqual(output.join(''),
    'KINVEST_DEVICE_REVOKE_ALL_OK credentials=2\n')
  assert.strictEqual(output.join('').includes(databasePath), false)
  assert.strictEqual(output.join('').includes('digest'), false)

  const verifyDatabase = new DatabaseSync(databasePath)
  assert.strictEqual(Number(verifyDatabase.prepare(`
    SELECT COUNT(*) AS count FROM device_credentials WHERE revoked_at = ?
  `).get(now).count), 2)
  assert.deepStrictEqual(
    new DeviceAuthRepository(verifyDatabase).listAuditEvents()
      .filter((event) => event.eventType === 'device_credentials_revoked_all')
      .map((event) => event.metadata),
    [{ count: 2 }]
  )
  verifyDatabase.close()

  const repeatOutput = []
  assert.strictEqual(revokeAllDevices({
    databasePath,
    now: () => now + 1,
    effectiveUid: () => 0,
    stdout: { write: (value) => repeatOutput.push(String(value)) }
  }), 0)
  assert.strictEqual(repeatOutput.join(''),
    'KINVEST_DEVICE_REVOKE_ALL_OK credentials=0\n')

  const repeatDatabase = new DatabaseSync(databasePath)
  assert.deepStrictEqual(
    new DeviceAuthRepository(repeatDatabase).listAuditEvents()
      .filter((event) => event.eventType === 'device_credentials_revoked_all')
      .map((event) => event.metadata),
    [{ count: 2 }, { count: 0 }]
  )
  repeatDatabase.close()
  fs.rmSync(directory, { recursive: true, force: true })
}

async function run() {
  testNonRootFailsBeforeDatabaseOpen()
  testMissingOrNonfunctionEffectiveUidFailsBeforeDatabaseOpen()
  testExecutableEffectiveUidPrefersEffectiveIdentity()
  testInvalidDatabaseTargetsFailClosed()
  testEmptyAndUnrelatedDatabasesAreRejectedWithoutMutation()
  testStrictLegacyDatabaseIsUpgradedAndRevoked()
  testRootRevokesAllWithAuditAndSafeRepeat()
}

module.exports = { run }

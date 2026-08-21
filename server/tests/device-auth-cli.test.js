const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { DeviceAuthRepository } = require('../db/device-auth-repository')
const { run: revokeAllDevices } = require('../cli/revoke-all-devices')

function expectCode(callback, expectedCode) {
  assert.throws(callback, (error) => {
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
    getuid: () => 501,
    stdout: { write() { throw new Error('stdout must not be used') } }
  }), 'DEVICE_REVOKE_ROOT_REQUIRED')
}

function testRootRevokesAllWithAuditAndSafeRepeat() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-revoke-'))
  const databasePath = path.join(directory, 'device-auth.sqlite')
  const now = 123456
  const setupDatabase = new DatabaseSync(databasePath)
  const setupRepository = new DeviceAuthRepository(setupDatabase)
  setupRepository.initialize()
  insertCredential(setupRepository, 1, now)
  insertCredential(setupRepository, 2, now)
  setupDatabase.close()

  const output = []
  assert.strictEqual(revokeAllDevices({
    databasePath,
    now: () => now,
    getuid: () => 0,
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
    getuid: () => 0,
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
  testRootRevokesAllWithAuditAndSafeRepeat()
}

module.exports = { run }

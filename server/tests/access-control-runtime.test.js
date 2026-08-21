const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const {
  closeDb,
  getDbPath,
  openDb,
  setDbPath
} = require('../db/refresh-db')
const {
  ADMIN_SECRET_NAME,
  DEVICE_HMAC_SECRET_NAME,
  generateAdminPasswordVerifier,
  generateDeviceHmacSecret
} = require('../security/secret-bootstrap-contract')
const {
  createAccessControlRuntime
} = require('../security/access-control-runtime')

const ADMIN_VERSION = 'v20260821-001'
const HMAC_VERSION = 'v20260821-002'
const VERSION_CONFIG = JSON.stringify({
  adminPasswordVerifier: ADMIN_VERSION,
  deviceTokenHmac: {
    accepted: [HMAC_VERSION],
    active: HMAC_VERSION
  }
})
const ADMIN_PASSWORD = 'runtime-fixture-password'

function expectCode(callback, expectedCode) {
  assert.throws(callback, (/** @type {any} */ error) => {
    assert.equal(error && error.code, expectedCode)
    return true
  })
}

function createMaterials() {
  return {
    admin: generateAdminPasswordVerifier(
      ADMIN_PASSWORD,
      (size) => Buffer.alloc(size, 11)
    ),
    hmac: generateDeviceHmacSecret((size) => Buffer.alloc(size, 12))
  }
}

function createSecretRuntime(options = {}) {
  const materials = options.materials || createMaterials()
  const reads = []
  const returned = []
  const runtime = {
    status: Object.freeze({
      mode: options.mode || 'github-tmpfs-v1',
      referenceCount: 2
    }),
    readSecret(reference) {
      reads.push({ ...reference })
      if (options.throwOnRead) throw new Error('sensitive read failure')
      const text = reference.secretName === ADMIN_SECRET_NAME
        ? materials.admin
        : materials.hmac
      const value = Buffer.from(text, 'utf8')
      returned.push(value)
      return value
    },
    clear() {
      throw new Error('access runtime must not clear secret runtime')
    }
  }
  return { reads, returned, runtime }
}

function enabledEnv(versionConfig = VERSION_CONFIG) {
  return {
    KINVEST_ACCESS_CONTROL_MODE: 'device-approval',
    KINVEST_SECRET_VERSION_IDS: versionConfig
  }
}

function testDisabledAvoidsSecretsAndDatabase() {
  let openCalls = 0
  let closeCalls = 0
  const forbiddenDatabase = new Proxy({}, {
    get() { throw new Error('database was accessed') }
  })
  const runtime = createAccessControlRuntime({
    env: {},
    database: forbiddenDatabase,
    openDatabase() { openCalls += 1 },
    closeDatabase() { closeCalls += 1 },
    secretRuntime: {
      get status() { throw new Error('secret status was read') },
      readSecret() { throw new Error('secret was read') }
    }
  })
  assert.deepStrictEqual(runtime.status, { mode: 'disabled' })
  assert.equal(runtime.adminAuth, null)
  assert.equal(runtime.deviceApproval, null)
  assert.doesNotThrow(() => runtime.clear())
  assert.doesNotThrow(() => runtime.clear())
  assert.equal(openCalls, 0)
  assert.equal(closeCalls, 0)
}

function testEnabledComposesWorkingServicesAndClearsMaterial() {
  const secret = createSecretRuntime()
  const database = new DatabaseSync(':memory:')
  let borrowedCloseCalls = 0
  const runtime = createAccessControlRuntime({
    env: enabledEnv(),
    database,
    closeDatabase() { borrowedCloseCalls += 1 },
    secretRuntime: secret.runtime,
    now: () => Date.UTC(2026, 7, 21),
    randomBytes: (size) => Buffer.alloc(size, 13)
  })

  assert.deepStrictEqual(runtime.status, { mode: 'device-approval' })
  assert.deepStrictEqual(secret.reads, [
    { secretName: ADMIN_SECRET_NAME, versionId: ADMIN_VERSION },
    { secretName: DEVICE_HMAC_SECRET_NAME, versionId: HMAC_VERSION }
  ])
  assert.strictEqual(secret.returned.every((value) =>
    value.every((byte) => byte === 0)), true)
  const expectedRateLimitKey = crypto.createHmac(
    'sha256',
    Buffer.from(createMaterials().hmac, 'base64url')
  ).update('kinvest-admin-rate-limit-key-v1').digest()
  assert.strictEqual(runtime.adminAuth.rateLimitKey.equals(expectedRateLimitKey), true)
  expectedRateLimitKey.fill(0)
  assert.strictEqual(runtime.adminAuth.rateLimitIdentityDigest('198.51.100.1').length, 43)

  const request = runtime.deviceApproval.createRequest({
    deviceName: 'Runtime Device',
    rateLimitIdentity: '198.51.100.1'
  })
  runtime.deviceApproval.approveRequest({
    requestId: request.requestId,
    requestCode: request.requestCode,
    adminAuthenticated: true
  })
  const credential = runtime.deviceApproval.redeemRequest({
    requestId: request.requestId,
    browserCredential: request.browserCredential
  })
  assert.strictEqual(credential.token.length, 43)
  const storedDigest = database.prepare(`
    SELECT token_digest
    FROM device_credentials
    WHERE credential_id = ?
  `).get(credential.credentialId).token_digest
  const serializedHmac = createMaterials().hmac
  const decodedDigest = crypto.createHmac(
    'sha256',
    Buffer.from(serializedHmac, 'base64url')
  ).update(credential.token).digest('base64url')
  const serializedDigest = crypto.createHmac(
    'sha256',
    Buffer.from(serializedHmac, 'utf8')
  ).update(credential.token).digest('base64url')
  assert.strictEqual(storedDigest, decodedDigest)
  assert.notStrictEqual(storedDigest, serializedDigest)

  const readsBeforeRejectedReference = secret.reads.length
  expectCode(() => runtime.deviceApproval.secretProvider.readSecret({
    secretName: ADMIN_SECRET_NAME,
    versionId: HMAC_VERSION
  }), 'SECRET_NOT_FOUND')
  assert.strictEqual(secret.reads.length, readsBeforeRejectedReference)
  assert.strictEqual(secret.returned.every((value) =>
    value.every((byte) => byte === 0)), true)

  const retained = [
    runtime.adminAuth.verifierDigest,
    runtime.adminAuth.verifierSalt,
    runtime.adminAuth.rateLimitKey
  ]
  runtime.clear()
  runtime.clear()
  assert.strictEqual(borrowedCloseCalls, 0)
  assert.strictEqual(retained.every((value) =>
    value.every((byte) => byte === 0)), true)
}

function testOwnedDatabaseClosesOnceAndFailureCloses() {
  const ownedDatabase = new DatabaseSync(':memory:')
  let ownedOpenCalls = 0
  let ownedCloseCalls = 0
  const ownedRuntime = createAccessControlRuntime({
    env: enabledEnv(),
    secretRuntime: createSecretRuntime().runtime,
    openDatabase() {
      ownedOpenCalls += 1
      return ownedDatabase
    },
    closeDatabase(database) {
      assert.strictEqual(database, ownedDatabase)
      ownedCloseCalls += 1
      database.close()
    }
  })
  assert.strictEqual(ownedOpenCalls, 1)
  ownedRuntime.clear()
  ownedRuntime.clear()
  assert.strictEqual(ownedCloseCalls, 1)

  const rawFailingDatabase = new DatabaseSync(':memory:')
  const failingDatabase = new Proxy(rawFailingDatabase, {
    get(target, property) {
      if (property === 'exec') {
        return (sql) => {
          if (String(sql).includes('CREATE TABLE IF NOT EXISTS device_auth_requests')) {
            throw new Error('SENSITIVE_INITIALIZE_FAILURE')
          }
          return target.exec(sql)
        }
      }
      const value = target[property]
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  let failureCloseCalls = 0
  expectCode(() => createAccessControlRuntime({
    env: enabledEnv(),
    secretRuntime: createSecretRuntime().runtime,
    openDatabase: () => failingDatabase,
    closeDatabase(database) {
      assert.strictEqual(database, failingDatabase)
      failureCloseCalls += 1
      database.close()
    }
  }), 'ACCESS_CONTROL_CONFIG_INVALID')
  assert.strictEqual(failureCloseCalls, 1)
}

function testRefreshDatabaseCanCloseAndReopen() {
  const previousPath = getDbPath()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-refresh-db-'))
  const databasePath = path.join(directory, 'refresh.sqlite')
  try {
    closeDb()
    setDbPath(databasePath)
    const first = openDb()
    closeDb()
    closeDb()
    const second = openDb()
    assert.notStrictEqual(second, first)
    assert.doesNotThrow(() => second.prepare(
      'SELECT COUNT(*) AS count FROM refresh_counters'
    ).get())
    closeDb()
  } finally {
    setDbPath(previousPath)
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function testConfigurationFailuresAreStableAndFailClosed() {
  const cases = [
    { env: { KINVEST_ACCESS_CONTROL_MODE: 'unexpected' }, secret: createSecretRuntime() },
    { env: enabledEnv(), secret: createSecretRuntime({ mode: 'disabled' }) },
    { env: enabledEnv('{}'), secret: createSecretRuntime() },
    {
      env: enabledEnv(JSON.stringify({
        adminPasswordVerifier: ADMIN_VERSION,
        deviceTokenHmac: {
          accepted: [HMAC_VERSION, 'v20260821-003'],
          active: HMAC_VERSION
        }
      })),
      secret: createSecretRuntime()
    },
    { env: enabledEnv(), secret: createSecretRuntime({ throwOnRead: true }) },
    {
      env: enabledEnv(),
      secret: createSecretRuntime({ materials: { admin: 'invalid', hmac: 'invalid' } })
    }
  ]

  for (const fixture of cases) {
    expectCode(() => createAccessControlRuntime({
      env: fixture.env,
      database: new DatabaseSync(':memory:'),
      secretRuntime: fixture.secret.runtime
    }), 'ACCESS_CONTROL_CONFIG_INVALID')
  }
}

async function run() {
  testDisabledAvoidsSecretsAndDatabase()
  testEnabledComposesWorkingServicesAndClearsMaterial()
  testOwnedDatabaseClosesOnceAndFailureCloses()
  testRefreshDatabaseCanCloseAndReopen()
  testConfigurationFailuresAreStableAndFailClosed()
}

module.exports = { run }

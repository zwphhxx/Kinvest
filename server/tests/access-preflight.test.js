const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const {
  ADMIN_SECRET_NAME,
  generateAdminPasswordVerifier,
  generateDeviceHmacSecret
} = require('../security/secret-bootstrap-contract')

const ADMIN_VERSION = 'v20260822-001'
const HMAC_VERSION = 'v20260822-002'
const VERSION_CONFIG = JSON.stringify({
  adminPasswordVerifier: ADMIN_VERSION,
  deviceTokenHmac: {
    accepted: [HMAC_VERSION],
    active: HMAC_VERSION
  }
})

function capture() {
  let value = ''
  return {
    stream: { write(chunk) { value += String(chunk) } },
    value: () => value
  }
}

function enabledEnv(productionDatabasePath) {
  return {
    KINVEST_ACCESS_CONTROL_MODE: 'device-approval',
    KINVEST_SECRET_VERSION_IDS: VERSION_CONFIG,
    KINVEST_TRUSTED_PROXY_ADDRESSES: '["127.0.0.1"]',
    KINVEST_DB_PATH: productionDatabasePath
  }
}

function createSecretRuntime(options = {}) {
  const material = {
    admin: Buffer.from(generateAdminPasswordVerifier(
      'preflight-fixture-password',
      (size) => Buffer.alloc(size, 21)
    )),
    hmac: Buffer.from(generateDeviceHmacSecret(
      (size) => Buffer.alloc(size, 22)
    ))
  }
  const returned = []
  let clearCount = 0
  const runtime = {
    status: Object.freeze({
      mode: options.mode || 'github-tmpfs-v1',
      referenceCount: options.referenceCount ?? 2
    }),
    readSecret(reference) {
      if (options.readError) throw options.readError
      const source = reference.secretName === ADMIN_SECRET_NAME
        ? material.admin
        : material.hmac
      const value = Buffer.from(source)
      returned.push(value)
      return value
    },
    clear() {
      clearCount += 1
      material.admin.fill(0)
      material.hmac.fill(0)
    }
  }
  return {
    runtime,
    returned,
    clearCount: () => clearCount,
    materialBuffers: Object.values(material)
  }
}

function assertCode(error, expectedCode) {
  assert.equal(error && error.code, expectedCode)
  return true
}

async function testSharedPreparationAndSuccessfulPreflight(tempDirectory) {
  const { prepareApplication } = require('../pre-listen-preparation')
  const { runAccessPreflight } = require('../access-preflight')
  const { closeDatabase, openDbAtPath } = require('../db/refresh-db')
  const sourcePath = path.join(tempDirectory, 'source.sqlite')
  const snapshotPath = path.join(tempDirectory, 'snapshot.sqlite')
  const source = new DatabaseSync(sourcePath)
  source.exec('CREATE TABLE source_marker (value TEXT NOT NULL); INSERT INTO source_marker VALUES (\'unchanged\')')
  source.close()
  const sourceBefore = fs.readFileSync(sourcePath)
  fs.copyFileSync(sourcePath, snapshotPath)

  const secret = createSecretRuntime()
  const originalCreateServer = http.createServer
  let createServerCalls = 0
  http.createServer = () => {
    createServerCalls += 1
    throw new Error('pre-listen preparation must not create or listen on a server')
  }
  let prepared
  try {
    prepared = await prepareApplication({
      env: enabledEnv(sourcePath),
      bootstrap: async () => secret.runtime,
      openDatabase: () => openDbAtPath(snapshotPath),
      closeDatabase
    })
  } finally {
    http.createServer = originalCreateServer
  }
  assert.equal(createServerCalls, 0)
  assert.deepStrictEqual(prepared.status, {
    mode: 'device-approval',
    references: 2,
    database: 'ready',
    proxy: 'ready'
  })
  assert.equal(typeof prepared.handler, 'function')
  assert.equal(Object.prototype.hasOwnProperty.call(prepared, 'listen'), false)
  prepared.clear()
  prepared.clear()
  assert.equal(secret.clearCount(), 1)
  assert.equal(secret.returned.every((buffer) =>
    buffer.every((byte) => byte === 0)), true)
  assert.equal(secret.materialBuffers.every((buffer) =>
    buffer.every((byte) => byte === 0)), true)
  assert.deepStrictEqual(fs.readFileSync(sourcePath), sourceBefore)

  const snapshot = new DatabaseSync(snapshotPath)
  assert.equal(snapshot.prepare('PRAGMA application_id').get().application_id, 0x4B494E56)
  assert.equal(snapshot.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'device_auth_requests'"
  ).get().count, 1)
  snapshot.close()

  const successSecret = createSecretRuntime()
  const stdout = capture()
  const stderr = capture()
  assert.equal(await runAccessPreflight({
    env: enabledEnv(sourcePath),
    databasePath: snapshotPath,
    bootstrap: async () => successSecret.runtime,
    stdout: stdout.stream,
    stderr: stderr.stream,
    processRef: new EventEmitter()
  }), 0)
  assert.equal(
    stdout.value(),
    'KINVEST_ACCESS_PREFLIGHT_OK mode=device-approval references=2 database=ready proxy=ready\n'
  )
  assert.equal(stderr.value(), '')
  assert.equal(successSecret.clearCount(), 1)
}

async function testStableFailuresAndDatabaseClosure(tempDirectory) {
  const { prepareApplication } = require('../pre-listen-preparation')
  const { runAccessPreflight } = require('../access-preflight')
  const productionPath = path.join(tempDirectory, 'production.sqlite')

  for (const fixture of [
    {
      name: 'missing secret',
      bootstrap: async () => {
        throw Object.assign(new Error('password=hunter2 RequestId=request-secret'), {
          code: 'SECRET_MATERIAL_LOAD_FAILED'
        })
      },
      expected: 'SECRET_MATERIAL_LOAD_FAILED\n'
    },
    {
      name: 'wrong version or material',
      bootstrap: async () => createSecretRuntime({
        readError: new Error('VersionId=v-sensitive token=sensitive')
      }).runtime,
      expected: 'ACCESS_CONTROL_CONFIG_INVALID\n'
    }
  ]) {
    const stdout = capture()
    const stderr = capture()
    const databasePath = path.join(tempDirectory, `${fixture.name}.sqlite`)
    assert.equal(await runAccessPreflight({
      env: enabledEnv(productionPath),
      databasePath,
      bootstrap: fixture.bootstrap,
      stdout: stdout.stream,
      stderr: stderr.stream,
      processRef: new EventEmitter()
    }), 1)
    assert.equal(stdout.value(), '')
    assert.equal(stderr.value(), fixture.expected)
    assert.equal(/hunter2|RequestId|VersionId|token=|sensitive/.test(stderr.value()), false)
  }

  for (const trustedProxyValue of [undefined, 'not-json', '[]', '["bad proxy"]']) {
    const secret = createSecretRuntime()
    const env = enabledEnv(productionPath)
    if (trustedProxyValue === undefined) {
      delete env.KINVEST_TRUSTED_PROXY_ADDRESSES
    } else {
      env.KINVEST_TRUSTED_PROXY_ADDRESSES = trustedProxyValue
    }
    let closeCount = 0
    const database = new DatabaseSync(':memory:')
    await assert.rejects(prepareApplication({
      env,
      bootstrap: async () => secret.runtime,
      openDatabase: () => database,
      closeDatabase(value) {
        assert.equal(value, database)
        closeCount += 1
        value.close()
      }
    }), (error) => assertCode(error, 'HTTP_SECURITY_CONFIG_INVALID'))
    assert.equal(closeCount, 1)
    assert.equal(secret.clearCount(), 1)
  }

  const throwingCleanupSecret = createSecretRuntime()
  let throwingAccessClearCount = 0
  await assert.rejects(prepareApplication({
    env: enabledEnv(productionPath),
    bootstrap: async () => throwingCleanupSecret.runtime,
    createAccessRuntime: () => ({
      status: Object.freeze({ mode: 'device-approval' }),
      clear() {
        throwingAccessClearCount += 1
        throw new Error('password=sensitive cleanup failure')
      }
    }),
    createHandler: () => {
      throw new Error('RequestId=sensitive handler failure')
    }
  }), (error) => assertCode(error, 'HTTP_SECURITY_CONFIG_INVALID'))
  assert.equal(throwingAccessClearCount, 1)
  assert.equal(throwingCleanupSecret.clearCount(), 1)

  const identityPath = path.join(tempDirectory, 'wrong-identity.sqlite')
  const identityDatabase = new DatabaseSync(identityPath)
  identityDatabase.exec('PRAGMA application_id = 12345')
  identityDatabase.close()
  const corruptPath = path.join(tempDirectory, 'corrupt.sqlite')
  fs.writeFileSync(corruptPath, 'not a sqlite database; password=fixture')

  for (const databasePath of [identityPath, corruptPath]) {
    const stdout = capture()
    const stderr = capture()
    assert.equal(await runAccessPreflight({
      env: enabledEnv(productionPath),
      databasePath,
      bootstrap: async () => createSecretRuntime().runtime,
      stdout: stdout.stream,
      stderr: stderr.stream,
      processRef: new EventEmitter()
    }), 1)
    assert.equal(stdout.value(), '')
    assert.equal(stderr.value(), 'ACCESS_CONTROL_CONFIG_INVALID\n')
    assert.doesNotThrow(() => {
      const reopened = new DatabaseSync(databasePath)
      reopened.close()
    })
  }

  const rawFailingDatabase = new DatabaseSync(':memory:')
  const failingDatabase = new Proxy(rawFailingDatabase, {
    get(target, property) {
      if (property === 'exec') {
        return (sql) => {
          if (String(sql).includes('CREATE TABLE IF NOT EXISTS device_auth_requests')) {
            throw new Error('password=sensitive initialization failure')
          }
          return target.exec(sql)
        }
      }
      const value = target[property]
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  let initializationCloseCount = 0
  await assert.rejects(prepareApplication({
    env: enabledEnv(productionPath),
    bootstrap: async () => createSecretRuntime().runtime,
    openDatabase: () => failingDatabase,
    closeDatabase(database) {
      initializationCloseCount += 1
      database.close()
    }
  }), (error) => assertCode(error, 'ACCESS_CONTROL_CONFIG_INVALID'))
  assert.equal(initializationCloseCount, 1)

  const samePathOut = capture()
  const samePathErr = capture()
  assert.equal(await runAccessPreflight({
    env: enabledEnv(productionPath),
    databasePath: productionPath,
    bootstrap: async () => createSecretRuntime().runtime,
    stdout: samePathOut.stream,
    stderr: samePathErr.stream,
    processRef: new EventEmitter()
  }), 1)
  assert.equal(samePathOut.value(), '')
  assert.equal(samePathErr.value(), 'ACCESS_PREFLIGHT_DATABASE_PATH_INVALID\n')
}

async function testSignalCleanup(tempDirectory) {
  const { runAccessPreflight } = require('../access-preflight')
  const processRef = new EventEmitter()
  const stdout = capture()
  const stderr = capture()
  let preparationStarted = false
  /** @type {(value: any) => void} */
  let resolvePreparation = (value) => {
    void value
    throw new Error('preparation did not start')
  }
  let clearCount = 0
  const running = runAccessPreflight({
    env: enabledEnv(path.join(tempDirectory, 'production-signal.sqlite')),
    databasePath: path.join(tempDirectory, 'snapshot-signal.sqlite'),
    prepare: async () => new Promise((resolve) => {
      preparationStarted = true
      resolvePreparation = resolve
    }),
    stdout: stdout.stream,
    stderr: stderr.stream,
    processRef
  })
  processRef.emit('SIGTERM')
  assert.equal(preparationStarted, true)
  resolvePreparation({
    status: {
      mode: 'device-approval',
      references: 2,
      database: 'ready',
      proxy: 'ready'
    },
    handler() {},
    clear() { clearCount += 1 }
  })
  assert.equal(await running, 1)
  assert.equal(stdout.value(), '')
  assert.equal(stderr.value(), 'ACCESS_PREFLIGHT_INTERRUPTED\n')
  assert.equal(clearCount, 1)
  assert.equal(processRef.listenerCount('SIGTERM'), 0)
  assert.equal(processRef.listenerCount('SIGINT'), 0)
}

async function run() {
  const preparationPath = path.resolve(__dirname, '../pre-listen-preparation.js')
  assert.equal(
    fs.existsSync(preparationPath),
    true,
    'shared pre-listen preparation entry must exist'
  )
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-access-preflight-'))
  try {
    await testSharedPreparationAndSuccessfulPreflight(tempDirectory)
    await testStableFailuresAndDatabaseClosure(tempDirectory)
    await testSignalCleanup(tempDirectory)
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true })
  }
}

module.exports = { run }

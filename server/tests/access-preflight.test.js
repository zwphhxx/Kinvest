const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
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
const { bootstrapSecrets } = require('../security/secret-bootstrap')
const {
  createGithubTmpfsSecretLoaderForTest
} = require('./support/load-github-tmpfs-provider-for-test')

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

function realProviderEnv(productionDatabasePath) {
  return {
    ...enabledEnv(productionDatabasePath),
    KINVEST_SECRET_PROVIDER_MODE: 'github-tmpfs-v1',
    KINVEST_SECRET_BUNDLE_PATH: '/run/secrets/kinvest'
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/**
 * @param {string} root
 * @param {{missing?: string, manifestVersion?: string, adminMaterial?: Buffer, hmacMaterial?: Buffer}} [options]
 */
function createRealBundle(root, {
  missing,
  manifestVersion = ADMIN_VERSION,
  adminMaterial = Buffer.from(JSON.stringify({
    digest: Buffer.alloc(32, 31).toString('base64url'),
    format: 'kinvest-admin-scrypt-v1',
    n: 65536,
    p: 1,
    r: 8,
    salt: Buffer.alloc(16, 32).toString('base64url')
  })),
  hmacMaterial = Buffer.from(Buffer.alloc(32, 33).toString('base64url'))
} = {}) {
  const bundlePath = path.join(root, 'github-tmpfs-bundle')
  fs.mkdirSync(bundlePath, { mode: 0o700 })
  const files = new Map([
    ['admin-password-verifier', adminMaterial],
    ['device-token-hmac-key', hmacMaterial]
  ])
  for (const [name, material] of files) {
    if (missing === name) continue
    fs.writeFileSync(path.join(bundlePath, name), material, { mode: 0o440 })
  }
  fs.writeFileSync(path.join(bundlePath, 'manifest.json'), JSON.stringify({
    format: 'kinvest-github-tmpfs-v1',
    adminPasswordVerifier: {
      file: 'admin-password-verifier',
      versionId: manifestVersion,
      sha256: sha256(adminMaterial)
    },
    deviceTokenHmac: {
      file: 'device-token-hmac-key',
      versionId: manifestVersion === ADMIN_VERSION ? HMAC_VERSION : manifestVersion,
      sha256: sha256(hmacMaterial)
    }
  }), { mode: 0o440 })
  for (const name of fs.readdirSync(bundlePath)) {
    fs.chmodSync(path.join(bundlePath, name), 0o440)
  }
  fs.chmodSync(bundlePath, 0o550)
  return {
    bundlePath,
    loadSecrets: createGithubTmpfsSecretLoaderForTest({
      bundlePath,
      expectedUid: process.getuid(),
      expectedGid: process.getgid()
    })
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

function createEmptyDatabase(databasePath) {
  const database = new DatabaseSync(databasePath)
  database.close()
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
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'refresh_counters'"
  ).get().count, 1)
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

async function testRealOpenerChecksIdentityBeforeRefreshExpand(tempDirectory) {
  const { prepareApplication } = require('../pre-listen-preparation')
  const { closeDatabase, openDbAtPath } = require('../db/refresh-db')
  const databasePath = path.join(tempDirectory, 'real-opener-wrong-identity.sqlite')
  const setup = new DatabaseSync(databasePath)
  setup.exec('PRAGMA application_id = 12345')
  setup.close()
  const before = fs.readFileSync(databasePath)
  const secret = createSecretRuntime()

  await assert.rejects(prepareApplication({
    env: enabledEnv(path.join(tempDirectory, 'production.sqlite')),
    bootstrap: async () => secret.runtime,
    openDatabase: () => openDbAtPath(databasePath),
    closeDatabase
  }), (error) => assertCode(error, 'ACCESS_CONTROL_CONFIG_INVALID'))

  assert.deepStrictEqual(fs.readFileSync(databasePath), before)
  const inspection = new DatabaseSync(databasePath)
  assert.deepStrictEqual(inspection.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
  ).all(), [])
  inspection.close()
  assert.equal(secret.clearCount(), 1)
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
    createEmptyDatabase(databasePath)
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
  const identityBefore = fs.readFileSync(identityPath)
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
    if (databasePath === identityPath) {
      assert.deepStrictEqual(fs.readFileSync(identityPath), identityBefore)
    }
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

async function testDatabasePathIsolation(tempDirectory) {
  const { runAccessPreflight } = require('../access-preflight')
  const productionPath = path.join(tempDirectory, 'isolation-production.sqlite')
  const production = new DatabaseSync(productionPath)
  production.exec("CREATE TABLE production_marker (value TEXT NOT NULL); INSERT INTO production_marker VALUES ('unchanged')")
  production.close()
  const productionBefore = fs.readFileSync(productionPath)

  const missingPath = path.join(tempDirectory, 'missing-candidate.sqlite')
  const realParent = path.join(tempDirectory, 'real-parent')
  const aliasParent = path.join(tempDirectory, 'alias-parent')
  fs.mkdirSync(realParent)
  const parentCandidate = path.join(realParent, 'candidate.sqlite')
  createEmptyDatabase(parentCandidate)
  fs.symlinkSync(realParent, aliasParent, 'dir')
  const fileTarget = path.join(tempDirectory, 'file-target.sqlite')
  const fileAlias = path.join(tempDirectory, 'file-alias.sqlite')
  createEmptyDatabase(fileTarget)
  fs.symlinkSync(fileTarget, fileAlias)

  for (const databasePath of [
    missingPath,
    path.join(aliasParent, 'candidate.sqlite'),
    fileAlias
  ]) {
    let bootstrapCalls = 0
    const stdout = capture()
    const stderr = capture()
    assert.equal(await runAccessPreflight({
      env: enabledEnv(productionPath),
      databasePath,
      bootstrap: async () => {
        bootstrapCalls += 1
        return createSecretRuntime().runtime
      },
      stdout: stdout.stream,
      stderr: stderr.stream,
      processRef: new EventEmitter()
    }), 1)
    assert.equal(bootstrapCalls, 0)
    assert.equal(stdout.value(), '')
    assert.equal(stderr.value(), 'ACCESS_PREFLIGHT_DATABASE_PATH_INVALID\n')
  }

  const replacementPath = path.join(tempDirectory, 'replacement-candidate.sqlite')
  fs.copyFileSync(productionPath, replacementPath)
  const replacementStdout = capture()
  const replacementStderr = capture()
  assert.equal(await runAccessPreflight({
    env: enabledEnv(productionPath),
    databasePath: replacementPath,
    bootstrap: async () => {
      fs.rmSync(replacementPath)
      fs.linkSync(productionPath, replacementPath)
      return createSecretRuntime().runtime
    },
    stdout: replacementStdout.stream,
    stderr: replacementStderr.stream,
    processRef: new EventEmitter()
  }), 0)
  assert.equal(
    replacementStdout.value(),
    'KINVEST_ACCESS_PREFLIGHT_OK mode=device-approval references=2 database=ready proxy=ready\n'
  )
  assert.equal(replacementStderr.value(), '')
  assert.deepStrictEqual(fs.readFileSync(productionPath), productionBefore)
}

async function testRealGithubTmpfsProviderChain(tempDirectory) {
  const { runAccessPreflight } = require('../access-preflight')
  const productionPath = path.join(tempDirectory, 'real-provider-production.sqlite')
  const cases = [
    {
      name: 'success',
      expectedExit: 0,
      expectedStdout: 'KINVEST_ACCESS_PREFLIGHT_OK mode=device-approval references=2 database=ready proxy=ready\n',
      expectedStderr: ''
    },
    {
      name: 'missing-secret',
      bundle: { missing: 'device-token-hmac-key' },
      expectedExit: 1,
      expectedStdout: '',
      expectedStderr: 'GITHUB_TMPFS_BUNDLE_INVALID\n'
    },
    {
      name: 'version-mismatch',
      bundle: { manifestVersion: 'v20260822-099' },
      expectedExit: 1,
      expectedStdout: '',
      expectedStderr: 'GITHUB_TMPFS_BUNDLE_INVALID\n'
    },
    {
      name: 'invalid-admin',
      bundle: { adminMaterial: Buffer.from('invalid-admin-material-marker') },
      expectedExit: 1,
      expectedStdout: '',
      expectedStderr: 'SECRET_MATERIAL_INVALID\n'
    },
    {
      name: 'invalid-hmac',
      bundle: { hmacMaterial: Buffer.from('invalid-hmac-material-marker') },
      expectedExit: 1,
      expectedStdout: '',
      expectedStderr: 'SECRET_MATERIAL_INVALID\n'
    }
  ]

  for (const fixture of cases) {
    const fixtureRoot = path.join(tempDirectory, `real-provider-${fixture.name}`)
    fs.mkdirSync(fixtureRoot)
    const bundle = createRealBundle(fixtureRoot, fixture.bundle)
    const candidatePath = path.join(fixtureRoot, 'candidate.sqlite')
    createEmptyDatabase(candidatePath)
    const stdout = capture()
    const stderr = capture()
    try {
      assert.equal(await runAccessPreflight({
        env: realProviderEnv(productionPath),
        databasePath: candidatePath,
        bootstrap: bootstrapSecrets,
        loadSecrets: bundle.loadSecrets,
        stdout: stdout.stream,
        stderr: stderr.stream,
        processRef: new EventEmitter()
      }), fixture.expectedExit, fixture.name)
      assert.equal(stdout.value(), fixture.expectedStdout, fixture.name)
      assert.equal(stderr.value(), fixture.expectedStderr, fixture.name)
      assert.equal(
        /material-marker|v20260822-099|127\.0\.0\.1/.test(stderr.value()),
        false,
        fixture.name
      )
    } finally {
      fs.chmodSync(bundle.bundlePath, 0o700)
    }
  }
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
  createEmptyDatabase(path.join(tempDirectory, 'snapshot-signal.sqlite'))
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

async function waitForMarker(markerPath, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(markerPath)) return
    if (child.exitCode !== null || child.signalCode !== null) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail('pending preflight worker did not reach bootstrap')
}

async function testSubprocessSignalCancellation(tempDirectory) {
  const workerPath = path.join(
    __dirname,
    'fixtures',
    'access-preflight-pending-worker.js'
  )
  for (const signal of /** @type {NodeJS.Signals[]} */ (['SIGTERM', 'SIGINT'])) {
    const candidatePath = path.join(tempDirectory, `signal-${signal}.sqlite`)
    const productionPath = path.join(tempDirectory, `signal-${signal}-production.sqlite`)
    const markerPath = path.join(tempDirectory, `signal-${signal}.marker`)
    createEmptyDatabase(candidatePath)
    const child = spawn(process.execPath, [
      workerPath,
      candidatePath,
      productionPath,
      markerPath
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    await waitForMarker(markerPath, child)
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'allocated\n')
    const exit = new Promise((resolve) => child.once('exit', (code, exitSignal) => {
      resolve({ code, signal: exitSignal })
    }))
    child.kill(signal)
    const result = await Promise.race([
      exit,
      new Promise((resolve) => setTimeout(() => resolve(null), 1500))
    ])
    if (!result) {
      child.kill('SIGKILL')
      await exit
      assert.fail(`${signal} preflight did not exit promptly`)
    }
    assert.deepStrictEqual(result, { code: 1, signal: null })
    assert.equal(stdout, '')
    assert.equal(stderr, 'ACCESS_PREFLIGHT_INTERRUPTED\n')
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'cleared\n')
  }
}

function testExecutableOutputContract(tempDirectory) {
  const workerPath = path.join(
    __dirname,
    'fixtures',
    'access-preflight-real-worker.js'
  )
  const fixtureRoot = path.join(tempDirectory, 'executable-real-provider')
  const productionPath = path.join(fixtureRoot, 'production.sqlite')
  fs.mkdirSync(fixtureRoot)
  const bundle = createRealBundle(fixtureRoot)
  try {
    const successCandidate = path.join(fixtureRoot, 'success.sqlite')
    createEmptyDatabase(successCandidate)
    const success = spawnSync(process.execPath, [
      workerPath,
      successCandidate,
      productionPath,
      bundle.bundlePath
    ], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        ...realProviderEnv(productionPath)
      }
    })
    assert.equal(success.status, 0)
    assert.equal(
      success.stdout,
      'KINVEST_ACCESS_PREFLIGHT_OK mode=device-approval references=2 database=ready proxy=ready\n'
    )
    assert.equal(success.stderr, '')

    const failureCandidate = path.join(fixtureRoot, 'failure.sqlite')
    createEmptyDatabase(failureCandidate)
    const proxyConfiguration = '["203.0.113.8","203.0.113.8"]'
    const failure = spawnSync(process.execPath, [
      workerPath,
      failureCandidate,
      productionPath,
      bundle.bundlePath
    ], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        ...realProviderEnv(productionPath),
        KINVEST_TRUSTED_PROXY_ADDRESSES: proxyConfiguration
      }
    })
    assert.equal(failure.status, 1)
    assert.equal(failure.stdout, '')
    assert.equal(failure.stderr, 'HTTP_SECURITY_CONFIG_INVALID\n')
    assert.equal(failure.stderr.includes(proxyConfiguration), false)
    assert.equal(failure.stderr.includes(ADMIN_VERSION), false)
    assert.equal(failure.stderr.includes(HMAC_VERSION), false)
    assert.equal(failure.stderr.includes('RequestId'), false)
  } finally {
    fs.chmodSync(bundle.bundlePath, 0o700)
  }
}

async function run() {
  const preparationPath = path.resolve(__dirname, '../pre-listen-preparation.js')
  assert.equal(
    fs.existsSync(preparationPath),
    true,
    'shared pre-listen preparation entry must exist'
  )
  const tempDirectory = fs.realpathSync(fs.mkdtempSync(
    path.join(os.tmpdir(), 'kinvest-access-preflight-')
  ))
  try {
    await testSharedPreparationAndSuccessfulPreflight(tempDirectory)
    await testRealOpenerChecksIdentityBeforeRefreshExpand(tempDirectory)
    await testStableFailuresAndDatabaseClosure(tempDirectory)
    await testDatabasePathIsolation(tempDirectory)
    await testRealGithubTmpfsProviderChain(tempDirectory)
    await testSignalCleanup(tempDirectory)
    await testSubprocessSignalCancellation(tempDirectory)
    testExecutableOutputContract(tempDirectory)
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true })
  }
}

module.exports = { run }

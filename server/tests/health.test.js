const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')
const assert = require('assert')
const { spawn, spawnSync } = require('child_process')
const { setDbPath, resetDbForTests } = require('../db/refresh-db')
const { getHealthState } = require('../services/health')

const repositoryRoot = path.join(__dirname, '../..')

function loadHealthWithOpenDb(openDb) {
  const dbModulePath = require.resolve('../db/refresh-db')
  const healthModulePath = require.resolve('../services/health')
  const dbModule = require.cache[dbModulePath]
  const originalOpenDb = dbModule.exports.openDb
  const originalHealthModule = require.cache[healthModulePath]

  dbModule.exports.openDb = openDb
  delete require.cache[healthModulePath]

  try {
    return require('../services/health').getHealthState
  } finally {
    dbModule.exports.openDb = originalOpenDb
    if (originalHealthModule) {
      require.cache[healthModulePath] = originalHealthModule
    } else {
      delete require.cache[healthModulePath]
    }
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      const port = address.port
      server.close((err) => {
        if (err) {
          reject(err)
          return
        }
        resolve(port)
      })
    })
  })
}

async function startServer(dbPath) {
  const port = await getFreePort()
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PORT: String(port),
      KINVEST_DB_PATH: dbPath
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  child.stdout.setEncoding('utf8')
  child.stderr.resume()

  await new Promise((resolve, reject) => {
    let output = ''
    let settled = false
    const timeout = setTimeout(() => finish(new Error('Server startup timed out')), 5000)

    function cleanup() {
      clearTimeout(timeout)
      child.stdout.removeListener('data', onStdout)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
    }

    function finish(err) {
      if (settled) return
      settled = true
      cleanup()
      if (err) {
        child.kill()
        reject(err)
        return
      }
      resolve()
    }

    function onStdout(chunk) {
      output += chunk
      if (output.includes('Kinvest mock server started')) {
        finish()
      }
    }

    function onError(err) {
      finish(err)
    }

    function onExit(code) {
      finish(new Error(`Server exited before startup with code ${code}`))
    }

    child.stdout.on('data', onStdout)
    child.once('error', onError)
    child.once('exit', onExit)
  })

  return {
    child,
    baseUrl: `http://127.0.0.1:${port}`
  }
}

function permissionBits(filePath) {
  return fs.statSync(filePath).mode & 0o777
}

function assertOwnedByCurrentUser(filePath) {
  assert.strictEqual(
    fs.statSync(filePath).uid,
    process.getuid(),
    `${path.basename(filePath)} must be owned by the service process uid`
  )
}

function assertImportDoesNotChangeUmask() {
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      [
        'const before = process.umask()',
        "require('./server/server')",
        'const after = process.umask()',
        "if (after !== before) throw new Error(`umask changed from ${before.toString(8)} to ${after.toString(8)}`)"
      ].join(';')
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 3000
    }
  )

  assert.strictEqual(
    probe.status,
    0,
    `Importing server.js must not start the server or change umask: ${probe.stderr || probe.error || ''}`
  )
}

async function startWalProbe(dbPath) {
  const source = [
    "const { applyRuntimeFileCreationMask } = require('./server/server')",
    "const { DatabaseSync } = require('node:sqlite')",
    'applyRuntimeFileCreationMask()',
    'const db = new DatabaseSync(process.argv[1])',
    "db.exec('PRAGMA journal_mode = WAL; CREATE TABLE probe (id INTEGER); BEGIN IMMEDIATE; INSERT INTO probe VALUES (1)')",
    "process.stdout.write('wal-ready\\n')",
    'const timer = setInterval(() => {}, 1000)',
    "process.on('SIGTERM', () => { clearInterval(timer); try { db.exec('ROLLBACK') } catch {}; db.close(); process.exit(0) })"
  ].join(';')

  const child = spawn(process.execPath, ['-e', source, dbPath], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  await new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeout = setTimeout(() => finish(new Error(`WAL probe timed out: ${stderr}`)), 5000)

    function cleanup() {
      clearTimeout(timeout)
      child.stdout.removeListener('data', onStdout)
      child.stderr.removeListener('data', onStderr)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
    }

    function finish(err) {
      if (settled) return
      settled = true
      cleanup()
      if (err) {
        child.kill()
        reject(err)
        return
      }
      resolve()
    }

    function onStdout(chunk) {
      stdout += chunk
      if (stdout.includes('wal-ready')) finish()
    }

    function onStderr(chunk) {
      stderr += chunk
    }

    function onError(err) {
      finish(err)
    }

    function onExit(code) {
      finish(new Error(`WAL probe exited before readiness with code ${code}: ${stderr}`))
    }

    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('error', onError)
    child.once('exit', onExit)
  })

  return child
}

async function testRuntimeDatabasePermissions(tempDir) {
  if (process.platform === 'win32') return

  assertImportDoesNotChangeUmask()

  const parentUmask = process.umask()
  const dbPath = path.join(tempDir, 'secure-runtime.sqlite')
  const runtimeServer = await startServer(dbPath)

  try {
    const response = await fetch(`${runtimeServer.baseUrl}/api/health`, {
      signal: AbortSignal.timeout(3000)
    })
    assert.strictEqual(response.status, 200)
    assert.strictEqual(permissionBits(dbPath), 0o600)
    assertOwnedByCurrentUser(dbPath)
    assert.strictEqual(process.umask(), parentUmask, 'Service child must not change the test parent umask')
  } finally {
    await stopServer(runtimeServer.child)
  }

  const stricterDbPath = path.join(tempDir, 'stricter-existing.sqlite')
  fs.writeFileSync(stricterDbPath, '')
  fs.chmodSync(stricterDbPath, 0o400)
  const stricterServer = await startServer(stricterDbPath)

  try {
    await fetch(`${stricterServer.baseUrl}/api/health`, {
      signal: AbortSignal.timeout(3000)
    })
    assert.strictEqual(permissionBits(stricterDbPath), 0o400)
  } finally {
    await stopServer(stricterServer.child)
  }

  const walDbPath = path.join(tempDir, 'secure-wal.sqlite')
  const walProbe = await startWalProbe(walDbPath)

  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const sqlitePath = `${walDbPath}${suffix}`
      assert.strictEqual(fs.existsSync(sqlitePath), true, `${path.basename(sqlitePath)} must exist`)
      assert.strictEqual(permissionBits(sqlitePath), 0o600)
      assertOwnedByCurrentUser(sqlitePath)
    }
  } finally {
    await stopServer(walProbe)
  }
}

function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 2000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    child.kill()
  })
}

async function testHttpRoutes(tempDir) {
  const healthyServer = await startServer(path.join(tempDir, 'http.sqlite'))

  try {
    const healthResponse = await fetch(`${healthyServer.baseUrl}/api/health`, {
      signal: AbortSignal.timeout(3000)
    })
    const health = await healthResponse.json()
    assert.strictEqual(healthResponse.status, 200)
    assert.strictEqual(health.status, 'ok')
    assert.strictEqual(health.service, 'kinvest')
    assert.strictEqual(health.dataMode, 'mock')
    assert.strictEqual(health.database, 'ready')
    assert.strictEqual(new Date(health.timestamp).toISOString(), health.timestamp)

    const watchlistResponse = await fetch(`${healthyServer.baseUrl}/api/watchlist`, {
      signal: AbortSignal.timeout(3000)
    })
    const watchlist = await watchlistResponse.json()
    assert.strictEqual(watchlistResponse.status, 200)
    assert.strictEqual(watchlist.success, true)
    assert.strictEqual(Array.isArray(watchlist.data), true)
  } finally {
    await stopServer(healthyServer.child)
  }

  const failedDbPath = path.join(tempDir, 'database-directory')
  fs.mkdirSync(failedDbPath)
  const failingServer = await startServer(failedDbPath)

  try {
    const healthResponse = await fetch(`${failingServer.baseUrl}/api/health`, {
      signal: AbortSignal.timeout(3000)
    })
    assert.strictEqual(healthResponse.status, 503)
    assert.deepStrictEqual(await healthResponse.json(), {
      success: false,
      error: 'Health check failed',
      code: 503
    })
  } finally {
    await stopServer(failingServer.child)
  }
}

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-health-'))
  const dbFile = path.join(tempDir, 'health.sqlite')
  setDbPath(dbFile)

  try {
    const health = getHealthState(new Date('2026-07-28T10:00:00.000Z'))

    assert.deepStrictEqual(health, {
      status: 'ok',
      service: 'kinvest',
      dataMode: 'mock',
      database: 'ready',
      timestamp: '2026-07-28T10:00:00.000Z'
    })
    assert.strictEqual(fs.existsSync(dbFile), true)

    const getHealthWithFailedProbe = loadHealthWithOpenDb(() => ({
      prepare() {
        return {
          get() {
            return { ready: 0 }
          }
        }
      }
    }))

    assert.throws(
      () => getHealthWithFailedProbe(new Date('2026-07-28T10:00:00.000Z')),
      { message: 'SQLite health query failed' }
    )

    const getHealthWithStringProbe = loadHealthWithOpenDb(() => ({
      prepare() {
        return {
          get() {
            return { ready: '1' }
          }
        }
      }
    }))

    assert.throws(
      () => getHealthWithStringProbe(new Date('2026-07-28T10:00:00.000Z')),
      { message: 'SQLite health query failed' }
    )

    await testHttpRoutes(tempDir)
    await testRuntimeDatabasePermissions(tempDir)
  } finally {
    resetDbForTests(dbFile)
    fs.rmSync(tempDir, { recursive: true, force: true })
    assert.strictEqual(fs.existsSync(dbFile), false)
    assert.strictEqual(fs.existsSync(tempDir), false)
  }
}

module.exports = { run }

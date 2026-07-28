const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')
const assert = require('assert')
const { spawn } = require('child_process')
const { setDbPath, resetDbForTests } = require('../db/refresh-db')
const { getHealthState } = require('../services/health')

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
    cwd: path.join(__dirname, '../..'),
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
  } finally {
    resetDbForTests(dbFile)
    fs.rmSync(tempDir, { recursive: true, force: true })
    assert.strictEqual(fs.existsSync(dbFile), false)
    assert.strictEqual(fs.existsSync(tempDir), false)
  }
}

module.exports = { run }

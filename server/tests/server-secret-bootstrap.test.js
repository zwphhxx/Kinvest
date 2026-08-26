const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

class FakeServer extends EventEmitter {
  constructor() {
    super()
    this.listenCalls = 0
    this.closeCalls = 0
  }

  listen(_port, callback) {
    this.listenCalls += 1
    callback()
    return this
  }

  close() {
    this.closeCalls += 1
    this.emit('close')
  }
}

async function testAsyncInFlightShutdown() {
  const { startServer } = require('../server')
  const processRef = new EventEmitter()
  const events = []
  let releaseRequest = () => {}
  let requestStartedResolve = () => {}
  const requestStarted = new Promise((resolve) => {
    requestStartedResolve = () => resolve()
  })
  const requestBlocker = new Promise((resolve) => {
    releaseRequest = () => resolve()
  })
  const runtimeServer = http.createServer(async (_request, response) => {
    events.push('request-started')
    requestStartedResolve()
    await requestBlocker
    response.end('ok')
  })
  await startServer({
    runtimeServer,
    port: 0,
    prepare: async () => ({
      handler() {},
      clear() { events.push('runtime-cleanup') }
    }),
    closeApplicationDatabase: () => events.push('database-cleanup'),
    shutdownTimeoutMs: 1000,
    processRef,
    logger: { log() {} }
  })
  const closeCompleted = new Promise((resolve) => runtimeServer.once('close', resolve))
  const runtimeAddress = runtimeServer.address()
  assert.ok(runtimeAddress && typeof runtimeAddress === 'object')
  const responseCompleted = new Promise((resolve, reject) => {
    const request = http.get({
      host: '127.0.0.1',
      port: runtimeAddress.port,
      path: '/in-flight'
    }, (response) => {
      response.resume()
      response.once('end', resolve)
    })
    request.once('error', reject)
  })
  try {
    await requestStarted
    processRef.emit('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.deepStrictEqual(events, ['request-started'])
    releaseRequest()
    await responseCompleted
    await closeCompleted
    assert.deepStrictEqual(events, [
      'request-started',
      'runtime-cleanup',
      'database-cleanup'
    ])
  } finally {
    releaseRequest()
    if (runtimeServer.listening) {
      await new Promise((resolve) => runtimeServer.close(resolve))
    }
  }

  const forcedProcess = new EventEmitter()
  const forcedEvents = []
  let forcedRequestStartedResolve = () => {}
  const forcedRequestStarted = new Promise((resolve) => {
    forcedRequestStartedResolve = () => resolve()
  })
  const forcedServer = http.createServer(() => {
    forcedEvents.push('request-started')
    forcedRequestStartedResolve()
  })
  await startServer({
    runtimeServer: forcedServer,
    port: 0,
    prepare: async () => ({
      handler() {},
      clear() { forcedEvents.push('runtime-cleanup') }
    }),
    closeApplicationDatabase: () => forcedEvents.push('database-cleanup'),
    shutdownTimeoutMs: 25,
    processRef: forcedProcess,
    logger: { log() {} }
  })
  const forcedClosed = new Promise((resolve) => forcedServer.once('close', resolve))
  const forcedAddress = forcedServer.address()
  assert.ok(forcedAddress && typeof forcedAddress === 'object')
  const forcedRequest = http.get({
    host: '127.0.0.1',
    port: forcedAddress.port,
    path: '/forced'
  })
  forcedRequest.on('error', () => {})
  await forcedRequestStarted
  forcedProcess.emit('SIGINT')
  await Promise.race([
    forcedClosed,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('forced shutdown did not complete')),
      500
    ))
  ])
  assert.deepStrictEqual(forcedEvents, [
    'request-started',
    'runtime-cleanup',
    'database-cleanup'
  ])
}

async function run() {
  const initialUmask = process.umask()
  try {
  await testAsyncInFlightShutdown()
  const { runServerExecutable, startServer } = require('../server')
  const {
    closeDb,
    getDbPath,
    openDb,
    setDbPath
  } = require('../db/refresh-db')
  const { getHealthState } = require('../services/health')

  const originalDatabasePath = getDbPath()
  const databaseDirectory = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'kinvest-formal-db-'
  ))
  const formalDatabasePath = path.join(databaseDirectory, 'formal.sqlite')
  const formalProcess = new EventEmitter()
  const formalServer = new FakeServer()
  let accessDatabase
  try {
    closeDb()
    setDbPath(formalDatabasePath)
    await startServer({
      runtimeServer: formalServer,
      bootstrap: async () => ({
        status: Object.freeze({ mode: 'disabled', referenceCount: 0 }),
        clear() {}
      }),
      createAccessRuntime: ({ openDatabase, initializeDatabase }) => {
        accessDatabase = openDatabase()
        initializeDatabase(accessDatabase)
        return {
          status: Object.freeze({ mode: 'disabled' }),
          adminAuth: null,
          deviceApproval: null,
          clear() {
            throw new Error('fixture access cleanup failure')
          }
        }
      },
      createHttpHandler: () => () => {},
      processRef: formalProcess,
      logger: { log() {} }
    })

    getHealthState()
    const healthDatabase = openDb()
    const sharedConnection = healthDatabase === accessDatabase
    formalProcess.emit('SIGTERM')

    assert.equal(sharedConnection, true)
    assert.throws(() => accessDatabase.prepare('SELECT 1'))
    assert.throws(() => healthDatabase.prepare('SELECT 1'))
  } finally {
    closeDb()
    setDbPath(originalDatabasePath)
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
  }

  const loggerFailureOrder = []
  const loggerFailureProcess = new EventEmitter()
  const loggerFailureServer = new FakeServer()
  await startServer({
    runtimeServer: loggerFailureServer,
    bootstrap: async () => ({
      status: Object.freeze({ mode: 'disabled', referenceCount: 0 }),
      clear() { loggerFailureOrder.push('secret') }
    }),
    createAccessRuntime: ({ closeDatabase }) => {
      assert.equal(typeof closeDatabase, 'function')
      let cleared = false
      return {
        status: Object.freeze({ mode: 'disabled' }),
        adminAuth: null,
        deviceApproval: null,
        clear() {
          if (cleared) return
          cleared = true
          loggerFailureOrder.push('access')
          loggerFailureOrder.push('database')
        }
      }
    },
    processRef: loggerFailureProcess,
    logger: {
      log() { throw new Error('SENSITIVE_LOGGER_FAILURE') }
    }
  })
  assert.equal(loggerFailureServer.listenCalls, 1)
  loggerFailureProcess.emit('SIGTERM')
  assert.equal(loggerFailureServer.closeCalls, 1)
  assert.deepStrictEqual(loggerFailureOrder, ['access', 'database', 'secret'])

  const accessFailureServer = new FakeServer()
  let accessFailureSecretClearCount = 0
  await assert.rejects(startServer({
    env: { KINVEST_ACCESS_CONTROL_MODE: 'device-approval' },
    runtimeServer: accessFailureServer,
    bootstrap: async () => ({
      status: Object.freeze({ mode: 'github-tmpfs-v1', referenceCount: 2 }),
      clear() { accessFailureSecretClearCount += 1 }
    }),
    createAccessRuntime: () => {
      throw Object.assign(new Error('fixture access material must never be logged'), {
        code: 'ACCESS_CONTROL_CONFIG_INVALID'
      })
    },
    processRef: new EventEmitter(),
    logger: { log() {} }
  }))
  assert.equal(accessFailureServer.listenCalls, 0)
  assert.equal(accessFailureSecretClearCount, 1)

  const cleanupOrder = []
  const cleanupProcess = new EventEmitter()
  const cleanupServer = new FakeServer()
  await startServer({
    runtimeServer: cleanupServer,
    bootstrap: async () => ({
      status: Object.freeze({ mode: 'disabled', referenceCount: 0 }),
      clear() { cleanupOrder.push('secret') }
    }),
    createAccessRuntime: () => ({
      status: Object.freeze({ mode: 'disabled' }),
      adminAuth: null,
      deviceApproval: null,
      clear() { cleanupOrder.push('access') }
    }),
    processRef: cleanupProcess,
    logger: { log() {} }
  })
  cleanupProcess.emit('SIGTERM')
  assert.deepStrictEqual(cleanupOrder, ['access', 'secret'])

  const rejectedServer = new FakeServer()
  await assert.rejects(startServer({
    runtimeServer: rejectedServer,
    bootstrap: async () => {
      throw Object.assign(new Error('fixture secret must never be logged'), {
        code: 'SECRET_BOOTSTRAP_TEST_FAILURE'
      })
    },
    processRef: new EventEmitter(),
    logger: { log() {} }
  }))
  assert.equal(rejectedServer.listenCalls, 0)

  const processRef = new EventEmitter()
  const runtimeServer = new FakeServer()
  let clearCount = 0
  await startServer({
    runtimeServer,
    bootstrap: async () => ({
      status: Object.freeze({ mode: 'disabled', referenceCount: 0 }),
      clear() { clearCount += 1 }
    }),
    processRef,
    logger: { log() {} }
  })
  assert.equal(runtimeServer.listenCalls, 1)
  assert.equal(processRef.listenerCount('SIGTERM'), 1)
  assert.equal(processRef.listenerCount('SIGINT'), 1)
  processRef.emit('SIGTERM')
  assert.equal(runtimeServer.closeCalls, 1)
  assert.equal(clearCount, 1)
  assert.equal(processRef.listenerCount('SIGTERM'), 0)
  assert.equal(processRef.listenerCount('SIGINT'), 0)
  runtimeServer.emit('close')
  assert.equal(clearCount, 1)

  const executableServer = new FakeServer()
  const executableStderr = []
  const secretMarker = 'fixture-secret-must-not-be-printed'
  const executableExit = await runServerExecutable({
    runtimeServer: executableServer,
    bootstrap: async () => {
      throw Object.assign(new Error(secretMarker), {
        code: 'SSM_SECRET_LOAD_FAILED'
      })
    },
    processRef: new EventEmitter(),
    logger: { log() {} },
    stderr: { write: (value) => executableStderr.push(String(value)) }
  })
  assert.equal(executableExit, 1)
  assert.equal(executableServer.listenCalls, 0)
  assert.equal(executableStderr.join(''), 'SSM_SECRET_LOAD_FAILED\n')
  assert.equal(executableStderr.join('').includes(secretMarker), false)

  const accessStderr = []
  assert.equal(await runServerExecutable({
    env: { KINVEST_ACCESS_CONTROL_MODE: 'device-approval' },
    runtimeServer: new FakeServer(),
    bootstrap: async () => ({
      status: Object.freeze({ mode: 'github-tmpfs-v1', referenceCount: 2 }),
      clear() {}
    }),
    createAccessRuntime: () => {
      throw Object.assign(new Error('sensitive access failure'), {
        code: 'ACCESS_CONTROL_CONFIG_INVALID'
      })
    },
    processRef: new EventEmitter(),
    logger: { log() {} },
    stderr: { write: (value) => accessStderr.push(String(value)) }
  }), 1)
  assert.equal(accessStderr.join(''), 'ACCESS_CONTROL_CONFIG_INVALID\n')

  const ifindStderr = []
  const ifindMarker = 'path=/run/secrets/kinvest-ifind token=secret'
  assert.equal(await runServerExecutable({
    prepare: async () => {
      throw Object.assign(new Error(ifindMarker), {
        code: 'IFIND_TMPFS_BUNDLE_INVALID'
      })
    },
    runtimeServer: new FakeServer(),
    processRef: new EventEmitter(),
    logger: { log() {} },
    stderr: { write: (value) => ifindStderr.push(String(value)) }
  }), 1)
  assert.equal(ifindStderr.join(''), 'IFIND_TMPFS_BUNDLE_INVALID\n')
  assert.equal(ifindStderr.join('').includes(ifindMarker), false)

  const upstreamCode = 'ADMIN_PASSWORD_VERIFIER_V20260812_001'
  const allowlistStderr = []
  assert.equal(await runServerExecutable({
    runtimeServer: new FakeServer(),
    bootstrap: async () => {
      throw Object.assign(new Error('sensitive upstream failure'), {
        code: upstreamCode
      })
    },
    processRef: new EventEmitter(),
    logger: { log() {} },
    stderr: { write: (value) => allowlistStderr.push(String(value)) }
  }), 1)
  assert.equal(allowlistStderr.join(''), 'SECRET_BOOTSTRAP_FAILED\n')
  assert.equal(allowlistStderr.join('').includes(upstreamCode), false)

  const throwingProcess = new EventEmitter()
  const throwingServer = new FakeServer()
  throwingServer.close = () => {
    throwingServer.closeCalls += 1
    throw Object.assign(new Error('server is not running'), {
      code: 'ERR_SERVER_NOT_RUNNING'
    })
  }
  let throwingClearCount = 0
  await startServer({
    runtimeServer: throwingServer,
    bootstrap: async () => ({
      status: Object.freeze({ mode: 'disabled', referenceCount: 0 }),
      clear() { throwingClearCount += 1 }
    }),
    processRef: throwingProcess,
    logger: { log() {} }
  })
  assert.doesNotThrow(() => throwingProcess.emit('SIGINT'))
  assert.equal(throwingServer.closeCalls, 1)
  assert.equal(throwingClearCount, 1)
  assert.equal(throwingProcess.listenerCount('SIGTERM'), 0)
  assert.equal(throwingProcess.listenerCount('SIGINT'), 0)
  assert.equal(throwingServer.listenerCount('close'), 0)

  const normalProcess = new EventEmitter()
  const normalServer = new FakeServer()
  let normalClearCount = 0
  await startServer({
    runtimeServer: normalServer,
    bootstrap: async () => ({
      status: Object.freeze({ mode: 'disabled', referenceCount: 0 }),
      clear() { normalClearCount += 1 }
    }),
    processRef: normalProcess,
    logger: { log() {} }
  })
  normalServer.close()
  assert.equal(normalClearCount, 1)
  assert.equal(normalProcess.listenerCount('SIGTERM'), 0)
  assert.equal(normalProcess.listenerCount('SIGINT'), 0)
  assert.equal(normalServer.listenerCount('close'), 0)

  const listenFailureProcess = new EventEmitter()
  const listenFailureServer = new FakeServer()
  listenFailureServer.listen = function listen() {
    this.listenCalls += 1
    this.emit('error', new Error('fixture listen failure'))
    return this
  }
  let listenFailureClearCount = 0
  await assert.rejects(startServer({
    runtimeServer: listenFailureServer,
    bootstrap: async () => ({
      status: Object.freeze({ mode: 'disabled', referenceCount: 0 }),
      clear() { listenFailureClearCount += 1 }
    }),
    processRef: listenFailureProcess,
    logger: { log() {} }
  }))
  assert.equal(listenFailureClearCount, 1)
  assert.equal(listenFailureProcess.listenerCount('SIGTERM'), 0)
  assert.equal(listenFailureProcess.listenerCount('SIGINT'), 0)
  assert.equal(listenFailureServer.listenerCount('close'), 0)

  const closeErrorProcess = new EventEmitter()
  const closeErrorServer = new FakeServer()
  closeErrorServer.close = () => {
    throw Object.assign(new Error('sensitive arbitrary close text'), {
      code: 'ARBITRARY_UPSTREAM_CLOSE_CODE'
    })
  }
  await startServer({
    runtimeServer: closeErrorServer,
    bootstrap: async () => ({
      status: Object.freeze({ mode: 'disabled', referenceCount: 0 }),
      clear() {}
    }),
    processRef: closeErrorProcess,
    logger: { log() {} }
  })
  assert.throws(() => closeErrorProcess.emit('SIGTERM'), (error) => {
    assert.ok(error instanceof Error)
    assert.equal('code' in error && error.code, 'SERVER_CLOSE_FAILED')
    assert.equal(error.message.includes('sensitive arbitrary close text'), false)
    assert.equal(error.message.includes('ARBITRARY_UPSTREAM_CLOSE_CODE'), false)
    return true
  })
  } finally {
    process.umask(initialUmask)
  }
  assert.equal(process.umask(), initialUmask, 'server bootstrap suite must restore the parent process umask')
}

module.exports = { run, testAsyncInFlightShutdown }

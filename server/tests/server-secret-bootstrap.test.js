const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

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

async function run() {
  const initialUmask = process.umask()
  try {
  const { runServerExecutable, startServer } = require('../server')
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

module.exports = { run }

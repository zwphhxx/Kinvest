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
}

module.exports = { run }

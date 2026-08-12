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
  const { startServer } = require('../server')
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
}

module.exports = { run }

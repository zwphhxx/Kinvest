const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const {
  parseAdminPasswordVerifier,
  parseDeviceHmacSecret
} = require('../security/secret-bootstrap-contract')

function deterministicBytes(length, label) {
  return Buffer.from(label.repeat(length), 'utf8').subarray(0, length)
}

function hasCode(code) {
  return (error) => error instanceof Error && 'code' in error && error.code === code
}

async function run() {
  const {
    runGenerator,
    runGeneratorCli,
    stableErrorCode,
    writeMacClipboard
  } = require('../../scripts/generate-ssm-material')

  const adminClipboard = []
  const adminWriteBuffers = []
  const adminOutput = []
  const hiddenAnswers = [
    'correct horse battery staple',
    'correct horse battery staple'
  ]
  const adminResult = await runGenerator({
    mode: 'admin-password-verifier',
    input: { isTTY: true },
    output: { isTTY: true, write: (value) => adminOutput.push(String(value)) },
    promptHidden: async () => hiddenAnswers.shift(),
    waitForClear: async () => {},
    writeClipboard: async (value) => {
      adminWriteBuffers.push(value)
      adminClipboard.push(Buffer.from(value))
    },
    randomBytes: (length) => deterministicBytes(length, 'admin-salt')
  })
  assert.deepEqual(adminResult, { kind: 'admin-password-verifier' })
  assert.equal(adminClipboard.length, 2)
  const parsedAdmin = parseAdminPasswordVerifier(adminClipboard[0])
  parsedAdmin.digest.fill(0)
  parsedAdmin.salt.fill(0)
  assert.equal(adminClipboard[1].length, 0)
  assert.equal(Buffer.isBuffer(adminWriteBuffers[0]), true)
  assert.equal(adminWriteBuffers[0].every((byte) => byte === 0), true)
  assert.equal(adminOutput.join('').includes(adminClipboard[0]), false)
  assert.equal(JSON.stringify(adminResult).includes(adminClipboard[0]), false)

  const hmacClipboard = []
  const hmacResult = await runGenerator({
    mode: 'device-token-hmac',
    input: { isTTY: true },
    output: { isTTY: true, write() {} },
    waitForClear: async () => {},
    writeClipboard: async (value) => hmacClipboard.push(Buffer.from(value)),
    randomBytes: (length) => deterministicBytes(length, 'device-hmac')
  })
  assert.deepEqual(hmacResult, { kind: 'device-token-hmac' })
  assert.equal(hmacClipboard.length, 2)
  parseDeviceHmacSecret(hmacClipboard[0]).fill(0)
  assert.equal(hmacClipboard[1].length, 0)

  const failedWaitClipboard = []
  await assert.rejects(runGenerator({
    mode: 'device-token-hmac',
    input: { isTTY: true },
    output: { isTTY: true, write() {} },
    waitForClear: async () => { throw new Error('fixture wait failure') },
    writeClipboard: async (value) => failedWaitClipboard.push(Buffer.from(value)),
    randomBytes: (length) => deterministicBytes(length, 'failed-wait-hmac')
  }))
  assert.equal(failedWaitClipboard.length, 2)
  assert.equal(failedWaitClipboard[1].length, 0)

  const partialWriteClipboard = []
  const originalWriteError = Object.assign(new Error('original write failure'), {
    code: 'SSM_MATERIAL_CLIPBOARD_FAILED'
  })
  let partialWriteCalls = 0
  await assert.rejects(runGenerator({
    mode: 'device-token-hmac',
    input: { isTTY: true },
    output: { isTTY: true, write() {} },
    waitForClear: async () => assert.fail('failed write must not wait'),
    writeClipboard: async (value) => {
      partialWriteCalls += 1
      partialWriteClipboard.push(Buffer.from(value))
      if (partialWriteCalls === 1) throw originalWriteError
      throw new Error('cleanup failure must not replace original')
    },
    randomBytes: (length) => deterministicBytes(length, 'partial-write-hmac')
  }), (error) => error === originalWriteError)
  assert.equal(partialWriteClipboard.length, 2)
  assert.notEqual(partialWriteClipboard[0].length, 0)
  assert.equal(partialWriteClipboard[1].length, 0)

  const maliciousCode = 'SECRET_DEVICE_HMAC_V20260812_001'
  assert.equal(stableErrorCode(Object.assign(new Error('sensitive'), {
    code: maliciousCode
  })), 'SSM_MATERIAL_GENERATION_FAILED')
  assert.equal(stableErrorCode(Object.assign(new Error('known'), {
    code: 'ADMIN_PASSWORD_INVALID'
  })), 'ADMIN_PASSWORD_INVALID')

  function createAsyncChild() {
    /** @type {any} */
    const child = new EventEmitter()
    child.killCalls = []
    child.kill = (signal) => {
      child.killCalls.push(signal)
      return true
    }
    child.stdin = new EventEmitter()
    child.stdin.end = (payload, callback) => {
      child.payload = payload
      child.handoffCallback = callback
    }
    child.consumeAndClose = (code = 0) => {
      child.received = Buffer.from(child.payload)
      child.handoffCallback()
      child.emit('close', code)
    }
    return child
  }

  const asyncChild = createAsyncChild()
  const asyncSecret = Buffer.from('exact-async-secret')
  const asyncTimers = []
  const asyncPromise = writeMacClipboard(asyncSecret, {
    spawnImpl: () => asyncChild,
    platform: 'darwin',
    setTimer: (handler, timeoutMs) => {
      asyncTimers.push({ handler, timeoutMs })
      return asyncTimers.length
    },
    clearTimer() {}
  })
  assert.equal(asyncTimers[0].timeoutMs, 5000)
  assert.equal(asyncChild.payload.toString(), 'exact-async-secret')
  asyncChild.consumeAndClose()
  await asyncPromise
  assert.equal(asyncChild.received.toString(), 'exact-async-secret')
  assert.equal(asyncChild.payload.every((byte) => byte === 0), true)
  assert.equal(asyncSecret.toString(), 'exact-async-secret')

  function timerHarness() {
    const timers = []
    const cleared = []
    return {
      timers,
      cleared,
      setTimer(handler, timeoutMs) {
        timers.push({ handler, timeoutMs })
        return timers.length
      },
      clearTimer(timerId) {
        cleared.push(timerId)
      }
    }
  }

  const timeoutChild = createAsyncChild()
  const timeoutTimers = timerHarness()
  const timeoutPromise = writeMacClipboard(Buffer.from('timeout-secret'), {
    spawnImpl: () => timeoutChild,
    platform: 'darwin',
    setTimer: timeoutTimers.setTimer,
    clearTimer: timeoutTimers.clearTimer
  })
  let timeoutSettled = false
  timeoutPromise.catch(() => { timeoutSettled = true })
  assert.equal(timeoutTimers.timers[0].timeoutMs, 5000)
  timeoutTimers.timers[0].handler()
  await Promise.resolve()
  assert.deepEqual(timeoutChild.killCalls, ['SIGKILL'])
  assert.equal(timeoutSettled, false)
  assert.equal(timeoutTimers.timers[1].timeoutMs, 250)
  assert.equal(timeoutChild.payload.toString(), 'timeout-secret')
  timeoutChild.emit('close', null, 'SIGKILL')
  await assert.rejects(timeoutPromise, hasCode('SSM_MATERIAL_CLIPBOARD_FAILED'))
  assert.equal(timeoutChild.payload.every((byte) => byte === 0), true)
  assert.deepEqual(timeoutTimers.cleared.sort(), [1, 2])

  const stuckChild = createAsyncChild()
  const stuckTimers = timerHarness()
  const stuckPromise = writeMacClipboard(Buffer.from('stuck-secret'), {
    spawnImpl: () => stuckChild,
    platform: 'darwin',
    setTimer: stuckTimers.setTimer,
    clearTimer: stuckTimers.clearTimer
  })
  stuckTimers.timers[0].handler()
  assert.deepEqual(stuckChild.killCalls, ['SIGKILL'])
  stuckTimers.timers[1].handler()
  await assert.rejects(stuckPromise, hasCode('SSM_MATERIAL_CLIPBOARD_FAILED'))
  assert.equal(stuckChild.payload.every((byte) => byte === 0), true)

  for (const source of ['child', 'stdin']) {
    const errorChild = createAsyncChild()
    const errorTimers = timerHarness()
    const errorPromise = writeMacClipboard(Buffer.from(`${source}-error-secret`), {
      spawnImpl: () => errorChild,
      platform: 'darwin',
      setTimer: errorTimers.setTimer,
      clearTimer: errorTimers.clearTimer
    })
    if (source === 'child') errorChild.emit('error', new Error('fixture child error'))
    else errorChild.stdin.emit('error', new Error('fixture stdin error'))
    assert.deepEqual(errorChild.killCalls, ['SIGKILL'])
    errorChild.emit('close', null, 'SIGKILL')
    await assert.rejects(errorPromise, hasCode('SSM_MATERIAL_CLIPBOARD_FAILED'))
    assert.equal(errorChild.payload.every((byte) => byte === 0), true)
  }

  await assert.rejects(runGenerator({
    mode: 'admin-password-verifier',
    input: { isTTY: true },
    output: { isTTY: true, write() {} },
    promptHidden: async (prompt) => prompt.includes('again') ? 'different password value' : 'correct horse battery staple',
    waitForClear: async () => assert.fail('mismatch must not reach clipboard wait'),
    writeClipboard: async () => assert.fail('mismatch must not reach clipboard')
  }), hasCode('ADMIN_PASSWORD_MISMATCH'))

  await assert.rejects(runGenerator({
    mode: 'device-token-hmac',
    input: { isTTY: false },
    output: { isTTY: true, write() {} },
    waitForClear: async () => {},
    writeClipboard: async () => {}
  }), hasCode('SSM_MATERIAL_TTY_REQUIRED'))

  await assert.rejects(runGeneratorCli({
    argv: ['admin-password-verifier', 'must-not-be-a-password-argument'],
    input: { isTTY: true },
    output: { isTTY: true, write() {} },
    promptHidden: async () => assert.fail('invalid argv must fail before password prompt'),
    waitForClear: async () => {},
    writeClipboard: async () => {}
  }), hasCode('SSM_MATERIAL_CLI_USAGE_INVALID'))
}

module.exports = { run }

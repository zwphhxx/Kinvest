const assert = require('node:assert/strict')

function capture() {
  let value = ''
  return {
    stream: { write(chunk) { value += String(chunk) } },
    value: () => value
  }
}

async function run() {
  const { runPreflight } = require('../secret-preflight')
  const stdout = capture()
  const stderr = capture()
  let clearCount = 0
  assert.equal(await runPreflight({
    bootstrap: async () => ({
      status: Object.freeze({ mode: 'cvm-ssm', referenceCount: 3 }),
      clear() { clearCount += 1 }
    }),
    stdout: stdout.stream,
    stderr: stderr.stream
  }), 0)
  assert.equal(stdout.value(), 'KINVEST_SSM_PREFLIGHT_OK references=3\n')
  assert.equal(stderr.value(), '')
  assert.equal(clearCount, 1)

  const tmpfsOut = capture()
  const tmpfsErr = capture()
  let tmpfsClearCount = 0
  assert.equal(await runPreflight({
    bootstrap: async () => ({
      status: Object.freeze({ mode: 'github-tmpfs-v1', referenceCount: 2 }),
      clear() { tmpfsClearCount += 1 }
    }),
    stdout: tmpfsOut.stream,
    stderr: tmpfsErr.stream
  }), 0)
  assert.equal(tmpfsOut.value(), 'KINVEST_SECRET_PREFLIGHT_OK mode=github-tmpfs-v1 references=2\n')
  assert.equal(tmpfsErr.value(), '')
  assert.equal(tmpfsClearCount, 1)

  const failedOut = capture()
  const failedErr = capture()
  const secretMarker = 'fixture-secret-must-not-leak'
  assert.equal(await runPreflight({
    bootstrap: async () => {
      throw Object.assign(new Error(secretMarker), {
        code: 'SSM_SECRET_LOAD_FAILED'
      })
    },
    stdout: failedOut.stream,
    stderr: failedErr.stream
  }), 1)
  assert.equal(failedOut.value(), '')
  assert.equal(failedErr.value(), 'SSM_SECRET_LOAD_FAILED\n')
  assert.equal(failedErr.value().includes(secretMarker), false)

  const allowlistOut = capture()
  const allowlistErr = capture()
  const upstreamCode = 'DEVICE_TOKEN_HMAC_V20260812_001'
  assert.equal(await runPreflight({
    bootstrap: async () => {
      throw Object.assign(new Error('sensitive upstream failure'), {
        code: upstreamCode
      })
    },
    stdout: allowlistOut.stream,
    stderr: allowlistErr.stream
  }), 1)
  assert.equal(allowlistOut.value(), '')
  assert.equal(allowlistErr.value(), 'SSM_PREFLIGHT_FAILED\n')
  assert.equal(allowlistErr.value().includes(upstreamCode), false)

  const disabledOut = capture()
  const disabledErr = capture()
  let disabledClearCount = 0
  let disabledBootstrapCount = 0
  assert.equal(await runPreflight({
    bootstrap: async () => {
      disabledBootstrapCount += 1
      return {
        status: Object.freeze({ mode: 'disabled', referenceCount: 0 }),
        clear() { disabledClearCount += 1 }
      }
    },
    stdout: disabledOut.stream,
    stderr: disabledErr.stream
  }), 0)
  assert.equal(disabledOut.value(), 'KINVEST_SECRET_PREFLIGHT_OK mode=disabled references=0\n')
  assert.equal(disabledErr.value(), '')
  assert.equal(disabledBootstrapCount, 1)
  assert.equal(disabledClearCount, 1)

  for (const invalidStatus of [
    { mode: 'disabled', referenceCount: 1 },
    { mode: 'disabled', referenceCount: '0' },
    { mode: 'github-tmpfs-v1', referenceCount: 1 },
    { mode: 'github-tmpfs-v1', referenceCount: 3 },
    { mode: 'cvm-ssm', referenceCount: 1 },
    { mode: 'cvm-ssm', referenceCount: 12 },
    { mode: 'cvm-ssm', referenceCount: 2.5 },
    { mode: 'unknown', referenceCount: 0 },
    null
  ]) {
    const invalidOut = capture()
    const invalidErr = capture()
    assert.equal(await runPreflight({
      bootstrap: async () => ({ status: invalidStatus, clear() {} }),
      stdout: invalidOut.stream,
      stderr: invalidErr.stream
    }), 1)
    assert.equal(invalidOut.value(), '')
    assert.equal(invalidErr.value(), 'SSM_PREFLIGHT_REQUIRES_CVM_SSM\n')
  }

  for (const referenceCount of [2, 11]) {
    const compatibleOut = capture()
    const compatibleErr = capture()
    assert.equal(await runPreflight({
      bootstrap: async () => ({
        status: { mode: 'cvm-ssm', referenceCount },
        clear() {}
      }),
      stdout: compatibleOut.stream,
      stderr: compatibleErr.stream
    }), 0)
    assert.equal(compatibleOut.value(), `KINVEST_SSM_PREFLIGHT_OK references=${referenceCount}\n`)
    assert.equal(compatibleErr.value(), '')
  }
}

module.exports = { run }

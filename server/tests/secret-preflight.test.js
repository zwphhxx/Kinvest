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

  const failedOut = capture()
  const failedErr = capture()
  const secretMarker = 'fixture-secret-must-not-leak'
  assert.equal(await runPreflight({
    bootstrap: async () => {
      const error = new Error(secretMarker)
      error.code = 'SSM_SECRET_LOAD_FAILED'
      throw error
    },
    stdout: failedOut.stream,
    stderr: failedErr.stream
  }), 1)
  assert.equal(failedOut.value(), '')
  assert.equal(failedErr.value(), 'SSM_SECRET_LOAD_FAILED\n')
  assert.equal(failedErr.value().includes(secretMarker), false)

  const disabledOut = capture()
  const disabledErr = capture()
  let disabledClearCount = 0
  assert.equal(await runPreflight({
    bootstrap: async () => ({
      status: Object.freeze({ mode: 'disabled', referenceCount: 0 }),
      clear() { disabledClearCount += 1 }
    }),
    stdout: disabledOut.stream,
    stderr: disabledErr.stream
  }), 1)
  assert.equal(disabledOut.value(), '')
  assert.equal(disabledErr.value(), 'SSM_PREFLIGHT_REQUIRES_CVM_SSM\n')
  assert.equal(disabledClearCount, 1)
}

module.exports = { run }

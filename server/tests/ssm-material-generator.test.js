const assert = require('node:assert/strict')
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
    runGeneratorCli
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
